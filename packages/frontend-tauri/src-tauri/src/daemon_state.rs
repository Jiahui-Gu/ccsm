// T1 (Task #115): unified daemon-state event channel + DaemonPhase enum.
//
// Replaces the scattered legacy events (`daemon-ready` / `daemon-error` /
// `daemon-exit` / `daemon-stderr`) with a single typed `daemon-state` channel
// while keeping legacy events emitted for backwards compatibility (see
// daemon_mgr.rs — every legacy emit is paired with a `state.set_and_emit(...)`).
//
// R-50 (Task #164): tunnel state is no longer a top-level phase. It is now a
// sub-state of `Ready`, because tunnel up/down is orthogonal to whether the
// local PTY+HTTP daemon is serving the webview. The previous design — top-level
// `TunnelConnected` / `TunnelDisconnected` variants — caused a regression where
// a stderr-driven `TunnelConnected` emit, racing the inline handshake `Ready`
// emit, would *overwrite* `Ready` and freeze the SPA on the "Tunnel connected,
// waiting…" overlay. Reproducer evidence captured in /tmp/tauri-prod.log:
//   1. handshake ok            → set Ready
//   2. stderr "tunnel: connected" → set TunnelConnected (clobbers Ready)
//
// New design:
//   * `TunnelState { Pending | Connected | Disconnected }` lives inside `Ready`.
//   * Handshake transitions to `Ready { tunnel: Pending }` (or to whatever the
//     stderr observer has already stashed — see `pending_tunnel` below).
//   * The stderr observer calls `set_tunnel_state(...)`, which mutates the
//     `tunnel` field in place when the current phase is `Ready` and re-emits.
//     If the observer fires before the handshake (e.g. tunnel client connects
//     before stdout handshake parse completes), the new state is *stashed* so
//     the next Ready transition picks it up — no Ready overwrite, no lost
//     update.
//
// This is the "fix at architecture layer" remedy (memory:
// feedback_fix_arch_not_glue) for the phase-semantics confusion. Adding an
// "if phase < new_phase" guard inside `set_and_emit` was rejected as a hack.
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

/// Cloud tunnel sub-state, scoped to the `Ready` phase. The local daemon is
/// already serving HTTP/PTY (that is what `Ready` means); the tunnel layer is
/// orthogonal and may flap independently without disturbing the local UI.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TunnelState {
    /// Default sub-state at handshake time — tunnel has not reported up yet.
    Pending,
    /// stderr observed `[ccsm] tunnel: connected`.
    Connected,
    /// stderr observed `[ccsm] tunnel: disconnected`.
    Disconnected,
}

impl Default for TunnelState {
    fn default() -> Self {
        TunnelState::Pending
    }
}

