# Mobile Remote — Cloudflare Relay

**Date:** 2026-07-20  
**Status:** Design approved in conversation; awaiting written-spec review  
**Scope:** One user, one CCSM desktop, and one phone browser controlling CCSM
terminal sessions over the public internet.

## Problem

CCSM already has a tested loopback HTTP/WebSocket mobile terminal:

- `electron/remote/mobileRemoteServer.ts` serves the phone page and WebSocket.
- `electron/remote/remoteMessages.ts` handles session listing, snapshots, PTY
  input, and terminal resize.
- `electron/remote/wsProtocol.ts` provides framing and heartbeat handling.
- `electron/remote/mobilePage.ts` provides a mobile xterm client with reconnect,
  snapshot recovery, sequence deduplication, and touch-friendly keys.

The server binds to `127.0.0.1` and is enabled only through environment
variables. A phone on another network cannot reach it. The renderer also has no
settings or status UI for the feature.

The project previously implemented a public WebRTC path. Commit `2422f102`
reverted it because the `werift` dependency pulled in a package layout that
electron-builder pruned. The packaged application then crashed before the first
window appeared. This design avoids WebRTC and native/runtime transport
dependencies, and loads the remote controller only after the app is ready.

## Goals

1. Let a phone on any network control the active CCSM terminal sessions.
2. Require no public IP, port forwarding, domain, VPN, or Tailscale.
3. Use Cloudflare's free Workers and Durable Objects tiers.
4. Give the installed-app user a zero-configuration flow: open CCSM, show a QR
   code, scan it, and connect.
5. Keep terminal content end-to-end encrypted between desktop and phone.
6. Preserve the existing terminal protocol and snapshot-plus-sequence recovery.
7. Ensure remote-control failures can never prevent the CCSM window from
   opening.

## Non-goals

- Controlling the full CCSM UI or the operating-system desktop.
- Multiple desktop computers, multiple users, or an account-management system.
- WebRTC, STUN, TURN, peer-to-peer NAT traversal, or video/audio streaming.
- A custom domain, Cloudflare Tunnel, Cloudflare Access, or `cloudflared`.
- General-purpose hosting for third-party relay users.
- Shipping a native phone application.

## Options considered

### Named Cloudflare Tunnel plus Access

This is operationally simple and can proxy the existing local HTTP/WebSocket
server. It requires a domain on Cloudflare DNS, a `cloudflared` installation,
and an Access login flow. It does not meet the zero-cost, zero-setup installed
app experience.

### Workers plus Durable Objects WebSocket relay — selected

The desktop and phone each initiate an outbound WSS connection to one Durable
Object room. The room relays opaque encrypted frames. A `workers.dev` hostname
is sufficient, so no domain is required. This mirrors the useful part of the
Tailscale model for this feature: both endpoints rendezvous through a neutral
coordination and relay service without accepting inbound network connections.

### Worker signaling plus WebRTC DataChannel

This can provide a direct data path and TURN fallback with protocol-level
encryption. Terminal traffic is low bandwidth, so the latency benefit is small.
ICE lifecycle handling, browser/main-process bridging, TURN credential
rotation, and network-change recovery add substantial complexity. The earlier
`werift` packaging failure also makes this a poor first release.

## Architecture

### Deployment plane

A dedicated GitHub Actions workflow:

1. Installs dependencies with npm.
2. Builds the phone web application.
3. Tests the Worker, Durable Object, shared crypto, and phone client.
4. Deploys the Worker, Durable Object, and static phone assets with Wrangler.
5. Captures the deployed `workers.dev` URL.
6. Builds the desktop installer with that URL injected as build configuration.
7. Publishes the installer through the project's existing release process.

`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` remain GitHub Actions
Secrets. They never enter the Electron package or runtime settings.

The installed application therefore already knows the relay URL. Users do not
enter URLs, copy secrets, run Wrangler, configure DNS, or open firewall ports.
Local source builds may use an explicit development environment variable, but
that path is developer-only and must fail with a clear configuration message.

### Runtime plane

```text
CCSM main process                 Cloudflare                 Phone browser
-----------------       -----------------------------       -------------
PTY host                         Worker entry point          Static PWA
remote protocol      WSS         Durable Object room   WSS   xterm client
encrypted transport <--------->  opaque frame relay   <----> encrypted transport
```

The Worker has two responsibilities:

- Serve the versioned phone PWA and its local assets.
- Upgrade relay requests and route a random room ID to its Durable Object.

The Durable Object permits one `desktop` socket and one `phone` socket in a
room. It forwards bounded binary frames and connection-state events without
parsing terminal messages.

### Code boundaries

- `cloudflare/`: Worker entry point, Durable Object, static assets, Wrangler
  configuration, Worker tests, and deployment scripts. It is excluded from the
  Electron package.
- `electron/remote/`: relay controller, cryptographic session, reconnect logic,
  transport adapter, and reuse of existing PTY protocol handlers.
