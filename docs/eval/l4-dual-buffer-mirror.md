# L4 dual-buffer mirror architecture for the terminal (#860)

Read-only evaluation. No code changes proposed in this PR — only the paper.

## TL;DR

- The "main-side authoritative xterm" (Windows-Terminal / iTerm2 model) is **already 70% built** in ccsm: every PTY entry constructs an `@xterm/headless` Terminal in the main process and writes every chunk to it (`electron/ptyHost/entryFactory.ts:114-149`). It currently serves only `pty:attach` snapshots and OSC sniffer needs (via SerializeAddon).
- The renderer xterm (`@xterm/xterm` in `src/terminal/xtermSingleton.ts`) is *also* fed every chunk through `pty:data` IPC and runs an independent buffer/scrollback. The two are co-equals, not view-of-authoritative — that's the L1 hack origin (PR #602): `cols/rows` choices have to be reconciled at spawn time because either side can disagree.
- L4 = promote the main-side headless to **the** authoritative buffer; demote the renderer xterm to a paint-only view that subscribes to "frame deltas" instead of raw PTY bytes. This unblocks: clean revert of #602, multi-window mirror, instant reconnect on renderer reload, server-side OSC/dim measurement, future renderer-decoupled features (web/devtools view).
- **Recommendation: ship in 6 incremental PRs over ~5 working days (≈30 engineer-hours).** Risk surface is dominated by (a) IPC throughput for high-bitrate output and (b) frame-coalescing strategy. Both are mitigable; bench plan included below.

---

## Phase 1 — Current architecture map

### Files of interest

| Layer | File | Role |
|---|---|---|
| PTY spawn / pump | `electron/ptyHost/entryFactory.ts` | spawns node-pty + headless xterm; pipes `p.onData → headless.write + IPC fanout + dataFanout` |
| Lifecycle ops | `electron/ptyHost/lifecycle.ts` | spawn / attach / detach / input / resize / kill over the registry |
| IPC surface | `electron/ptyHost/ipcRegistrar.ts` | 8 handlers: `pty:list`, `pty:spawn`, `pty:attach`, `pty:detach`, `pty:input`, `pty:resize`, `pty:kill`, `pty:get`, plus `pty:checkClaudeAvailable`; broadcasts `pty:data`, `pty:exit`, `session:state`, `session:title`, `session:cwdRedirected` |
| Module aggregator | `electron/ptyHost/index.ts` | owns `sessions: Map<sid, Entry>`, binds lifecycle, registers IPC |
| PTY data fanout | `electron/ptyHost/dataFanout.ts` | module-level pub/sub for non-IPC subscribers (notify pipeline) |
| OSC sniffer | `electron/ptyHost/oscTitleSniffer.ts` | scans raw bytes for OSC 0/2 title sequences, pure producer |
| Notify pipeline wiring | `electron/notify/bootstrap/installPipeline.ts` | `onPtyData((sid, chunk) => sniffer.feed(sid, chunk))` |
| Renderer xterm singleton | `src/terminal/xtermSingleton.ts` | one `@xterm/xterm` Terminal for the whole renderer; canvas addon, fit addon, clipboard, etc. |
| Renderer attach hook | `src/terminal/usePtyAttach.ts` | drives `pty.attach`, `pty.spawn` (with viewport size — the L1 hack), wires `pty:data` → `term.write`, wires `term.onData` → `pty:input` |
| Renderer resize hook | `src/terminal/useTerminalResize.ts` | `ResizeObserver` → `fit.fit()` → `pty:resize` (80ms debounce) |
| View shell | `src/components/TerminalPane.tsx` | host element + overlays (attaching / exit / error) |

### Today's data flow

