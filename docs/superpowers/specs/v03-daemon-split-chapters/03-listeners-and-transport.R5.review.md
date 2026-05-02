# R5 review — 03-listeners-and-transport.md

## P0

### P0-03-1. Two `MUST-SPIKE` items pick the same letter "A4"
§4 table lists A4 = h2 over named pipe (preferred for win). Spike [win-h2-named-pipe] validates it. Spike [loopback-h2c-on-25h2] fallback **also** says "A4 (named pipe + h2)". This is consistent — but the table marks A4 as "Preferred for win" while the spike marks A4 as "Fallback". A downstream worker cannot tell whether A4 is the **first try** or the **fallback** for Windows. Pin the order: Win 11 spike order is (A4 → A1 → A2 → A3) OR (A1 → A4 → ...) — currently ambiguous. P0 because Phase 2 done-criterion is "All MUST-SPIKE items in [03] resolved (one transport pick per OS)" — order of attempts matters to scheduling.

### P0-03-2. `bind` discriminant uses `kind: "named-pipe"` in §2 vs `transport: "h2-named-pipe"` in §3 descriptor
- §2 `BindDescriptor` discriminant is `kind: "named-pipe"` / `"uds"` / (implied `"loopback-tcp"` although not shown).
- §3 descriptor `transport` field uses values `"h2c-uds" | "h2c-loopback" | "h2-tls-loopback" | "h2-named-pipe"`.

These are different vocabularies for the same axis. The descriptor's `transport` mixes protocol+socket-kind; the in-process `BindDescriptor.kind` is socket-kind only. **A downstream worker reading both will assume `kind` and `transport` map 1:1 and write a buggy translator.** Either: (a) make `BindDescriptor.kind` enumerate the same 4 values as `transport`, or (b) explicitly document the mapping table with the protocol axis as a separate field.

Also: `BindDescriptor` interface itself is referenced in `Listener` but its full type is not shown in §1 — only inferred from §2 `bind: ... ? { kind: "named-pipe", path: ... } : { kind: "uds", path: ... }`. Add the union type definition.

## P1

### P1-03-1. `peerCredMiddleware()` produces principal `{ kind: "local-user", uid, sid }`
Chapter 05 §1 defines Principal in TS as `{ kind: "local-user"; uid: string; displayName: string }` — note **no `sid` field**. Chapter 03 §2 mentions `sid` but chapter 05 says `uid` is "the OS-native identifier rendered as string: numeric uid on linux/mac, full SID string on Windows". So the Windows SID lives **inside** `uid`, not in a separate `sid` field. **Chapter 03 §2 is wrong** — it implies a `sid` field that does not exist. Remove `sid` or align chapter 05 to add the field.

### P1-03-2. `BindDescriptor` for Windows says `path: \\\\.\\pipe\\ccsm-${env.userSid}`
- Per-user named pipe name keyed by user SID. But chapter 02 §2.1 says service runs as LocalService — the daemon does not know which user will connect at bind time. **Why is the SID in the bind path?** Either:
  - The daemon binds N pipes (one per logged-in user) — not stated anywhere.
  - The daemon binds one pipe with `${env.userSid}` = the LocalService SID — then chapter 05's "interactive user uid" claim breaks.
  
Pin the semantics. P1 because §3 descriptor address example shows `\\\\.\\pipe\\ccsm-S-1-5-21-...` (a real user SID, not LocalService) — implies per-user pipe, but binding strategy is undefined.

### P1-03-3. Vague verbs
- §1 "owned by the daemon" ✓ pinned.
- §6 "daemon startup code MUST contain the exact line `// listeners[1] = makeListenerB(env);  // v0.4` as a code comment" — good, mechanical.
- §4 paragraph after table: "The transport choice does NOT leak into proto, RPC handlers, or Electron business logic — it lives only in: (a) ..., (b) ..." — pinned, good.

### P1-03-4. Connection descriptor file location on Linux
§3 says `/run/ccsm/listener-a.json`. Chapter 07 §2 also says `/run/ccsm/listener-a.json (volatile)`. Chapter 02 has no mention of where descriptor is written on linux (silent). OK no contradiction, just incomplete in 02.

### P1-03-5. Descriptor `version: 1` field — what is the bump policy?
"The `version: 1` field is forever-stable — additions go in new top-level fields." Then version 1 never increments. So why have a version field? Either: (a) document that v0.4 with breaking-changes-to-descriptor MUST write a sibling file `listener-a-v2.json` (additive); (b) drop the version field; (c) state "version is for parsers to gate strict-mode validation". P1 — clarity for downstream.

### P1-03-6. Supervisor UDS path not declared
§7 says "Bind path mirrors Listener A's UDS conventions but `daemon.sock` → `supervisor.sock`". For Windows where Listener A may be a named pipe (not UDS), what is the supervisor path? Chapter 02 §3 startup step 3 says "Supervisor UDS" — name implies UDS only. On Windows, is supervisor a named pipe? a TCP socket? Chapter 03 §3 descriptor includes `supervisorAddress` which can be `127.0.0.1:54872`, implying TCP — confirm it. Currently spread across 3 chapters, no single chapter pins per-OS supervisor binding.

## Scalability hotspots

### S1-03-1. AuthMiddleware `before(...)` has no timeout
A misbehaving middleware (e.g. peer-cred lookup blocking on `/proc/net/tcp` read on a busy linux box) blocks the per-connection accept thread. Pin a deadline (e.g. 1s for peer-cred) and document what happens on timeout (`Unauthenticated` per §5 OR distinct `DeadlineExceeded`).

### S1-03-2. Loopback TCP peer-cred via `parse /proc/net/tcp` on every connection
On linux, a busy machine has hundreds of entries; parsing on every accept is wasteful. Either cache + invalidate or use `SO_PASSCRED` (linux UDS feature; not loopback TCP). For high-concurrency sessions (many Attach streams), this is a hotspot. Flag.

## Markdown hygiene
- §4 table column "Decision" mixes "Default for ..." and "**Default for ...**" bolding inconsistently. Cosmetic.
- Code fences are language-tagged (`ts`, `proto`, `json`). Good.
