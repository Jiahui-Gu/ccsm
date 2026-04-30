# Code Rot Audit — 2026-05-01

Scope: `src/`, `electron/`, `daemon/src/` at `working` tip `755fcae` (T12 envelope).

## Headline

Codebase is unusually clean for a 6-month-old project. Only **4 TODO/FIXME** total, **0 commented-out code blocks** (every multi-line comment block sampled is JSDoc / explanatory prose, not dead code), low `any` density outside test fixtures.

The one significant rot signal is **dead modules**: a freshly-landed daemon envelope subsystem (#654) plus an older `electron/commands-loader.ts` are not wired to any production caller.

---

## HIGH

### H1. Envelope subsystem (#654 / T12) is wired to tests only — 0 production callers

Files (all under `daemon/src/envelope/`, total ~1042 LoC):

- `daemon/src/envelope/envelope.ts` (202)
- `daemon/src/envelope/chunk-reassembly.ts` (230)
- `daemon/src/envelope/deadline-interceptor.ts` (138)
- `daemon/src/envelope/migration-gate-interceptor.ts` (68)
- `daemon/src/envelope/protocol-version.ts` (79)
- `daemon/src/envelope/boot-nonce-precedence.ts` (68)
- `daemon/src/envelope/trace-id-map.ts` (105)
- `daemon/src/envelope/hmac.ts` (91)
- `daemon/src/envelope/base64url.ts` (22) — used by `hmac.ts` only
- `daemon/src/envelope/supervisor-rpcs.ts` (39) — 2 internal refs

Verification: `grep -rln "envelope/<module>\|/<module>\.js" daemon electron --include="*.ts"` excluding `__tests__` and self returns 0 hits for 8 of 10 files.

This may be acceptable as "infra landed ahead of wiring PR", but two red flags:
- No barrel `daemon/src/envelope/index.ts` exists.
- `daemon/src/index.ts:27` carries `// TODO(T20): full ordered shutdown sequence ...` (dated 2026-05-01) suggesting the wiring task is queued but unscheduled.

Recommendation: confirm the T20/T2x wiring PR is on the backlog; otherwise this is dead-on-arrival and growing.

### H2. `electron/commands-loader.ts` (394 LoC) — zero runtime callers

`grep -rn` across `src` + `electron` + `daemon/src` for `commands-loader|loadCommands|commandsLoader` finds:
- self-referencing `console.warn` strings inside the file itself
- one comment in `src/types.ts:109`
- `tests/commands-loader.test.ts`

No production import. Per memory note `project_renderer_reads_claude_config_dir.md`, the renderer-side commands loader reads `CLAUDE_CONFIG_DIR` directly — meaning this main-process loader is presumably superseded. Either re-wire (if main was supposed to broadcast skills via IPC) or delete.

---

## MED

### M1. Dead/orphan UI modules

| File | LoC | Status |
|------|-----|--------|
| `src/components/FileTree.tsx` | 143 | No importer. `App.tsx` and others reference `TerminalPane`/`ClaudeMissingGuide` but never `FileTree`. `src/utils/file-tree.ts` (159 LoC) builds the data the component would render — also unimported. |
| `src/utils/file-tree.ts` | 159 | Pair of the above; `parseGlobResult` / `parseLsResult` / `buildFileTree` exported, none consumed in production. |
| `src/components/ui/MetaLabel.tsx` | 56 | `MetaLabel` export not imported anywhere in `src/` or `electron/`. |
| `src/shared/ipc-types.ts` | 32 | `LoadedCommand`, `WorkspaceFile` exports unimported. |
| `src/utils/diff.ts` | 67 | `diffFromEditInput`, `diffFromWriteInput`, `diffFromMultiEditInput` unimported. |

Total: ~457 LoC. Likely safe deletes pending one-grep confirmation per worker (these may be referenced by tests or scripts not in the audit scope).

### M2. Daemon DB migration helpers — only consumed by their own tests

- `daemon/src/db/migrate-v02-to-v03.ts` (266 LoC) — only `daemon/src/db/__tests__/migrate-v02-to-v03.test.ts`
- `daemon/src/db/migration-events.ts` (151 LoC) — only `daemon/src/db/__tests__/migration-events.test.ts`

Same pattern as H1: probable "infra ahead of wiring". Worth confirming the migration runner that should call these exists or is planned.

### M3. `any` density concentrated in two ptyHost test files

| LoC w/ `any`/`@ts-ignore` | File |
|---|---|
| 38 | `electron/ptyHost/__tests__/ipcRegistrar.test.ts` |
| 30 | `electron/ptyHost/__tests__/lifecycle.test.ts` |
|  9 | `electron/ptyHost/__tests__/entryFactory.test.ts` |
|  9 | `electron/ptyHost/__tests__/detachReattach.test.ts` |
|  3 | `electron/sessionWatcher/__tests__/projectKey.test.ts` |
|  3 | `electron/ptyHost/__tests__/claudeResolver.test.ts` |
|  3 | `daemon/src/envelope/__tests__/hmac.test.ts` |

Production code is almost entirely `any`-free: only `src/terminal/xtermSingleton.ts` and `electron/sessionWatcher/inference.ts` carry one each. Test-side density is acceptable (mocks/stubs), but the two top files are worth a typing pass if/when ptyHost grows.

---

## LOW

### L1. TODO/FIXME inventory (4 total, all current)

- `electron/main.ts:40` — `// ... TODO: forward to Sentry` (2026-04-30, 1d old, not actionable until Sentry integration scoped)
- `daemon/src/index.ts:27` — `// TODO(T20): full ordered shutdown sequence ...` (2026-05-01, 0d old, tracked as T20)
- `daemon/src/envelope/__tests__/boot-nonce-precedence.test.ts:52,54` — `01HXXXXXXXXXXXXXXXXXXXXXXX` literal trace IDs in test fixture (false positive on `XXX` regex; not real markers)

**Zero TODO/FIXME aged >60 days.** No action required.

### L2. Commented-out code: NONE FOUND

Multiline comment scan flagged 40+ blocks >5 lines, but spot-checking every flagged region in `src/agent/lifecycle.ts`, `src/App.tsx`, `src/components/chrome/TopBanner.tsx` confirmed all are JSDoc / architectural rationale / debug-seam explanations. This is healthy and worth preserving.

### L3. ts-prune unused exports (35 truly-unused, mostly type aliases)

Beyond the M1 dead modules above, the rest fall into safe categories:
- Type aliases re-exported as part of public surface but only used inside the module: `DurationToken`, `EasingToken`, `MotionPreset`, `BannerActionTone`, `BannerActionShape`, `IconButtonSize`, `IconButtonVariant`, `ButtonSize`, `MetaLabelSize`, `PermissionMode`, `EndpointKind`, `MessageBlock`. Common pattern; harmless.
- Re-exports of Radix primitives never used yet: `ContextMenuPortal/Group/Label`, `DialogTrigger`, `TooltipRoot`, `TooltipTrigger`. Keep as future API surface or trim — judgement call, not rot.
- Test-only seams: `__resetSingletonForTests`, `_resetForTests` (drafts). Keep.
- i18n functions `resolveLanguage`, `initI18n`, `applyLanguage` flagged as unused — false positive, called from `src/main.tsx` bootstrap which ts-prune may not be tracing.

---

## Suggested follow-up tasks

1. **HIGH**: Confirm T2x envelope-wiring PR exists or schedule it; otherwise the 1042 LoC envelope subsystem is dead code growing untested in production.
2. **HIGH**: Decide `electron/commands-loader.ts` fate — re-wire via IPC or delete (394 LoC).
3. **MED**: Delete or re-wire `src/components/FileTree.tsx` + `src/utils/file-tree.ts` (302 LoC together).
4. **MED**: Verify `daemon/src/db/migrate-*` runners are wired to a startup path before next release.
5. **LOW**: Type-tighten `electron/ptyHost/__tests__/ipcRegistrar.test.ts` and `lifecycle.test.ts` next time someone touches them.

Total candidate dead-code surface (HIGH + MED M1/M2): **~2310 LoC** — but most of it (envelope + migrations) is plausibly "landed early", not actually rot. True rot sits in commands-loader (394) + FileTree pair (302) + small UI orphans (~155) = **~850 LoC** confidently safe to delete.