```
   ┌──────────────────────  MAIN PROCESS  ────────────────────────┐
   │                                                              │
   │   node-pty(claude --resume)                                  │
   │            │                                                 │
   │       p.onData(chunk)                                        │
   │            │                                                 │
   │            ├──► headless.write(chunk)   [xterm-headless]     │   ← main buffer A
   │            │       └─► serialize.serialize() served on       │
   │            │           pty:attach (snapshot for re-paint)    │
   │            │                                                 │
   │            ├──► for wc in entry.attached: wc.send('pty:data')│
   │            │                                                 │
   │            └──► emitPtyData(sid, chunk)                      │
   │                    └─► OscTitleSniffer.feed → notify         │
   │                                                              │
   └──────────────────────────────│───────────────────────────────┘
                                  │ IPC (pty:data)
                                  ▼
   ┌──────────────────  RENDERER PROCESS  ────────────────────────┐
   │                                                              │
   │   window.ccsmPty.onData → term.write(chunk)  [xterm canvas]  │   ← view buffer B
   │   term.onData(input) → window.ccsmPty.input                  │
   │   ResizeObserver → fit.fit() → pty:resize(cols,rows)         │
   │                                                              │
   └──────────────────────────────────────────────────────────────┘
```

Two buffers (A in main, B in renderer) both ingest **the same raw byte stream** in parallel. Neither is authoritative; they are independently parsed mirrors of the same input. This is structurally fragile — see Phase 2.

### IPC channel surface (complete)

Outbound (renderer → main, via `ipcMain.handle`):
- `pty:list` → `PtySessionInfo[]`
- `pty:spawn(sid, cwd, opts?)` → `{ok, sid, pid, cols, rows} | {ok:false, error}`
- `pty:attach(sid)` → `{snapshot, cols, rows, pid} | null`
- `pty:detach(sid)` → void
- `pty:input(sid, data)` → void
- `pty:resize(sid, cols, rows)` → void
- `pty:kill(sid)` → boolean
- `pty:get(sid)` → `PtySessionInfo | null`
- `pty:checkClaudeAvailable({force?})` → `{available, path?}`

Inbound (main → renderer, via `wc.send`):
- `pty:data` `{sid, chunk}`
- `pty:exit` `{sessionId, code, signal}`
- `session:state` watcher state
- `session:title` watcher title
- `session:cwdRedirected` `{sid, newCwd}`

### Multi-attach already supported

`Entry.attached: Map<wcId, WebContents>` — the entry can fan out `pty:data` to N webContents simultaneously. ccsm runs a single mainWindow today (`electron/window/createWindow.ts`), so N=1 in practice, but the wiring is N-safe.

---

## Phase 2 — Currently-blurred view-vs-buffer responsibilities

