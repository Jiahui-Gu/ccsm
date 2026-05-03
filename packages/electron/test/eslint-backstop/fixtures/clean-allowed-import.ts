// T8.2 ESLint backstop fixture (negative control) — non-banned electron
// imports must remain lint-clean so the rule doesn't false-positive on
// legitimate usage like BrowserWindow / app.
import { app, BrowserWindow } from 'electron';

export const _ok = { app, BrowserWindow };
