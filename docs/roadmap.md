# CCSM roadmap

A pointer document tracking the major design slices and their current state. The implementation plans live under `docs/superpowers/plans/`; the design specs live under `docs/superpowers/specs/`.

## v0.2 — MVP (shipped 2026-04-30)

Single-process Electron app with embedded PTY supervision, claude-agent-sdk consumption, and SQLite persistence. See `docs/superpowers/specs/mvp-design.md` for the original design.

## v0.3 daemon split (in design)

Refactor only — no added or removed features. Splits the long-running side (PTY, SDK, persistence) into a standalone daemon process, with the Electron app as the client over local IPC.

- **Design**: [`docs/superpowers/specs/v0.3-design.md`](./superpowers/specs/v0.3-design.md) (combined from 12 review-converged fragments under `v0.3-fragments/`).
- **Exec summary**: [`docs/superpowers/specs/v0.3-daemon-split.md`](./superpowers/specs/v0.3-daemon-split.md).
- **Implementation plan**: [`docs/superpowers/plans/2026-04-30-v0.3-daemon-split.md`](./superpowers/plans/2026-04-30-v0.3-daemon-split.md).
- **Status**: design converged at r12 (0 P0 across 7 review angles, 7 review rounds completed). Ready for plan-delta reconciliation (#941) and dispatch.

## v0.4 — Connect+Protobuf swap (planned)

Replaces v0.3's hand-written length-prefixed JSON envelope with native Connect over HTTP/2 and Protobuf. Frame-version nibble and `daemonAcceptedWires[]` already chosen so v0.4 daemon can serve both v0.3 and v0.4 clients during the rolling-upgrade window. Detailed design TBD.

## v0.5 — Web client over Cloudflare Tunnel (planned)

Browser client over `cf-tunnel` consuming the same Connect+Protobuf wire as the desktop client. CF Access JWT verification slots into the v0.3 interceptor pipeline as a single appended interceptor; per-stream auth tokens slot into the §3.5.1.4 subscribe RPC param shape (already reserved). Detailed design TBD.
