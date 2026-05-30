# Mobile remote — real web exposure (bind beyond loopback)

**Date:** 2026-05-30
**Status:** Design — awaiting user review before implementation
**Scope:** Let a phone on the same network connect directly to the desktop's
mobile-remote server over HTTP/WS. One focused change to the listen host. No
new transport, no protocol change, no auth change.

## Problem

The mobile-remote server today binds `127.0.0.1` only (`remoteHttp.ts:5`,
`HOST = '127.0.0.1'`). A phone cannot reach `127.0.0.1` on the desktop — that
address resolves to the phone itself. The only way a phone reaches the server
now is through an external tunnel (Tailscale). The user has dropped Tailscale
and wants a **real web connection**: the phone opens
`http://<desktop-LAN-IP>:4177/?token=…` directly.

`HOST` is consumed in three places:

| Use | File / line |
|-----|-------------|
| `server.listen(port, HOST)` | `mobileRemoteServer.ts:196` |
| Display URL on the session handle | `mobileRemoteServer.ts:155` |
| `new URL(raw, base)` parse base | `remoteHttp.ts:28` |

The first is the actual bind. The other two are cosmetic/parse-only and must be
decoupled from the bind address.

## Why this is safe to expose

The security boundary is **the bearer token, not loopback**. Every route
(`/`, `/manifest.webmanifest`, `/ws`) already requires a 32-byte
`crypto.randomBytes` token compared in constant time (`tokenMatches`). The
server was written token-first precisely so it does not depend on being
unreachable. Binding a routable interface widens *who can attempt a
connection*; it does not weaken *what an attacker must present*. An unauthed
request gets the same 401/close it gets on loopback today.

Therefore the only real risk of binding `0.0.0.0` is that the server becomes
reachable from any host on the LAN (and, if the network is misconfigured,
beyond). That is exactly what the user asked for, but it must be **opt-in and
deliberate**, never the silent default.

## Goal

Secure-by-default, with a single deliberate switch to expose the server to the
network. Default behavior is unchanged (loopback). One env var flips it.

## Non-goals

- No change to the token, the routes, the WS framing, or the resize path.
- No UPnP / port-forwarding / public-internet exposure. LAN only; routing past
  the LAN is the user's network's responsibility, not ours.
- No TLS. Plain HTTP on the LAN, gated by the token (same as today). TLS on a
  self-signed LAN cert is a separate, larger decision — out of scope here.
- No Tailscale. The `tailscale serve` log hint is removed.

## Chosen design: opt-in `CCSM_MOBILE_REMOTE_HOST`

A new env var selects the bind interface, mirroring the existing
`CCSM_MOBILE_REMOTE_PORT` → `resolvePort` pattern.

- **Unset (default):** bind `127.0.0.1`. Identical to today — loopback only.
- **`CCSM_MOBILE_REMOTE_HOST=0.0.0.0`:** bind all interfaces. The phone connects
  to the desktop's LAN IP. This is the "real web connection" switch.
- **`CCSM_MOBILE_REMOTE_HOST=<specific-ip>`:** bind one interface (e.g. the
  Wi-Fi adapter only), for users who want to expose on one NIC but not another.

The whole feature is still gated behind `CCSM_MOBILE_REMOTE=1`, so exposure
requires **two** deliberate env flags, not one.

### `resolveHost` helper (in `remoteHttp.ts`)

```ts
export const DEFAULT_HOST = '127.0.0.1';

/** Validate the bind host. Anything not matching a bare IPv4 literal (or the
 *  loopback/all-interfaces sentinels) falls back to loopback — we never bind a
 *  surprising interface because of a typo. Hostnames are intentionally not
 *  accepted: the bind target must be unambiguous. */
export function resolveHost(raw: string | undefined): string {
  if (!raw) return DEFAULT_HOST;
  const v = raw.trim();
  if (v === '0.0.0.0' || v === '127.0.0.1') return v;
  // dotted IPv4 (each octet 0-255)
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(v)) {
    const octets = v.split('.').map(Number);
    if (octets.every((o) => o >= 0 && o <= 255)) return v;
  }
  return DEFAULT_HOST; // unknown / hostname / garbage → safe default
}
```

`HOST` (the hardcoded const) is removed; the three call sites change:

1. **bind** — `server.listen(port, resolveHost(process.env.CCSM_MOBILE_REMOTE_HOST), …)`.
   Resolve once near the top of `startMobileRemoteServer` and reuse.
2. **`parseRequestUrl` base** — the base in `new URL(raw, base)` is only used to
   turn a relative request-target into an absolute URL so we can read
   `.pathname`/`.searchParams`. The host portion of that base is never
   inspected. Hardcode it to `http://localhost` (a constant, parse-only base) so
   the parser no longer depends on the bind address at all. No behavior change.
