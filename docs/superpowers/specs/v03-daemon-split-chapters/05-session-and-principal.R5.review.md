# R5 review — 05-session-and-principal.md

## P0

### P0-05-1. `Principal.uid` definition mismatch with chapter 03 §2
- Chapter 05 §1: `{ kind: "local-user"; uid: string; displayName: string }` — single `uid` field, encodes Windows SID as string.
- Chapter 03 §2: `peerCredMiddleware()` produces principal `{ kind: "local-user", uid, sid }` — two fields.
- Chapter 04 §2 proto: `LocalUser { string uid = 1; string display_name = 2; }` — single `uid` field (matches 05).

Chapter 03 is the outlier. Either drop `sid` from chapter 03 §2 OR add `sid` to chapter 05 §1 + chapter 04 proto. **P0** because this discrepancy directly contradicts brief §5's "principal model" and `principalKey` ordering in §1 of this chapter.

## P1

### P1-05-1. `principalKey` format `kind:identifier` — what about colons in identifiers?
Linux uid `1000` ✓. Windows SID `S-1-5-21-...` contains hyphens, no colons ✓. macOS `String(uid)` is numeric ✓. v0.4 `cf-access:<sub>`: `<sub>` is JWT subject claim — opaque string set by IdP. **`sub` may contain colons.** A colon in `sub` makes `principalKey` ambiguous (e.g., `cf-access:user:bob` → is the kind `cf-access` and id `user:bob`, or kind `cf-access:user` and id `bob`?). The format claim "forever-stable" needs a parse rule (e.g., split on FIRST colon). State it now or v0.4 hits this and either (a) breaks the format or (b) escapes — neither is purely additive.

### P1-05-2. §5 enforcement matrix — `Hello` row says "none"
Chapter 04 §3 says `HelloResponse.principal` returns the principal — that requires the middleware ran. So "none" here means "no per-handler ownership check beyond what middleware did". Reword: "principal already set by middleware; no further check".

### P1-05-3. Vague verbs
- §2 "The `displayName` is the OS-reported display name (best-effort; advisory; never used for authorization)" — pinned, good.
- §4 "explicit early return because:" — pinned with two clear reasons. Good.
- §6 "spawn xterm-headless host" — chapter 06 §1 says it's a `worker_threads` Worker. Fine, "spawn" is loose but OK.
- §7 step 3 "writes a `crash_log` entry on failure" — chapter 09 §1 lists this as `claude_exit` source on the table; verify cross-ref. `claude_exit` is the source string but failure-to-spawn is not exit; should be `claude_spawn` source — chapter 09 doesn't have it. Add.

### P1-05-4. RPC enforcement matrix entry for `Attach`/`SendInput`/`Resize`
Says "load session by id; `assertOwnership`". `Attach` is server-stream, long-lived; ownership is checked once at start. **What if the session changes owner mid-stream?** v0.3 has no ownership transfer, so moot. v0.4 with multi-principal could allow transfer. State "v0.3: ownership immutable for session lifetime; v0.4 may add transfer with stream-restart contract".

### P1-05-5. Cross-reference to brief decision §11(b) (SIGKILL) is implicit
§5/§7 mention "session restore on boot" but don't link to brief §11(b)'s `taskkill /F` requirement. Phase 11(b) ship-gate (chapter 13) is the gate. Fine but add a back-reference for downstream readers searching the chapter for "SIGKILL".

### P1-05-6. Per-RPC matrix omits `Hello` from PtyService section 
The table at §5 lists `Attach`, `SendInput`, `Resize` (PtyService) — but PtyService has no `Hello`. Naming is fine; just confirming the table is complete vs chapter 04 §4. ✓ (yes complete).

## Scalability hotspots

### S1-05-1. `WatchSessions` filter is in-memory event bus
"never emit other-owner events on this stream" — implementation detail of bus. With N concurrent watch streams × M sessions × event rate, the per-event filter is O(N) per emit. For v0.3 N is small (one Electron) but for "many subscribers" worry, no cap. Pin.

## Markdown hygiene
- §6 ASCII-art sequence diagram uses `│ │` columns — renders fine.
- TS/proto code fences correctly tagged.
- Heading hierarchy: `#` → `###`. Skips `##`. Same skip pattern used across chapters; if intentional (chapter title = h1, sections = h3), document it once in 00-brief or in the chapter template. Cosmetic but flag.
