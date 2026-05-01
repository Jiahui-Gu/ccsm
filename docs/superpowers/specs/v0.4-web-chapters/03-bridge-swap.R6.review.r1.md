# Review of chapter 03: Bridge swap

Reviewer: R6 (Naming / consistency / clarity)
Round: 1

## Findings

### P2-1 (nice-to-have): No mapping table from v0.3 IPC channel names to v0.4 Connect method names

**Where**: throughout chapter 03 — §1 uses IPC-channel naming (`pty:list`, `app:getVersion`, `db:save`); §3 line 70 introduces Connect-method naming (`listPty`, etc.); §4 line 81 uses both side-by-side: "the implementation of `list()` changes from `ipcRenderer.invoke('pty:list')` to `connectClient.listPty({}).then(r => r.sessions)`".

**Issue**: Reader must mentally map `pty:list` ↔ `listPty` ↔ proto RPC `ListPty`. The convention isn't stated explicitly anywhere. Bridge surface keeps the v0.3 method name (`list()`); proto uses PascalCase (`ListPty`); generated TS client method is camelCase (`listPty`). Three name forms for one operation.

**Why P2**: experienced TS+protobuf engineers infer the convention (`pty:list` → service method `ListPty` → generated client `listPty`); but for a 46-RPC swap, an explicit mapping table prevents a fixer from miscoding `pty:getBufferSnapshot` ↔ ?? `getPtyBufferSnapshot` vs `getBufferSnapshotPty` vs `getPtySnapshot`.

**Suggested fix**: in §1 add a column to the inventory table: "v0.4 Connect method name". Example row:

| v0.3 IPC | v0.4 Connect method | Proto file |
|---|---|---|
| `pty:list` | `listPty` (RPC `ListPty`) | pty.proto |
| `pty:getBufferSnapshot` | `getPtySnapshot` (RPC `GetPtySnapshot`) | pty.proto |

Also state the convention once in §1 prose: "v0.3 IPC channel `<domain>:<verb>[Camel]` maps to proto RPC `<Verb><Domain>` (PascalCase) and TS client method `<verb><Domain>` (camelCase)." This is a single-chapter fix.

### P2-2 (nice-to-have): "Bridge surface" vs "bridge file" vs "bridge function" — pick canonical noun

**Where**:
- §1: "Bridge file" (table header).
- §4: "Bridge surface stability rule"; "Bridge function signatures unchanged".
- §6: "each bridge file has one active transport per build"; "bridge function".
- 04 §2: "Bridge installation in web"; "Bridge surface".

**Issue**: "Bridge file" is the .ts file. "Bridge surface" is the public window.ccsm* shape. "Bridge function" is one method. All three are used interchangeably in places.
**Why P2**: doesn't change behavior; a glossary line would resolve it.
**Suggested fix**: at chapter 03 §1 opening, add: "Terms: a *bridge file* is one of the 5 `electron/preload/bridges/*.ts` files; the *bridge surface* is the public `window.ccsm*` API exposed by all bridge files together; a *bridge function* is one method on `window.ccsm*`."

### P2-3 (nice-to-have): Stream count mismatch in §1 inventory

**Where**: §1 line 25-29 table:
- ccsmCore: 4 streams
- ccsmSession: 4 streams
- ccsmPty: 2 streams
- ccsmNotify: 1 stream
- ccsmSessionTitles: 0 streams
- Total in §1 line 31: "**11 streams**"

4+4+2+1+0 = 11. Math checks. But §1's ccsmCore stream list reads: "(`updates:status`, `update:downloaded`, `window:maximizedChanged`, `window:beforeHide`/`window:afterShow`)". That's 5 names (counting `window:beforeHide` and `window:afterShow` as separate signals — they are listed as separate channels in chapter 11 ccsmCore.ts row): "updates:status, update:downloaded, window:maximizedChanged, window:beforeHide, window:afterShow" = 5, not 4. Then totals would be 5+4+2+1+0 = 12, not 11.

**Why P2**: probably the author is folding `window:beforeHide`/`window:afterShow` into one stream (they're paired). But the inventory text doesn't say so; reader can't reconcile. Same ambiguity in chapter 06 §8 table: "session:cwdRedirected" listed as folded into `streamSessionStateChanges`, "session:activate" folded into `streamNotifyFlashes` — but §1 still counts them as separate streams.
**Suggested fix**: clarify in §1 footnote: "`window:beforeHide`/`window:afterShow` paired as one channel signal pair = one stream." OR change count to 12 if they're separate.

## Cross-file findings (if any)

None new beyond shared-with-other-chapters items already flagged in 00 / 02.
