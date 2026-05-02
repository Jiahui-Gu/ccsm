# R0 (zero-rework) review of 08-electron-client-migration.md

## P0 findings (block ship; v0.3 design must change to remove future rework)

### P0.1 `app:open-external` replaced by browser `window.open(url, '_blank')` only — Electron-side semantics differ from web/iOS but spec calls them "symmetric"

**Location**: `08-electron-client-migration.md` §3 (last two rows: `app:version`, `app:open-external`)
**Issue**: The chapter claims the renderer-only replacements (`window.open(url, '_blank')` for external links, `import.meta.env.APP_VERSION` for version) are "Symmetric across clients" — meaning v0.4 web/iOS will use the same implementations. For `app:version` this is true (each client knows its own version). For `app:open-external` it is not: in the web client, `window.open` with `_blank` opens a new browser TAB (same browser context); on iOS, "external link" means handing off to Safari / system handler. The semantics differ. The Electron renderer-only `window.open` with no `shell.openExternal` *also* differs from current Electron behavior — Chromium's `window.open(url, '_blank')` from a `file://` or `app://` origin may be blocked or open inside Electron itself depending on `webPreferences`. Worse, chapter 09 §5 ("Open raw log file" button uses `app:open-external` to open `crash-raw.ndjson`) requires opening a `file://` URL — which the §3 mapping explicitly **rejects** ("for `https?://`; reject other schemes").
**Why P0**: UNACCEPTABLE pattern "Any v0.3 IPC residue / Electron-specific code path that web/iOS can't replicate". The "Open raw log file" button is broken in v0.3 by the chosen mapping; in v0.4 web/iOS, opening a daemon-side file path is meaningless — the "Open raw log file" affordance must be replaced with a "Download raw log" RPC. That RPC doesn't exist in the v0.3 proto.
**Suggested fix**: (a) Add `CrashService.GetRawCrashLog() returns (stream RawCrashChunk)` to v0.3 proto, returning the contents of `crash-raw.ndjson` as bytes. (b) Replace the "Open raw log file" UI affordance with "Download raw log" everywhere. (c) For `app:open-external`, document that v0.3 allows only `https?://` and v0.4 inherits this restriction; `file://` opening is removed from the supported surface in v0.3 (not in v0.4 — now).

### P0.2 `additionalArguments` does not inject onto `window` — preload mechanism described is technically wrong, and the actual fix re-introduces a `contextBridge`

**Location**: `08-electron-client-migration.md` §4 (Electron process model post-migration)
**Issue**: §4 states "the preload reads `window.__CCSM_LISTENER__` (already injected by main via `webPreferences.additionalArguments`)". This is incorrect: `webPreferences.additionalArguments` appends to the renderer process's `process.argv`, which is **not visible on `window`** with context isolation enabled. The only ways to put a value on `window` from the main side without `nodeIntegration: true` are (a) `contextBridge.exposeInMainWorld` (which the `lint:no-ipc` grep forbids — ship-gate (a) fails), (b) `webPreferences.preload` script that uses `contextBridge` (same problem), or (c) a URL query parameter / SessionStorage seed (works but the spec doesn't describe it). v0.4 web/iOS clients don't have this problem at all — they have their own bootstrap. The v0.3 Electron-specific bootstrap mechanism is broken as written, and the obvious fix ships `contextBridge` into a fresh source file — exactly what §11(a) ship-gate forbids.
**Why P0**: UNACCEPTABLE pattern "Any v0.3 Electron-specific code path that web/iOS can't replicate" + the v0.3 design as written cannot satisfy ship-gate (a). The fix MUST be lockable in v0.3 because v0.4 won't touch it (web/iOS don't use it).
**Suggested fix**: Lock the bootstrap mechanism in v0.3 to one of: (a) Electron main writes the descriptor to a fixed renderer-readable URL (e.g., `app://ccsm/listener-descriptor.json`) using `protocol.handle` — renderer fetches at boot, no IPC, no contextBridge; (b) modify the `lint:no-ipc` rule to whitelist a single SHA-pinned `preload-descriptor.ts` that ONLY exposes the inert descriptor object via `contextBridge.exposeInMainWorld('__CCSM_LISTENER__', frozenDescriptor)` with NO function values — and document this exception in chapter 12 §4.1. Pick one and write it down so phase 8 isn't blocked.

### P0.3 Renderer transport bridge is "MUST-SPIKE / SHOULD-SHIP" — leaves Electron-specific main-process code path unresolved

