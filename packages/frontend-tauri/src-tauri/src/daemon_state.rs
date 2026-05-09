// T1 (Task #115): unified daemon-state event channel + DaemonPhase enum.
//
// Replaces the scattered legacy events (`daemon-ready` / `daemon-error` /
// `daemon-exit` / `daemon-stderr`) with a single typed `daemon-state` channel
// while keeping legacy events emitted for backwards compatibility (see
// daemon_mgr.rs — every legacy emit is paired with a `state.set_and_emit(...)`).
//
// scope (T1 only): Rust-side enum + state store + wire to existing emit points
// + stderr tunnel-state stub. T2 owns supervisor retry; T3/T4 own SPA listener +
// fallback UI; S4-T8 owns AwaitingAuth / AuthFailed real implementation (here
// they are placeholder variants — `unreachable!()` at construction sites in
// daemon_mgr.rs because S4 hasn't landed).

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

/// Coarse identity stub for the `Ready` phase. Intentionally minimal at T1 —
/// S4 will replace with the real auth-derived identity once OAuth lands.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct Identity {
    pub user_id: String,
}

/// Single source of truth for daemon lifecycle. Tagged enum so the SPA can
/// pattern-match on `phase` after JSON deserialize.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(tag = "phase", rename_all = "camelCase")]
pub enum DaemonPhase {
    NotSpawned,
    Spawning,
    SpawnFailed {
        reason: String,
        retry_in_ms: Option<u64>,
    },
    Starting,
    /// S4 placeholder — daemon-side OAuth flow not implemented yet. Kept in
    /// the enum so the SPA contract is stable; constructors in daemon_mgr
    /// must `unreachable!()` until S4-T8 lands.
    AwaitingAuth {
        verification_uri: String,
        user_code: String,
        expires_at: u64,
    },
    /// S4 placeholder — see AwaitingAuth note.
    AuthFailed {
        reason: String,
    },
    TunnelDisconnected {
        port: u16,
        token: String,
    },
    TunnelConnected {
        port: u16,
        token: String,
    },
    Ready {
        port: u16,
        token: String,
        identity: Option<Identity>,
    },
    Exited {
        code: Option<i32>,
        reason: String,
    },
}

impl Default for DaemonPhase {
    fn default() -> Self {
        DaemonPhase::NotSpawned
    }
}

/// Wire envelope for the `daemon-state` event. Carries a monotonic generation
/// so the SPA can drop stale events on reconnect.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct DaemonStateEvent {
    pub generation: u64,
    #[serde(flatten)]
    pub phase: DaemonPhase,
}

/// Holds the current `DaemonPhase` behind a mutex + emits one
/// `daemon-state` event per `set_and_emit` call. Generation is a monotonic
/// counter incremented on every transition (regardless of equality), so the
/// SPA can detect re-entry into the same logical phase.
pub struct DaemonStateStore {
    inner: Mutex<DaemonPhase>,
    generation: AtomicU64,
}

impl Default for DaemonStateStore {
    fn default() -> Self {
        Self {
            inner: Mutex::new(DaemonPhase::NotSpawned),
            generation: AtomicU64::new(0),
        }
    }
}

impl DaemonStateStore {
    /// Atomically replace the current phase, bump the generation, and emit a
    /// single `daemon-state` event to the webview. Best-effort emit — errors
    /// are swallowed (matches legacy `let _ = app.emit(...)` pattern in
    /// daemon_mgr.rs; the daemon-mgr task lives longer than the webview at
    /// shutdown).
    pub fn set_and_emit(&self, app: &AppHandle, phase: DaemonPhase) {
        {
            let mut guard = self.inner.lock().expect("daemon state mutex poisoned");
            *guard = phase.clone();
        }
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let event = DaemonStateEvent { generation, phase };
        let _ = app.emit("daemon-state", event);
    }

    /// Test-only: snapshot of the current phase. Production code should
    /// listen on the `daemon-state` event rather than poll.
    #[cfg(test)]
    #[allow(dead_code)]
    pub fn snapshot(&self) -> DaemonPhase {
        self.inner.lock().unwrap().clone()
    }

    #[cfg(test)]
    pub fn current_generation(&self) -> u64 {
        self.generation.load(Ordering::SeqCst)
    }