- `electron/ipc/` and `electron/preload/`: typed status and control APIs for the
  renderer. The renderer continues to use only `window.ccsm`.
- `src/mobile/`: phone PWA, terminal UI, pairing bootstrap, reconnect, and local
  credential storage.
- `src/components/settings/`: zero-configuration mobile-remote status and QR
  experience.
- Shared transport types and crypto primitives live in a browser-safe module
  that imports neither Electron nor Node-only APIs.

The remote controller starts through a guarded, lazy import after
`app.whenReady()` and after the main window startup path is established. A
failure records an actionable status and leaves the rest of CCSM operational.

## Pairing and security

### Pairing capability

On first launch of a CI-produced build, the post-ready remote controller
generates a random 256-bit pairing secret, stores it with Electron
`safeStorage`, and creates an independent random room ID. Remote control starts
in its unpaired waiting state automatically. The settings page displays a QR
code containing base64url-encoded identifiers:

```text
https://<deployed-worker>/#pair=<room-id>.<pairing-secret>
```

The secret is in the URL fragment. Browsers do not send fragments in HTTP
requests, access logs, or Worker routing. The PWA reads the fragment, stores the
credential in IndexedDB, removes the fragment from browser history immediately
with `history.replaceState`, and connects to the room. The PWA's strict CSP and
locally bundled assets reduce the browser-side secret exposure surface.

The room ID can be visible to Cloudflare. Possession of the room ID alone grants
no terminal access.

### Peer authentication and encryption

Desktop and phone prove possession of the pairing secret during an
application-layer handshake:

1. Each side generates a fresh connection nonce.
2. The peers exchange protocol version, role, and nonce through the relay.
3. Each side returns an HMAC-SHA-256 transcript proof.
4. Both derive directional keys with HKDF-SHA-256 using the pairing secret,
   room ID, nonces, protocol version, and direction label.
5. All terminal protocol messages use AES-256-GCM.

Each encrypted envelope contains a connection ID and monotonically increasing
sequence number. The sequence number is authenticated additional data and
determines a unique nonce within that directional key. Duplicate, stale,
out-of-order beyond the allowed window, unauthenticated, oversized, and
wrong-version frames are rejected.

The implementation uses Web Crypto-compatible primitives available in modern
phone browsers and Electron/Node. It adds no native cryptographic dependency.
Cloudflare receives room metadata, timing, and ciphertext sizes, but cannot
read terminal content or create valid terminal commands.

### Rotation and revocation

Refreshing the pairing identity generates a new secret and room ID, closes both
old sockets, deletes the old desktop credential, and displays a new QR code.
The old phone credential then fails to connect. Pausing remote control closes
the desktop socket and prevents terminal access while preserving the pairing
identity for later use.

### Relay abuse controls

The Worker endpoint is public, so it must protect the free-tier allowance:

- Strict room ID, role, method, origin, and WebSocket-upgrade validation.
- One desktop and one phone socket per room.
- A small maximum frame size aligned with the terminal protocol limits.
- Short unauthenticated handshake timeout.
- Idle timeout for rooms without a desktop.
- Per-IP connection-attempt limits where Cloudflare's binding/configuration
  supports them, plus in-Worker defensive limits.
- No persistence of terminal messages or pairing credentials.
- Free-plan hard limits remain enabled so excess use causes temporary
  unavailability rather than a bill.

These controls protect availability. Terminal authorization still comes from
the end-to-end pairing secret.

## Runtime flow

1. After CCSM is ready, the remote controller connects outbound to the compiled
   Worker URL and claims the desktop role for its random room.
2. The settings pane reports relay connectivity and displays the pairing QR.
3. The phone loads the PWA, imports the fragment credential, and connects to the
   same room with the phone role.
4. Both peers complete the authenticated key handshake.
5. The phone requests `sessions.list`.
6. Selecting a session sends `session.snapshot`; the desktop returns the
   authoritative terminal buffer and PTY sequence.
7. Live `pty.data`, `session.input`, and `session.resize` reuse the existing
   remote message semantics inside encrypted envelopes.
8. On reconnect, fresh nonces create fresh session keys. The phone requests a
   new snapshot and discards live chunks whose PTY sequence is already covered.

## Desktop UX

The mobile-remote settings pane has no setup form.

### Ready state

- Relay status: connecting, online, degraded, or unavailable.
- Pairing QR code.
- "Refresh QR" action that rotates the pairing identity after confirmation.
- "Pause remote control" action.
- Desktop and phone connection indicators.
- A concise explanation that the phone controls terminal sessions.

### Error states

- **Relay configuration absent:** packaged build error with release guidance;
  development build guidance names the required environment variable.
- **Worker unavailable:** retry status, last error category, and automatic
  exponential backoff.
- **Phone not connected:** normal waiting state.
- **Authentication failed:** generic phone message and desktop security event;
  no secret details.
- **Protocol mismatch:** require updating the older side.
- **Secure storage unavailable:** keep the feature disabled and explain the
  platform limitation. Never silently save the pairing secret as plaintext.

