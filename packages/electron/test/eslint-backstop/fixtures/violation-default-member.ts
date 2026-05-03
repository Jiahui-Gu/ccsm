// T8.2 ESLint backstop fixture (d) — default-import + member access.
// With `esModuleInterop`, TS lets you `import electron from 'electron'`.
// no-restricted-imports cannot inspect the default-import binding's
// downstream member access, but no-restricted-syntax MemberExpression
// catches `.ipcMain` / `.ipcRenderer` / `.contextBridge` regardless of
// the object identifier name.
import electron from 'electron';

export const _trip = electron.ipcMain;