3. **display URL** — see below.

### Display URL = reachable address, not the bind literal

When bound to `0.0.0.0`, `http://0.0.0.0:4177/…` is not a URL a phone can open.
The handle's `url` (shown in the desktop UI for the user to type/scan into the
phone) must show a **reachable** address:

- bind `127.0.0.1` → display `http://127.0.0.1:4177/?token=…` (unchanged).
- bind `0.0.0.0` or a specific external IP → display the desktop's primary LAN
  IPv4, discovered via `os.networkInterfaces()` (first non-internal IPv4). If
  none is found (no network), fall back to the bind literal.

```ts
export function primaryLanIPv4(): string | null {
  const ifaces = os.networkInterfaces();
  for (const addrs of Object.values(ifaces)) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return null;
}

function displayHost(boundHost: string): string {
  if (boundHost === '127.0.0.1') return '127.0.0.1';
  return primaryLanIPv4() ?? boundHost;
}
```

The token still rides in the display URL only (never the console log line —
that redaction stays).

### Log line

The console line keeps the redacted-token format. The `tailscale serve` hint
line is **removed** (Tailscale dropped). When bound non-loopback, add a single
line stating the server is reachable on the LAN at the display host, so a user
reading logs understands exposure is active:

```
[mobile-remote] listening on 0.0.0.0:4177 — reachable at http://192.168.1.42:4177 (token required)
```

## Architecture

```
CCSM_MOBILE_REMOTE_HOST ─→ resolveHost() ─→ boundHost
                                              │
              ┌───────────────────────────────┼───────────────────────────┐
              ▼                                ▼                           ▼
   server.listen(port, boundHost)   displayHost(boundHost)        parseRequestUrl
                                      └→ primaryLanIPv4()           (base = localhost,
                                         when non-loopback           bind-independent)
                                              │
                                              ▼
                                  handle.url = http://<displayHost>:<port>/?token=…
```

## Data flow / behavior

- **Default (env unset):** byte-for-byte identical to today. Bind loopback,
  display loopback, parse base irrelevant.
- **`CCSM_MOBILE_REMOTE_HOST=0.0.0.0`:** bind all interfaces; display URL shows
  the LAN IP; phone on the same Wi-Fi opens that URL + token and connects.
- **Bad value (typo, hostname):** falls back to loopback. We never bind an
  unexpected interface because of malformed input.
- Auth, routes, WS, resize, heartbeat: untouched.

## Testing

Unit (vitest, no live socket needed):

1. `resolveHost` table:
   - `undefined` → `127.0.0.1`
   - `'0.0.0.0'` → `'0.0.0.0'`
   - `'127.0.0.1'` → `'127.0.0.1'`
   - `'192.168.1.5'` → `'192.168.1.5'`
   - `'999.1.1.1'` → `'127.0.0.1'` (octet out of range)
   - `'example.com'` / `''` / `'  '` → `'127.0.0.1'`
2. `parseRequestUrl` still resolves a relative target (`/?token=x`) to the right
   `pathname` + `searchParams` with the new constant base — existing cases pass
   unchanged.
3. `primaryLanIPv4` returns the first non-internal IPv4 from a stubbed
   `os.networkInterfaces()`; returns `null` when only loopback exists.
4. `displayHost('127.0.0.1')` → `'127.0.0.1'`; `displayHost('0.0.0.0')` →
   stubbed LAN IP, or the bind literal when `primaryLanIPv4` is `null`.

Existing `mobileRemoteServer.test.ts` connects as a `127.0.0.1` client. With the
default (loopback) those tests are unchanged. A new test sets
`CCSM_MOBILE_REMOTE_HOST=0.0.0.0`, starts the server, and connects via
`127.0.0.1` — `0.0.0.0` accepts loopback connections too, so the existing client
still connects, proving the bind widened without breaking loopback.

## Verification

- Local gate: `npm run typecheck && npm run lint && npm test` green.
- Headless cannot prove a *physical phone over Wi-Fi* connects — that is the
  user's real-device step. What headless **can** prove (and the new test does):
  the server, when configured to expose, binds a non-loopback-capable address
  and still serves a real WS client. The cross-device hop itself is the user's
  final verification, consistent with the standing "user does real-device
  verify" arrangement.
- The display-URL LAN IP is shown in the desktop UI for the user to type/scan
  into the phone.

## Risk

Low-to-moderate, fully gated. The bind only widens when the user sets a second
deliberate env var; the default is unchanged loopback. The exposure is
token-gated identically to today. The one genuinely new property — the server
answering on the LAN — is the explicit user request, and it is off unless
opted in. Bad env input fails safe to loopback.