/// Single source of truth for daemon lifecycle. Tagged enum so the SPA can
/// pattern-match on `phase` after JSON deserialize.
///
/// R-50 (Task #164): top-level `TunnelConnected` / `TunnelDisconnected`
/// variants were removed. Tunnel state moved into `Ready { tunnel }`.
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
    Ready {
        port: u16,
        token: String,
        identity: Option<Identity>,
        /// Sub-state of the cloud tunnel client. Defaults to `Pending`. Updated
        /// by `DaemonStateStore::set_tunnel_state` when the daemon stderr
        /// observer sees `[ccsm] tunnel: connected` / `disconnected`.
        tunnel: TunnelState,
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
///
/// R-50 (Task #164): also tracks a `pending_tunnel` slot. The daemon stderr
/// observer can race the inline handshake — if it sees `tunnel: connected`
/// before handshake commits Ready, we stash the tunnel state here and apply
/// it on the next Ready transition (see `set_and_emit` Ready branch). Without
/// the stash the early stderr signal would be lost (it cannot legally promote
/// us out of `Starting` because we don't have a port/token yet).
pub struct DaemonStateStore {
    inner: Mutex<DaemonPhase>,
    /// `Some(state)` if the stderr observer reported a tunnel transition while
    /// the phase was not yet `Ready`. Consumed by the next Ready transition.
    /// Reset to `None` after consumption.
    pending_tunnel: Mutex<Option<TunnelState>>,
    generation: AtomicU64,
}

impl Default for DaemonStateStore {
    fn default() -> Self {
        Self {
            inner: Mutex::new(DaemonPhase::NotSpawned),
            pending_tunnel: Mutex::new(None),
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
    ///
    /// R-50 (Task #164): when transitioning to `Ready`, fold any stashed
    /// `pending_tunnel` into the new phase's `tunnel` sub-state. This is how
    /// we recover the "stderr saw tunnel: connected before handshake parsed"
    /// race — the early signal is preserved instead of being dropped on the
    /// floor (and the late signal can no longer overwrite Ready).
    pub fn set_and_emit(&self, app: &AppHandle, phase: DaemonPhase) {
        let phase = self.fold_pending_tunnel(phase);
        {
            let mut guard = self.inner.lock().expect("daemon state mutex poisoned");
            *guard = phase.clone();
        }
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        // R-50 (Task #164): observability for the phase-vs-tunnel race. One
        // line per transition is cheap and lets us replay the exact emit
        // sequence from the daemon-mgr log when triaging future regressions
        // in this area.
        eprintln!(
            "[daemon-state] set_and_emit gen={generation} phase={}",
            serde_json::to_string(&phase).unwrap_or_else(|_| "<unserializable>".into()),
        );
        let event = DaemonStateEvent { generation, phase };
        let _ = app.emit("daemon-state", event);
    }

    /// R-50 (Task #164): update the tunnel sub-state from the daemon stderr
    /// observer. If the current phase is `Ready`, the tunnel field is mutated
    /// in place and a fresh `daemon-state` event is emitted (with bumped
    /// generation). If the current phase is anything else (e.g. `Starting`,
    /// pre-handshake), the new tunnel state is stashed in `pending_tunnel`
    /// and applied on the next Ready transition.
    ///
    /// Crucially, this method NEVER promotes the phase out of a non-Ready
    /// state — that was the whole bug. Tunnel up/down is orthogonal to local
    /// daemon readiness.
    pub fn set_tunnel_state(&self, app: &AppHandle, tunnel: TunnelState) {
        let next_phase = {
            let mut guard = self.inner.lock().expect("daemon state mutex poisoned");
            match &mut *guard {
                DaemonPhase::Ready { tunnel: cur, .. } => {
                    *cur = tunnel;
                    Some(guard.clone())
                }
                _ => {
                    // Stash for the next Ready transition; do NOT change
                    // current phase, do NOT emit.
                    *self
                        .pending_tunnel
                        .lock()
                        .expect("pending_tunnel mutex poisoned") = Some(tunnel);
                    None
                }
            }
        };
        if let Some(phase) = next_phase {
            let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
            eprintln!(
                "[daemon-state] set_tunnel_state gen={generation} tunnel={:?} phase={}",
                tunnel,
                serde_json::to_string(&phase).unwrap_or_else(|_| "<unserializable>".into()),
            );
            let event = DaemonStateEvent { generation, phase };
            let _ = app.emit("daemon-state", event);
        } else {
            eprintln!(
                "[daemon-state] set_tunnel_state stashed tunnel={tunnel:?} (phase != Ready)",
            );
        }
    }

    /// Internal: if `phase` is a Ready transition and a tunnel state is
    /// stashed, fold the stash into `phase.tunnel` and clear the stash.
    /// Returns the (possibly modified) phase. No-op for non-Ready phases.
    ///
    /// Visible for unit tests so we can exercise the fold without an
    /// `AppHandle` (which requires a Tauri runtime to construct).
    fn fold_pending_tunnel(&self, mut phase: DaemonPhase) -> DaemonPhase {
        if let DaemonPhase::Ready { tunnel, .. } = &mut phase {
            let mut stash = self
                .pending_tunnel
                .lock()
                .expect("pending_tunnel mutex poisoned");
            if let Some(stashed) = stash.take() {
                *tunnel = stashed;
            }
        } else {
            // Leaving Ready (or never entered). Drop any stash so a stale
            // tunnel signal from a prior cycle cannot bleed into a new Ready
            // after a respawn. The supervisor calls set_and_emit(Spawning)
            // at the top of every cycle, which lands here.
            *self
                .pending_tunnel
                .lock()
                .expect("pending_tunnel mutex poisoned") = None;
        }
        phase
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
    ///
    /// Mirrors `set_and_emit`'s pending-tunnel fold so the race regression
    /// tests can exercise the same merge logic without an `AppHandle`.
    #[cfg(test)]
    fn set_no_emit(&self, phase: DaemonPhase) -> u64 {
        let phase = self.fold_pending_tunnel(phase);
        {
            let mut guard = self.inner.lock().unwrap();
            *guard = phase;
        }
        self.generation.fetch_add(1, Ordering::SeqCst) + 1
    }

    /// Test-only: counterpart to `set_tunnel_state` that does not emit. Returns
    /// the new generation if the call mutated `Ready`, or `None` if the call
    /// stashed the tunnel state because the phase was not `Ready`.
    #[cfg(test)]
    fn set_tunnel_state_no_emit(&self, tunnel: TunnelState) -> Option<u64> {
        let mutated = {
            let mut guard = self.inner.lock().unwrap();
            match &mut *guard {
                DaemonPhase::Ready { tunnel: cur, .. } => {
                    *cur = tunnel;
                    true
                }
                _ => {
                    *self.pending_tunnel.lock().unwrap() = Some(tunnel);
                    false
                }
            }
        };
        if mutated {
            Some(self.generation.fetch_add(1, Ordering::SeqCst) + 1)
        } else {
            None
        }
    }
}

/// Compute the next supervisor backoff delay (ms) given the current one.
///
/// T2 (#119): exponential backoff for the daemon supervisor loop. Doubles
/// the previous delay, clamps to [1000ms, 10_000ms]. The supervisor resets
/// `cur` back to 1000ms after a healthy run (≥10s up) — this fn just owns
/// the doubling step.
///
/// Sequence from 1000ms: 1000 → 2000 → 4000 → 8000 → 10000 → 10000 (clamped).
pub fn next_backoff(cur_ms: u64) -> u64 {
    const MIN_MS: u64 = 1_000;
    const MAX_MS: u64 = 10_000;
    if cur_ms < MIN_MS {
        return MIN_MS;
    }
    cur_ms.saturating_mul(2).min(MAX_MS)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn next_backoff_doubles_and_caps() {
        // T2 spec: 1000 → 2000 → 4000 → 8000 → 10000 → 10000.
        assert_eq!(next_backoff(1_000), 2_000);
        assert_eq!(next_backoff(2_000), 4_000);
        assert_eq!(next_backoff(4_000), 8_000);
        assert_eq!(next_backoff(8_000), 10_000);
        assert_eq!(next_backoff(10_000), 10_000);
        // Below floor (e.g. caller passed 0 first time) snaps to MIN.
        assert_eq!(next_backoff(0), 1_000);
        assert_eq!(next_backoff(500), 1_000);
        // Saturation guard against overflow.
        assert_eq!(next_backoff(u64::MAX), 10_000);
    }

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
            DaemonPhase::Ready {
                port: 9876,
                token: "tok".into(),
                identity: Some(Identity {
                    user_id: "u1".into(),
                }),
                tunnel: TunnelState::Pending,
            },
            DaemonPhase::Ready {
                port: 9876,
                token: "tok".into(),
                identity: None,
                tunnel: TunnelState::Connected,
            },
            DaemonPhase::Ready {
                port: 9876,
                token: "tok".into(),
                identity: None,
                tunnel: TunnelState::Disconnected,
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

    // ---------------------------------------------------------------------
    // R-50 (Task #164): tunnel-as-sub-state race regression tests.
    //
    // The original bug (see header): handshake sets Ready, stderr async sees
    // "tunnel: connected" and overwrites Ready with the (now-deleted) top-
    // level TunnelConnected variant. The SPA freezes on the
    // "Tunnel connected, waiting…" overlay because phase != ready.
    //
    // These tests exercise the merge invariants on the state store directly:
    //   1. happy path: handshake-then-tunnel    => Ready{tunnel=Connected}
    //   2. race path:  tunnel-then-handshake    => Ready{tunnel=Connected}
    //   3. orthogonality: tunnel updates while Ready never demote phase
    //   4. cycle reset: Spawning drops a stale stash from a prior Ready
    // ---------------------------------------------------------------------

    fn ready_pending() -> DaemonPhase {
        DaemonPhase::Ready {
            port: 9876,
            token: "tok".into(),
            identity: None,
            tunnel: TunnelState::Pending,
        }
    }

    fn extract_tunnel(phase: &DaemonPhase) -> Option<TunnelState> {
        match phase {
            DaemonPhase::Ready { tunnel, .. } => Some(*tunnel),
            _ => None,
        }
    }

    #[test]
    fn ready_then_tunnel_connected_keeps_ready_with_connected_substate() {
        // Real-world ordering #1: handshake commits Ready first, then the
        // stderr observer sees "tunnel: connected".
        let store = DaemonStateStore::default();
        store.set_no_emit(ready_pending());
        assert!(matches!(store.snapshot(), DaemonPhase::Ready { .. }));
        assert_eq!(extract_tunnel(&store.snapshot()), Some(TunnelState::Pending));

        let g = store.set_tunnel_state_no_emit(TunnelState::Connected);
        assert!(g.is_some(), "Ready -> tunnel update must emit");

        let snap = store.snapshot();
        match snap {
            DaemonPhase::Ready { tunnel, .. } => assert_eq!(tunnel, TunnelState::Connected),
            other => panic!("expected Ready, got {other:?}"),
        }
    }

    #[test]
    fn tunnel_connected_then_ready_preserves_tunnel_via_stash() {
        // Real-world ordering #2 (the race): stderr observer fires before
        // handshake commits Ready (stderr task spawned BEFORE inline read in
        // daemon_mgr.rs). The pre-Ready signal must be stashed and folded
        // into the next Ready so we don't lose it.
        let store = DaemonStateStore::default();
        // Pre-handshake phase:
        store.set_no_emit(DaemonPhase::Starting);

        // stderr fires first — must NOT promote phase, must NOT clobber.
        let g_stash = store.set_tunnel_state_no_emit(TunnelState::Connected);
        assert!(g_stash.is_none(), "pre-Ready tunnel update must not emit");
        // Phase still Starting:
        assert!(matches!(store.snapshot(), DaemonPhase::Starting));

        // Now handshake commits Ready{Pending} — fold should swap in Connected.
        store.set_no_emit(ready_pending());
        match store.snapshot() {
            DaemonPhase::Ready { tunnel, .. } => assert_eq!(tunnel, TunnelState::Connected),
            other => panic!("expected Ready{{Connected}}, got {other:?}"),
        }
    }

    #[test]
    fn tunnel_disconnect_while_ready_does_not_demote_phase() {
        // Tunnel flap must never bounce the user back to a "no-app" overlay.
        // Before R-50 a top-level TunnelDisconnected variant existed and the
        // SPA routed it to a non-Ready overlay. Now disconnect is a sub-state
        // of Ready and the SPA stays mounted.
        let store = DaemonStateStore::default();
        store.set_no_emit(ready_pending());
        store.set_tunnel_state_no_emit(TunnelState::Connected);
        store.set_tunnel_state_no_emit(TunnelState::Disconnected);
        match store.snapshot() {
            DaemonPhase::Ready { tunnel, .. } => assert_eq!(tunnel, TunnelState::Disconnected),
            other => panic!("expected Ready (still), got {other:?}"),
        }
    }

    #[test]
    fn cycle_restart_drops_stale_pending_tunnel_stash() {
        // Supervisor restarts the daemon: it calls set_and_emit(Spawning) at
        // the top of every cycle. A stale tunnel signal stashed from a prior
        // cycle must NOT survive into the new Ready (port/token differ).
        let store = DaemonStateStore::default();
        store.set_no_emit(DaemonPhase::Starting);
        store.set_tunnel_state_no_emit(TunnelState::Connected); // stashed
        // Cycle restart:
        store.set_no_emit(DaemonPhase::Spawning);
        store.set_no_emit(DaemonPhase::Starting);
        store.set_no_emit(ready_pending());
        match store.snapshot() {
            DaemonPhase::Ready { tunnel, .. } => assert_eq!(
                tunnel,
                TunnelState::Pending,
                "stale tunnel stash must be dropped on cycle restart"
            ),
            other => panic!("expected Ready{{Pending}}, got {other:?}"),
        }
    }

    #[test]
    fn ready_serializes_tunnel_substate_camel_case() {
        // SPA contract: tunnel field is camelCase ("pending"/"connected"/
        // "disconnected"). Anchored test so a serde rename slip breaks loud.
        let phase = DaemonPhase::Ready {
            port: 9876,
            token: "tok".into(),
            identity: None,
            tunnel: TunnelState::Connected,
        };
        let json = serde_json::to_string(&phase).unwrap();
        assert!(json.contains("\"phase\":\"ready\""), "json={json}");
        assert!(json.contains("\"tunnel\":\"connected\""), "json={json}");
    }
}
