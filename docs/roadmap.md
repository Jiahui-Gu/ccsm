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

## v0.4 — three-client architecture (frozen 2026-05-02)

Backend stays a single binary on the user's local machine. Three first-class clients (desktop, web, iOS) speak the same Connect-RPC surface generated from `proto/`. Two loopback listeners: peer-cred bypass for desktop on the same machine; `cloudflared`-only listener with Cloudflare Access JWT validation for web + iOS via Cloudflare edge.

- **Architecture baseline**: [`docs/superpowers/specs/2026-05-02-final-architecture.md`](./superpowers/specs/2026-05-02-final-architecture.md). All v0.4 sub-specs (transport, ops/cloudflared, security/auth, client UX) hang off this baseline.
