# 08 — Electron Client Migration — R4 (Testability + Ship-Gate Coverage)

Angle: chapter 08 owns ship-gate (a) (zero IPC) and supplies the sigkill harness for ship-gate (b). R4 audits cutover testability + the lint gate's soundness.

## P0 — `lint:no-ipc` script cannot meet brief §11(a) "or only in dead-code paths flagged for removal"

§5h: `npm run lint:no-ipc` script: `grep -r "contextBridge\|ipcMain\|ipcRenderer" packages/electron/src && exit 1 || exit 0`.

Brief §11(a) explicitly allows "only in dead-code paths flagged for removal." The script has no allowlist mechanism. Two failure modes:
1. A migration commit that reduces IPC to zero except for one explicitly-deprecated handler (still being unwired) breaks the gate AND has no graceful path to land.
2. After ship, a contributor adding a comment `// removed ipcMain.handle in favor of CreateSession RPC` fails CI for non-load-bearing reasons.

Either:
- Spec must drop the "or in dead-code paths" allowance (chapter 08 §1 already commits to "delete `packages/electron/src/main/ipc/` directory" — fully consistent with no-allowlist gate); spec needs to **state the brief clause does not apply at v0.3 ship**.
- OR pin an allowlist file format and an `--allowlist` flag for the script.

P0 because the brief invites flexibility the script can't honor → either spec or script has to change before merge.

## P0 — `lint:no-ipc` is a substring grep that misses aliased imports

Same finding as in chapter 12 R4 review: `grep contextBridge|ipcMain|ipcRenderer` matches the literal substrings. Replace or supplement with ESLint `no-restricted-imports` for `electron`'s named exports `ipcMain`, `ipcRenderer`, `contextBridge`. ESLint catches:
```ts
import * as e from 'electron'; e.ipcMain.handle('x', ...)  // grep DOES match (literal "ipcMain" appears)
import { ipcMain as im } from 'electron'; im.handle(...)    // grep DOES match
const { ipcMain } = require('electron'); ipcMain.handle(...) // grep DOES match
```
On reflection grep does match these — but it ALSO matches:
```ts
// rationale: in v0.2 we used ipcMain.handle for X; in v0.3 we use Connect (#PR-1234)
```
which is the false-positive case. The point stands: ESLint is the surgical tool; grep is the broad-and-blunt one. Spec should use both: ESLint as primary, grep as defense-in-depth.

P0 because relying solely on grep produces both false-positives (comments) and false-negatives (when someone shells out to a string concat: `eval('ipc' + 'Main').handle(...)` — silly, but the grep gate is the "mechanical" gate and shouldn't be defeatable by trivial obfuscation).

## P0 — Verification harness §7 step 6 doesn't test what it claims

§7: "Verifies each session's `claude` CLI subprocess is still alive."

How? On Windows, the daemon spawns `claude` as a child of the daemon (LocalService). Test code runs as the test user. `tasklist` from a non-admin user CAN see processes from other users (Windows ACL allows process enumeration), but `taskkill` cannot. Step 6 needs to specify: pre-record each claude PID via the RPC at session create (or via a debug RPC), then in the test process run `Get-Process -Id <pid>` and assert exit code 0. Currently the harness says only "verifies ... still alive" without a mechanism. Without a pinned mechanism: can be implemented as `lsof -p <pid>` (mac/linux) or `tasklist /FI "PID eq <pid>"` (win); the daemon needs an `internal:DebugListClaudePids` RPC for tests OR session row exposes claude_pid. Currently chapter 04 `Session` proto has no pid field. Pin: either add `Session.runtime_pid` (additive at v0.3 freeze, fine) or pin the test mechanism.

P0 because without pinning, ship-gate (b) verification step is inexecutable; "PIDs alive" becomes "we hope they're alive."

## P1 — `app:open-external` replacement is a renderer-side hole that needs a test

§3: "`app:open-external` → renderer-only: standard browser `window.open(url, '_blank')` for `https?://`; reject other schemes; no Electron `shell`."

The "reject other schemes" is a security boundary. There must be a test asserting `window.open('file:///etc/passwd')` and `window.open('javascript:alert(1)')` are blocked. Chapter 12 §2 has `ui/*.spec.tsx` (component-level) but no security spec for URL handling. Add `ui/safe-open-url.spec.ts`.

## P1 — Renderer transport bridge (chapter 14 §1.6 fallback) is the production transport but untested in ch 12

If the renderer-h2-uds spike kills (it will, per chapter 14 R4) and we ship the main-process bridge, the bridge becomes the actual integration boundary. Chapter 12 §3 integration tests run renderer-side Connect client direct against daemon. If the bridge is the production transport, we need `bridge-roundtrip.spec.ts` exercising bridge → daemon for unary, server-stream, bidi, error cases, slow-consumer. Spec must call out "after spike resolution, integration tests adopt the bridge." Chapter 08 §4 gestures at this in the MUST-SPIKE block but no test deltas listed.

## P1 — `additionalArguments` descriptor injection needs a tamper test

§4: "the descriptor is the ONLY thing exposed; everything else is renderer-side Connect."

If `__CCSM_LISTENER__` is mutated by renderer (extension, devtools), the renderer's Connect client dials wherever the mutation says — potentially attacker-controlled. Test: assert the global is non-writable (`Object.freeze` or `defineProperty(writable: false)`) and the Connect transport is constructed exactly once at boot from the original value. Add `preload/descriptor-immutable.spec.ts`.

## P1 — Big-bang PR has no rollback story; gate (a) on a failed attempt leaves Electron broken

§5: "single PR per [08] §5." If the PR merges, gates (a)/(b)/(c) run. If gate (b) fails post-merge (e.g., a corner case in pty replay), revert is hard because the PR is "delete IPC + add Connect" — reverting brings IPC back but Connect was already built into renderer. Spec doesn't address what happens if a post-merge ship-gate failure requires reverting the migration. Pin a rollback procedure (e.g., feature flag in main process selecting between IPC and Connect, retained for one release; OR the gate-b/c tests are run on a pre-merge stacked PR before the cutover lands). Without rollback story, "big-bang" is high-risk; testing pipelines need a guarded landing.

## P1 — Stream error backoff (§6) lacks a test

§6: "Stream errors trigger automatic reattach with exponential backoff capped at 30s. Reattach uses the recorded last-applied seq for `Attach`."

Chapter 12 has `pty-reattach.spec.ts` which tests reattach happy path. No test for: backoff schedule (does it actually back off? does it cap at 30s?). On a flaky transport, backoff can be the difference between "self-healing" and "tight reconnect loop melting CPU." Add `rpc/reconnect-backoff.spec.ts` with a fault-injecting transport.

## P2 — IPC inventory §2 includes 13 channels but spec says "MUST be re-verified by grep at PR-open time"

Good — but the MUST-verify is human. Add a CI job: `grep ... > inventory.txt; diff inventory.txt expected-pre-cutover.txt` so any IPC added between spec and cutover is detected mechanically. Currently the spec relies on the migration PR author noticing manually.

## Summary

P0 count: 3 (allowlist mechanism missing for gate (a); grep vs ESLint; "claude PIDs alive" not testable as written)
P1 count: 5
P2 count: 1

Most-severe one-liner: **Ship-gate (a) script can't represent "dead-code-flagged" exclusions the brief requires AND will substring-match comments — the gate is either too strict for code or too loose for security.**