The renderer receives status changes through a typed preload subscription. It
does not poll main-process internals and does not import from `electron/`.

## Phone UX

The PWA preserves the useful behavior of the current inline client:

- Responsive xterm terminal and local bundled xterm assets.
- Session switcher.
- Mobile shortcut bar for Escape, Tab, Ctrl, arrows, Ctrl+C, and Enter.
- Soft-keyboard viewport handling.
- Connection status and automatic exponential-backoff reconnect.
- Snapshot recovery and PTY sequence deduplication.
- Installable PWA manifest.

The PWA shows explicit states for invalid QR data, desktop offline, pairing
rejected, protocol mismatch, reconnecting, and expired/rotated pairing.

## Error handling and lifecycle

- Remote startup errors are caught at the controller boundary and converted to
  status. They cannot escape into the Electron first-paint path.
- A dropped desktop or phone socket notifies its peer and cleans up its DO role.
- A replacement socket for an occupied role follows one deterministic policy:
  the newest authenticated connection replaces the old connection.
- Both clients use capped exponential backoff with jitter.
- Heartbeats detect half-open WSS connections.
- Closing CCSM stops reconnect timers, unregisters PTY fan-out listeners, closes
  the relay socket, and zeroes in-memory session keys where practical.
- Unknown message types, invalid state transitions, and malformed frames close
  only the offending remote connection.

## Protocol versioning

The encrypted terminal protocol has an explicit integer version. The handshake
must reject incompatible versions before PTY data is exchanged. The phone
assets and desktop installer are deployed in one workflow, reducing drift, but
cached PWA assets can still outlive a desktop update. Static assets use
content-hashed filenames; the HTML shell uses a no-cache policy.

## Testing

### Shared crypto

- Fixed HMAC, HKDF, and AES-GCM vectors run in Node and browser contexts.
- Directional keys differ.
- Nonces never repeat within a connection.
- Tampering, replay, wrong role, wrong room, wrong version, and sequence reuse
  fail closed.

### Worker and Durable Object

- Static PWA and security headers.
- Upgrade and origin validation.
- One desktop and one phone per room.
- Replacement, close propagation, handshake timeout, idle cleanup, frame caps,
  and rate limits.
- The relay forwards binary payloads unchanged and does not persist them.

### Desktop

- Lazy controller import cannot affect window creation.
- Relay configuration, reconnect state machine, heartbeat, shutdown cleanup,
  and status IPC.
- Existing `sessions.list`, snapshot, input, resize, PTY fan-out, and sequence
  semantics work through the encrypted transport adapter.
- `safeStorage` success and unavailable-platform behavior.

### Phone

- Fragment import and immediate URL cleanup.
- Credential persistence and rotation failure.
- Session selection, terminal input, shortcut keys, resize, reconnect,
  snapshot repaint, and sequence deduplication.
- No external runtime assets or network calls beyond the configured Worker.

### End to end

A local Worker/DO development server, a simulated PTY host, and Playwright phone
browser prove:

1. scan-equivalent pairing,
2. encrypted handshake,
3. session listing and switching,
4. live terminal output and input,
5. network interruption and recovery,
6. key rotation revoking the old phone, and
7. incompatible protocol handling.

Before completion, run the repository's existing typecheck, lint, unit tests,
targeted Worker tests, production build, and relevant Playwright harness.

## Rollout

1. Land shared protocol and crypto tests.
2. Land Worker/DO relay and local end-to-end harness.
3. Add desktop relay transport behind a disabled runtime gate.
4. Add phone PWA and settings UI.
5. Add the deployment-and-package workflow.
6. Enable the feature only in artifacts whose build contains a deployed Worker
   URL and whose end-to-end gate passed.

The existing loopback mobile server remains available for tests and local
diagnostics during rollout. Removal or consolidation is a later decision after
the relay path is proven.

## Success criteria

- A CI-produced installer opens with the relay already configured.
- The user opens the mobile-remote settings pane, scans one QR code, and reaches
  CCSM terminal sessions from cellular or another network.
- No domain, VPN, Tailscale, port forwarding, Cloudflare dashboard step, secret
  entry, or URL entry occurs in the installed-app flow.
- Cloudflare cannot decrypt terminal messages.
- Phone network changes recover without restarting CCSM.
- A bad or unavailable remote subsystem never blocks the main CCSM window.
- The single-user workload stays within Cloudflare's free plan under normal
  use.

## Cloudflare references

- Cloudflare Workers WebSockets:
  <https://developers.cloudflare.com/workers/runtime-apis/websockets/>
- Durable Objects WebSocket best practices:
  <https://developers.cloudflare.com/durable-objects/best-practices/websockets/>
- Durable Objects pricing:
  <https://developers.cloudflare.com/durable-objects/platform/pricing/>
- Workers platform limits:
  <https://developers.cloudflare.com/workers/platform/limits/>
