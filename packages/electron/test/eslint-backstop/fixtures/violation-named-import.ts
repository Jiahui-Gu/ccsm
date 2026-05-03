// T8.2 ESLint backstop fixture (a) — direct named import of ipcMain.
// This file is intentionally lint-failing; eslint-backstop.spec.ts runs
// ESLint programmatically against it and asserts no-restricted-imports
// fires. It is excluded from `pnpm --filter @ccsm/electron lint` via the
// `ignores` block in packages/electron/eslint.config.js.
import { ipcMain } from 'electron';

export const _trip = ipcMain;
