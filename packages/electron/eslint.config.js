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
// Downstream tasks plug additional custom rules onto this same config:
//   - Task #70 (T6.6) adds `ccsm/no-electron-ipc-call`
//     (forbid runtime ipc.* calls beyond the import-level check below).
import rootConfig from '../../eslint.config.js';

export default [
  ...rootConfig,
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
      }]
    }
  }
];
