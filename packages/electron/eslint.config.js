// @ccsm/electron ESLint flat config — extends repo root config and adds
// per-package boundary rules per design spec ch11 §5 + ch12 §4.1.
//
// Boundary intent:
//   - Electron is the thin client. It MUST NOT import @ccsm/daemon source
//     directly; the only sanctioned cross-package surface is the generated
//     Connect-RPC client under @ccsm/proto/gen/**.
//   - Native modules (node-pty, better-sqlite3, etc.) belong in the daemon,
//     never the renderer/main process (chapter 11 §5).
//   - F3 backstop for ship-gate (a) (chapter 12 §4.1): forbid named
//     imports of `ipcMain`, `ipcRenderer`, `contextBridge` from `electron`.
//     The substring grep in tools/lint-no-ipc.sh is the cheap fast layer;
//     this AST-aware ESLint rule catches renamed/aliased imports
//     (e.g. `import { ipcMain as M } from "electron"`) the grep cannot.
//     Sanctioned exceptions go through tools/.no-ipc-allowlist (currently
//     descriptor preload only — see chapter 08 §5).
//
//     Coverage matrix (T8.2 — Task #87):
//       a) `import { ipcMain }   from 'electron'`           — no-restricted-imports
//       b) `import { ipcMain as X } from 'electron'`        — no-restricted-imports (importNames matches the original name, not the alias)
//       c) `import * as Electron from 'electron'`           — no-restricted-syntax (banned namespace import — forces named-import path through (a/b))
//       d) `import electron from 'electron'; electron.ipcMain` — no-restricted-syntax (member access on default-import binding)
//       e) `require('electron').ipcMain`                    — no-restricted-syntax (CJS member access on require call)
//       f) `const { ipcMain } = require('electron')`        — no-restricted-syntax (CJS destructure)
//     Combined, (a)-(f) make import-level evasion of the IPC ban impossible
//     without an explicit eslint-disable comment, which the lint-no-ipc.sh
//     allowlist (forever-stable per ch15 §3 #29) is the only sanctioned escape for.
//
// Downstream tasks plug additional custom rules onto this same config:
//   - Task #70 (T6.6) adds `ccsm/no-electron-ipc-call`
//     (forbid runtime ipc.* calls beyond the import-level check below).
import rootConfig from '../../eslint.config.js';

export default [
  ...rootConfig,
  {
    // T8.2 fixture files deliberately contain banned patterns so the
    // backstop spec can assert ESLint flags them. Exclude from the normal
    // lint pass; the spec invokes ESLint programmatically against them.
    ignores: ['test/eslint-backstop/fixtures/**'],
  },
  {
    rules: {
      'no-restricted-imports': ['error', {
        paths: [
          {
            name: 'electron',
            importNames: ['ipcMain', 'ipcRenderer', 'contextBridge'],
            message: 'v0.3 forbids ipcMain / ipcRenderer / contextBridge — see chapter 08 §5; sanctioned exceptions go through tools/.no-ipc-allowlist (descriptor preload only).'
          }
        ],
        patterns: [
          {
            group: ['@ccsm/daemon', '@ccsm/daemon/*'],
            message: '@ccsm/electron MUST NOT import from @ccsm/daemon — only @ccsm/proto/gen/** Connect-RPC clients are allowed (chapter 11 §5).'
          },
          {
            group: ['node-pty', 'better-sqlite3'],
            message: 'Native modules belong in @ccsm/daemon, not the renderer/main (chapter 11 §5).'
          },
          {
            group: ['@ccsm/proto/src/*', '@ccsm/proto/src'],
            message: '@ccsm/electron may only import generated Connect-RPC code from @ccsm/proto/gen/**, not raw .proto sources (chapter 11 §5).'
          }
        ]
      }],
      // AST-aware backstop — see "Coverage matrix" comment at top of file.
      // The selectors are intentionally narrow (literal "electron" specifier
      // string + the three banned property names) so they cannot false-positive
      // on, say, `process.contextBridge` from some other module. Each selector
      // carries its own `message` so the lint output points the developer at
      // the exact evasion pattern they tripped.
      'no-restricted-syntax': ['error',
        {
          // (c) Forbid namespace imports of the electron module entirely:
          //   `import * as Electron from 'electron'`
          // If someone needs Electron.app / Electron.BrowserWindow they can
          // pull those as named imports — the namespace form exists almost
          // exclusively as an IPC-ban evasion.
          selector: "ImportDeclaration[source.value='electron'] > ImportNamespaceSpecifier",
          message: "v0.3 forbids `import * as X from 'electron'` — use named imports so the IPC ban (no-restricted-imports) can see the symbols. See chapter 08 §5 / chapter 12 §4.1."
        },
        {
          // (d) Forbid member access on a default import of electron:
          //   `import electron from 'electron'; electron.ipcMain.on(...)`
          // Note: electron has no real default export, but TS `esModuleInterop`
          // synthesises one — this selector closes that loophole.
          selector: "MemberExpression[property.type='Identifier'][property.name=/^(ipcMain|ipcRenderer|contextBridge)$/]",
          message: "v0.3 forbids `<x>.ipcMain` / `<x>.ipcRenderer` / `<x>.contextBridge` member access — this catches default-import (`import electron from 'electron'`) and `require('electron')` evasion of the IPC ban. See chapter 08 §5; sanctioned exceptions use tools/.no-ipc-allowlist."
        },
        {
          // (e/f) Forbid `require('electron')` call expressions outright in
          // the .ts/.tsx tree. The package is ESM-only ("type": "module")
          // and any CJS interop with electron in source is a smell — the
          // descriptor preload (only allowlisted file) uses the named-import
          // form, not require. This blocks both `require('electron').ipcMain`
          // and `const { ipcMain } = require('electron')` in one shot.
          selector: "CallExpression[callee.name='require'][arguments.length=1][arguments.0.type='Literal'][arguments.0.value='electron']",
          message: "v0.3 forbids `require('electron')` in @ccsm/electron source — use ESM `import` so no-restricted-imports / no-restricted-syntax can audit IPC usage. See chapter 08 §5 / chapter 12 §4.1."
        }
      ]
    }
  }
];
