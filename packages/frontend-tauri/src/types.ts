// TS mirror of the Rust `DaemonPhase` enum + `DaemonStateEvent` envelope
// emitted on the `daemon-state` Tauri event channel.
//
// Source of truth: packages/frontend-tauri/src-tauri/src/daemon_state.rs
//
// Wire shape: the Rust enum uses
//   #[serde(tag = "phase", rename_all = "camelCase")]
// so the discriminator field is `phase` and variant names are camelCase
// (`notSpawned`, `spawnFailed`, `awaitingAuth`, ...).
//
// The `DaemonStateEvent` envelope flattens the variant payload alongside
// `generation`, so a `Ready` event arrives on the wire as:
//   { generation: 7, phase: "ready", port: 9876, token: "...",
//     identity: ..., tunnel: "pending" | "connected" | "disconnected" }
// and a `SpawnFailed` event as:
//   { generation: 3, phase: "spawnFailed", reason: "...", retryInMs: 1000 }
//
// Field names within payloads are also camelCase (`retryInMs`, `verificationUri`,
// `userCode`, `expiresAt`, `userId`, `tunnel`).
//
// R-50 (Task #164): tunnel state is now a sub-state of `Ready`. The previous
// top-level `tunnelConnected` / `tunnelDisconnected` variants were removed
// because they were causing a stderr-vs-handshake race to overwrite Ready
// (freezing the SPA on the "Tunnel connected, waiting…" overlay). Tunnel
// up/down is orthogonal to local PTY/HTTP readiness, so it lives inside
// Ready as `tunnel: TunnelState`.

export interface Identity {
  userId: string;
}

/**
 * Cloud tunnel sub-state inside `phase=ready`. Mirrors the Rust
 * `TunnelState` enum (camelCase serde).
 */
export type TunnelState = 'pending' | 'connected' | 'disconnected';

export type DaemonPhase =
  | { phase: 'notSpawned' }
  | { phase: 'spawning' }
  | { phase: 'spawnFailed'; reason: string; retryInMs: number | null }
  | { phase: 'starting' }
  | {
      phase: 'awaitingAuth';
      verificationUri: string;
      userCode: string;
      expiresAt: number;
    }
  | { phase: 'authFailed'; reason: string }
  | {
      phase: 'ready';
      port: number;
      token: string;
      identity: Identity | null;
      tunnel: TunnelState;
    }
  | { phase: 'exited'; code: number | null; reason: string };

/**
 * Wire envelope for the `daemon-state` Tauri event. The Rust side flattens
 * the `DaemonPhase` payload into the same JSON object alongside `generation`,
 * so `DaemonStatePayload` is `{ generation } & DaemonPhase`.
 */
export type DaemonStatePayload = { generation: number } & DaemonPhase;
