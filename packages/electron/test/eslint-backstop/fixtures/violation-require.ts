/* eslint-disable no-undef -- intentional fixture for backstop test; root config lacks node globals here */
// T8.2 ESLint backstop fixture (e/f) — CJS require() evasion.
// Both the bare `require('electron')` call and the `.ipcMain` member
// access on its return value trip distinct selectors. We assert the
// CallExpression selector fires here (the broader rule is "no require of
// electron at all in ESM source").
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { contextBridge } = require('electron');

export const _trip = contextBridge;
