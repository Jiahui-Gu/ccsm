// T8.2 ESLint backstop fixture (c) — namespace import.
// `import * as Electron from 'electron'` would let `Electron.ipcRenderer`
// slip past no-restricted-imports (which only inspects named specifiers).
// The no-restricted-syntax rule on ImportNamespaceSpecifier closes that
// loophole at the import line itself.
import * as Electron from 'electron';

export const _trip = Electron;