| Concern | Where it lives today | Problem |
|---|---|---|
| `xterm.write()` of pty bytes | **Both** main (`entryFactory.ts:134`) and renderer (`usePtyAttach.ts:217`) | Two parsers, two state machines, two scrollback rings. Any divergence in xterm versions across the two packages → silent diff. |
| Scrollback | Main: `SCROLLBACK = 5000` headless. Renderer: `scrollback: 5000` ctor opt. | Doubled memory. On reattach we replay snapshot from main but the renderer-side history accumulated *before* the detach is gone. |
| Resize ownership | Renderer measures viewport (`fit.proposeDimensions`), tells main (`pty:resize` + lifecycle resizes both PTY and headless). | Renderer is implicitly authoritative. Multi-view would need conflict resolution, which doesn't exist. |
| Spawn-time size (#852) | Renderer measures BEFORE attach, passes `{cols, rows}` to `pty:spawn` so PTY launches at the right size. | This is the L1 hack (#602): without it, the first frame is at default 120×30, then a post-write resize blanks the bottom. Hack is needed *only because* both mirrors compute layout independently. |
| Alt-screen / cursor / decoration state | Tracked twice (once per xterm instance). | Snapshot via `SerializeAddon.serialize()` covers it on re-attach, but live divergence between the two mirrors during a session is not detectable. |
| OSC parsing | `OscTitleSniffer` consumes raw byte stream parallel to both xterms. | OK today, but anything that needs *parsed* state (cursor pos, alt-screen flag, dim) currently has to re-parse. Headless already has this — we just don't read it. |
| Multi-window | Single mainWindow today. | If a second window opens (e.g. a "popout terminal" feature), it would need its own `pty:attach` and would get its own `pty:data` stream. View buffers would diverge from each other (one reset() while the other didn't, etc.). |

### Why L1 (PR #602 spawn-size opts) was inevitable here

The renderer is the only thing that knows what the visible viewport will be. The PTY needs to be spawned at that size or claude's first alt-screen frame is wrong. Today the renderer pushes its size *down through* the IPC `pty:spawn` opts. In an L4 world, the *view* still measures, but it tells the **authoritative buffer**, which decides the PTY size policy — at which point `pty:spawn` no longer takes size opts at all.

---

## Phase 3 — Proposed L4 architecture

### Target diagram

```
   ┌──────────────────────  MAIN PROCESS  ────────────────────────┐
   │                                                              │
   │   node-pty(claude --resume)                                  │
   │            │                                                 │
   │       p.onData(chunk)                                        │
   │            │                                                 │
   │            ▼                                                 │
   │   ┌────────────────────────────────┐                         │
   │   │   AUTHORITATIVE BUFFER         │                         │
   │   │   @xterm/headless Terminal     │                         │
   │   │   - scrollback (5000)          │                         │
   │   │   - alt-screen / cursor        │                         │
   │   │   - parsed state (rows[])      │                         │
   │   │   - SerializeAddon snapshot    │                         │
   │   │   - OSC events (title/cwd/dim) │                         │
   │   └─────────┬──────────────────────┘                         │
   │             │ frame events (delta or coalesced bytes)        │
   │             │  + cursor + altScreen + dim                    │
   │             │                                                │
   │             ├──► OscTitleSniffer (now reads parsed events,   │
   │             │     not raw bytes — smaller surface)           │
   │             │                                                │
   │             └──► pty:frame IPC fanout to N attached views    │
   │                                                              │
   │   View resize requests come back IN: pty:viewport(sid, c,r)  │
   │   Authoritative decides PTY resize policy:                   │
   │       single view  → pass-through                            │
   │       multi view   → max-of-cols × max-of-rows (or policy)   │
   └──────────────────────────────│───────────────────────────────┘
                                  │ IPC
                                  ▼
   ┌──────────────────  RENDERER PROCESS (per view)  ─────────────┐
   │                                                              │
   │   @xterm/xterm Terminal in PAINT-ONLY mode                   │
   │   - on attach: receive snapshot bytes, write once, then      │
   │     subscribe to pty:frame                                   │
   │   - on pty:frame: write(bytes)  (no logic, just paint)       │
   │   - input: term.onData → pty:input  (unchanged)              │
   │   - viewport resize: ResizeObserver → pty:viewport           │
   │   - NO independent scrollback decision (xterm internal       │
   │     scrollback is fine, but it's a *cache of authoritative*) │
   │                                                              │
   └──────────────────────────────────────────────────────────────┘
```

### Responsibilities (single owner each)

| Concern | Owner |
|---|---|
| PTY lifecycle (spawn/kill) | main: `lifecycle.ts` (unchanged) |
| Authoritative buffer state | main: `entryFactory.ts` headless |
| Scrollback truth | main: headless (renderer keeps view-cache only) |
| Alt-screen / cursor / dim | main: read off headless via xterm API |
| OSC parsing | main: stays in `oscTitleSniffer` for now; future opportunity to read via headless's `parser` API |
| Viewport size measurement | renderer per view |
| PTY size policy | main: from N viewport reports → pick one (max for L4-MVP, configurable later) |
| Input | renderer → IPC → PTY (unchanged) |
| Reconnect after renderer reload | main: serve current snapshot, then resume frame fanout |
| Multi-view of same PTY | main: trivially supported — N webContents in `entry.attached`, each gets pty:frame |

### Frame protocol (the one design decision that matters)

Two reasonable options:

**Option A — pass-through bytes (simplest, recommended)**
- `pty:frame` = `pty:data` renamed; main sends raw chunks AFTER headless has consumed them
- Renderer write() into a paint-only xterm
- ~Zero perf delta vs today (still one IPC per chunk)
- Snapshot on attach is the only "delta" anyone needs
- Cost: renderer xterm still parses the bytes (but it has to anyway to render)

**Option B — true frame events**
- Main coalesces N chunks at a 16ms / vsync boundary, computes a row-diff via `term.buffer.active.getLine`
- Sends `pty:frame` = `{rows: [{y, content}], cursor, scroll}` JSON
- Renderer applies via custom paint (NOT `term.write`)
- Pros: bandwidth reduction for high-churn TUIs, cursor coherence guaranteed
- Cons: bypasses xterm's optimized renderer; we'd be building a parallel paint layer; loses canvas/webgl renderer benefits; serialization overhead may exceed bandwidth savings

**Recommendation: Option A.** It captures the architectural win (single source of truth, view-only renderer, multi-view-ready, L1 hack revertable) without taking on a custom paint layer. Option B is a second-step optimization if benches show IPC overhead is the bottleneck — they probably won't, because today's path already does the same IPC.

---

## Phase 4 — Migration plan (incremental, 6 PRs)

Each PR is independently shippable, has its own test story, can be reverted without breaking the next, and keeps the L1 hack working until PR-E removes it.

| PR | Title | Goal | Files | Est hours |
|---|---|---|---|---|
| **PR-A** | `refactor(ptyHost): make headless the canonical buffer (no behavior change)` | Codify "headless is authoritative" in comments + types; rename `entry.headless` → `entry.buffer`; expose `getBufferState(sid)` that returns `{cols, rows, snapshot, cursor, altScreen}`. Today's IPC surface unchanged. | `entryFactory.ts`, `lifecycle.ts`, `index.ts` | 3 |
| **PR-B** | `feat(ptyHost): write to headless first, fanout after` | Reorder pump so `headless.write(chunk)` completes before `wc.send('pty:data')`. Adds invariant "renderer never sees a chunk the authoritative buffer hasn't applied". Mostly rearrangement; tiny throughput hit if any. | `entryFactory.ts` | 2 |
| **PR-C** | `feat(terminal): renderer xterm in paint-only mode` | Remove renderer-side scrollback decisions; comment-mark renderer xterm as "view of authoritative". Add probe `__ccsmTerm.isViewOnly = true`. No protocol change yet — still consumes `pty:data`. Lays groundwork. | `xtermSingleton.ts`, `usePtyAttach.ts` | 3 |
| **PR-D** | `feat(ptyHost): viewport-reports-size protocol` | New IPC `pty:viewport(sid, cols, rows, viewId)`; main aggregates per-view sizes and decides PTY resize (max policy for MVP). `pty:resize` becomes a deprecated alias that internally calls `pty:viewport`. Renderer migrated to `pty:viewport`. | `ipcRegistrar.ts`, `lifecycle.ts`, `useTerminalResize.ts`, `usePtyAttach.ts`, `pty.d.ts` | 6 |
| **PR-E** | `revert(terminal): remove L1 spawn-size hack (PR #602)` | With PR-D in place, the renderer no longer pre-sizes for spawn. `pty:spawn` opts.cols/rows go away on the call site; the IPC handler keeps accepting them as deprecated for one release. Headless and PTY both get sized when the first `pty:viewport` arrives, BEFORE first chunk fanout (which is gated on attach). | `usePtyAttach.ts`, `ipcRegistrar.ts`, `lifecycle.ts` | 4 |
| **PR-F** | `chore(ptyHost): drop deprecated pty:spawn size opts + pty:resize` | Tombstone removal + IPC surface cleanup. One release after PR-E. | `ipcRegistrar.ts`, `lifecycle.ts`, `pty.d.ts` | 2 |

**Dependency graph:** A → B → C in parallel with D, then D unblocks E, then E unblocks F. Total wall-clock ~5 days with one engineer; ~3 days with two engineers parallel on (A,B,C) | (D).

**Sequencing rule:** never skip PR-D before PR-E — that ordering is what makes the revert safe. Reviewer must verify on every PR that `make:win` installer still launches and `npx ccsm` first-run flow still gets the trust prompt at correct size.

---

## Phase 5 — Risks and benchmarks

### R1: IPC throughput

Already today every PTY chunk crosses IPC main→renderer. PR-A through PR-C add zero new IPC. PR-D adds `pty:viewport` (called only on resize, debounced 80ms — negligible). The PR-B reorder makes the path one synchronous `headless.write()` longer per chunk, which means a measurable but small main-process latency increase.

**Bench plan (one engineer, ~2 hours):**
- Drive `cat /usr/share/dict/words` (≈ 500KB) and `npm install --no-audit` (≈ 5MB high-churn output) in a real PTY
- Measure: time-to-last-byte at the renderer xterm, p50/p99 chunk latency, peak heap in main
- Baseline vs PR-A vs PR-D-with-Option-A
- Pass criterion: <10% time-to-last-byte regression on either workload, <50MB main heap delta
- Driver: extend an existing harness probe under `e2e/` — `harness-real-cli` already spawns a PTY

### R2: xterm-headless in main process

Already done — `@xterm/headless` is in `package.json`, runs in pure node, has no DOM dependency. Confirmed working in production. SerializeAddon round-trips cursor + alt-screen state today (that's how `pty:attach` snapshot works). No new risk.

### R3: Multi-window (1 authoritative per window or shared?)

**Shared, per PTY.** The authoritative buffer is keyed by sid, NOT by window. A second window opening (future) attaches its webContents to the same `Entry.attached` map, gets the same snapshot, and joins the same `pty:data` fanout. This is the architectural payoff.

PTY size with multi-view: PR-D's policy = `max(cols across views) × max(rows)` so neither view clips. Refinement (per-view virtual reflow) is a future PR if anyone ever wants different sizes per view.

### R4: Frame coalescing

With Option A (recommended), no coalescing needed — we're not changing the protocol, just enforcing ordering. If R1 bench shows IPC saturation under heavy output, add a 4ms `setImmediate` coalescer in `entryFactory.ts` that batches chunks into a single `pty:data` send. Out of scope for L4 MVP.

### R5: Memory

Today: 5000 lines × (cols × ~bytes) in main headless + same in renderer xterm. With PR-A through PR-F unchanged: same 2× cost (renderer xterm still has its own scrollback because canvas renderer needs it for paint). To collapse to 1× we'd need Option B (custom paint), which we're declining.

**Acceptable.** A 5000-line xterm buffer at 200 cols ≈ 1MB. 2× = 2MB per session. ccsm carries ≤ 20 active sessions in worst-case dogfood; 40MB total. Negligible.

### R6: Snapshot-on-reattach race

Today's snapshot is `SerializeAddon.serialize()` — works. PR-B's reorder means the snapshot now strictly contains every byte the renderer might receive (because main writes first, fanouts second). This actually *fixes* a latent race: today, a chunk could be in flight to renderer A while renderer B requests attach, and B's snapshot might be stale by one chunk. After PR-B that's impossible.

### R7: Reviewer checks

Every PR in the sequence must include a real e2e probe run (per `feedback_e2e_before_merge`). Specifically PR-D and PR-E must run `harness-real-cli` and a manual claude trust-prompt repro, since they touch the path that #852 originally broke.

---

## Open questions for owner

1. **Confirm Option A** (raw byte fanout, view-only renderer) over Option B (custom paint via diff). 80/20: A is correct, but flag if you want Option B explored.
2. **PR-F deprecation window** — one release vs two? Default: one (ccsm has no external API contract).
3. **Multi-view feature priority** — is "popout terminal in second window" on the roadmap? If yes, prioritize PR-D-then-test-multi-view; if no, PR-D is still worth doing for the size-policy clarity but lower urgency.

---

## Conclusion

L4 is a small, high-leverage refactor — not a rewrite. The hard part (main-side headless xterm) is already shipped; we're just promoting it from "snapshot source + OSC scratchpad" to "the buffer", and demoting the renderer xterm to "the screen". Six PRs, ~30 hours, deletes the #602 hack, unblocks multi-view, and gives us a clean home for any future server-side terminal-state feature (cursor reporting, dim measurement, smart re-flow, web-view session viewer, etc.).