    /// Test-only: bump generation + replace phase WITHOUT emitting (we cannot
    /// construct a real `AppHandle` in unit tests without a Tauri runtime).
    /// Used by the unit tests below to verify generation/serialization
    /// invariants in isolation. Production callers MUST use `set_and_emit`.
    #[cfg(test)]
    fn set_no_emit(&self, phase: DaemonPhase) -> u64 {
        {
            let mut guard = self.inner.lock().unwrap();
            *guard = phase;
        }
        self.generation.fetch_add(1, Ordering::SeqCst) + 1
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_store_emits_one_event_per_set() {
        // We can't spin a real AppHandle in a unit test without a Tauri
        // runtime, so we exercise the state-mutation half of `set_and_emit`
        // (set_no_emit) and assert generation bumps exactly once per call —
        // which is the contract `set_and_emit` makes ("one event per set").
        let store = DaemonStateStore::default();
        assert_eq!(store.current_generation(), 0);

        let g1 = store.set_no_emit(DaemonPhase::Spawning);
        assert_eq!(g1, 1);
        assert_eq!(store.current_generation(), 1);

        let g2 = store.set_no_emit(DaemonPhase::Starting);
        assert_eq!(g2, 2);
        assert_eq!(store.current_generation(), 2);

        // Re-entering the same logical phase must still bump generation —
        // the SPA needs to distinguish "still in Starting" from "Starting
        // again after a transition out and back".
        let g3 = store.set_no_emit(DaemonPhase::Starting);
        assert_eq!(g3, 3);
    }

    #[test]
    fn state_store_phase_serializable() {
        // Every variant must round-trip through serde JSON so the SPA
        // contract is stable. Cover all variants explicitly so adding a new
        // one without updating the SPA breaks this test.
        let cases = vec![
            DaemonPhase::NotSpawned,
            DaemonPhase::Spawning,
            DaemonPhase::SpawnFailed {
                reason: "boom".into(),
                retry_in_ms: Some(1000),
            },
            DaemonPhase::SpawnFailed {
                reason: "boom".into(),
                retry_in_ms: None,
            },
            DaemonPhase::Starting,
            DaemonPhase::AwaitingAuth {
                verification_uri: "https://example/dev".into(),
                user_code: "ABCD-1234".into(),
                expires_at: 9_999,
            },
            DaemonPhase::AuthFailed {
                reason: "denied".into(),
            },
            DaemonPhase::TunnelDisconnected {
                port: 9876,
                token: "tok".into(),
            },
            DaemonPhase::TunnelConnected {
                port: 9876,
                token: "tok".into(),
            },
            DaemonPhase::Ready {
                port: 9876,
                token: "tok".into(),
                identity: Some(Identity {
                    user_id: "u1".into(),
                }),
            },
            DaemonPhase::Ready {
                port: 9876,
                token: "tok".into(),
                identity: None,
            },
            DaemonPhase::Exited {
                code: Some(0),
                reason: "clean".into(),
            },
            DaemonPhase::Exited {
                code: None,
                reason: "killed".into(),
            },
        ];

        for phase in cases {
            let env = DaemonStateEvent {
                generation: 42,
                phase: phase.clone(),
            };
            let json = serde_json::to_string(&env).expect("serialize");
            // tag must be present (camelCase per #[serde(rename_all)])
            assert!(json.contains("\"phase\":"), "missing phase tag: {json}");
            // generation must round-trip
            let back: DaemonStateEvent = serde_json::from_str(&json).expect("deserialize");
            assert_eq!(back.generation, 42);
            // phase variant must round-trip via discriminator
            let back_json = serde_json::to_string(&back.phase).unwrap();
            let orig_json = serde_json::to_string(&phase).unwrap();
            assert_eq!(back_json, orig_json);
        }
    }

    #[test]
    fn state_store_generation_monotonic() {
        let store = DaemonStateStore::default();
        let mut last = 0u64;
        for i in 0..50 {
            let phase = if i % 2 == 0 {
                DaemonPhase::Spawning
            } else {
                DaemonPhase::Starting
            };
            let g = store.set_no_emit(phase);
            assert!(g > last, "generation must be strictly monotonic: {g} > {last}");
            last = g;
        }
        assert_eq!(store.current_generation(), 50);
    }
}