**Location**: `08-electron-client-migration.md` §4 ([renderer-h2-uds] MUST-SPIKE); also `15-zero-rework-audit.md` §4 item 9
**Issue**: The chapter (and audit §4 item 9) flags that Chromium fetch cannot use UDS / named pipe and recommends a main-process h2 bridge "for predictability". Bridge is Electron-only — v0.4 web/iOS don't have it and don't need it. But: if the bridge ships, it speaks Connect over loopback to the renderer AND speaks Connect over the daemon-chosen transport to the daemon. The bridge re-emits headers and trailers; principal information from the daemon's peer-cred (looking at the BRIDGE process, not the renderer) gets confused. The renderer is presented as the bridge's pid — peer-cred returns the user's uid (correct, because Electron main and renderer run as the same user) — fine in v0.3. In v0.4, no bridge exists in web/iOS; their auth is JWT on Listener B. So bridge is Electron-internal. But bridge code is daemon-adjacent — it must speak the same Connect framing. If the bridge has bugs that v0.4 web exposes (e.g., header forwarding issues), v0.4 needs to fix them in the bridge — touching v0.3-shipped code.
**Why P0**: UNACCEPTABLE pattern "Any v0.3 IPC residue / Electron-specific code path that web/iOS can't replicate". The bridge IS Electron-specific.
**Suggested fix**: Ship the bridge unconditionally in v0.3 (the chapter weakly recommends this; make it firm). Add to chapter 15 §3 forbidden-patterns: "v0.4 MUST NOT modify `packages/electron/src/main/transport-bridge.ts` for web/iOS reasons; web/iOS do not use it." Also: pin the bridge's transport on both sides (renderer ↔ bridge ↔ daemon) so neither side's transport pick affects the other.

## P1 findings (must-fix-before-merge; ambiguity / soft-rework risk)

### P1.1 Big-bang single-PR migration not deferrable across the v0.3-to-v0.4 boundary

**Location**: `08-electron-client-migration.md` §1; flagged as author sub-decision in `15-zero-rework-audit.md` §4 item 4
**Issue**: The audit chapter §4 item 4 says reviewers should confirm whether "single-PR" was the brief author's intent versus "feature branch with multiple internal PRs that merge to trunk together". This is irrelevant to v0.4 zero-rework (the brief explicitly says so). Skipping per instructions.
**Why P1**: Listed only because the audit asked reviewers to confirm; no zero-rework impact.
**Suggested fix**: No action needed for R0.

### P1.2 React Query is named as the renderer state layer; v0.4 web client choice is undeclared

**Location**: `08-electron-client-migration.md` §4 ("wraps the proto-generated SessionService/PtyService/... clients in React Query / TanStack Query hooks")
**Issue**: v0.3 commits to React Query for the Electron renderer's Connect client wrapping. v0.4 web/iOS will face the same problem; if `packages/web` reuses the Electron renderer's hooks (DRY) it inherits React Query. If it doesn't, the Electron-specific hook layer becomes a v0.3 Electron-only code path that doesn't generalize — UNACCEPTABLE pattern "Any v0.3 IPC residue / Electron-specific code path that web/iOS can't replicate".
**Why P1**: Soft-rework: the hook layer is renderer-side only and arguably not subject to the same "wire/schema/installer" zero-rework rules. But brief §11(a) generalizes "no Electron-specific code path"; React Query usage is in `packages/electron/src` and v0.4 web likely shares it.
**Suggested fix**: Document in chapter 11 §2 that the `rpc/queries.ts` hook layer lives in `packages/electron/src/renderer/` for v0.3, but the abstraction shape (one hook per RPC, returning `useQuery`/`useMutation`/`useSuspenseQuery` results) is forever-stable. v0.4 web client may either share the file (move to `packages/shared-renderer/`) additively or duplicate; either is fine because the abstraction shape is locked.

### P1.3 No version-skew tests between Electron and daemon

**Location**: `08-electron-client-migration.md` §6 (FAILED_PRECONDITION on Hello version mismatch)
**Issue**: The chapter says daemon rejects incompatible client versions with `FAILED_PRECONDITION`. Test coverage in chapter 12 §3 includes `version-mismatch.spec.ts` for one direction only. v0.4 introduces NEW client kinds (`web`, `ios`) whose version negotiation must use the same `Hello.proto_min_version`; without explicit v0.3-side tests pinning what the daemon does for `client_kind="web"` (e.g., does v0.3 daemon accept a `web` client at all?), v0.4 may discover v0.3 daemon rejects it and need a v0.3 patch.
**Why P1**: Soft-rework risk; the v0.3 daemon's stance toward unknown `client_kind` values is undocumented.
**Suggested fix**: Lock in chapter 04 §3: "v0.3 daemon accepts ANY non-empty `client_kind` value and proceeds. The field is observability-only; never used for routing or auth (per chapter 15 §3)." Add an integration test asserting `Hello(client_kind="web")` succeeds against a v0.3 daemon.
