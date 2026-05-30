// Env overrides and sqlite-persisted log-level handling for the main-process
// logger. Stateless helpers — the live `_currentLevel` singleton lives in
// `log.ts` (the public facade) to keep exactly one source of truth.

import type { LogLevel } from './logRuntime';

export const LOG_SCHEMA_VERSION = 1;
const LOG_LEVEL_KEY = 'ccsm.logLevel';

export type EnvFlags = {
  level: LogLevel | null;
  enableFile: boolean;
};

export function readEnvFlags(): EnvFlags {
  const raw = process.env.CCSM_LOG_LEVEL?.toLowerCase();
  const valid: LogLevel[] = ['debug', 'info', 'warn', 'error'];
  const level = raw && (valid as string[]).includes(raw) ? (raw as LogLevel) : null;
  const enableFile = process.env.CCSM_LOG_ENABLE_FILE === '1';
  return { level, enableFile };
}

/** Reads persisted log level from sqlite app_state. Imported lazily to avoid
 *  a circular dep (db.ts imports nothing from log.ts but the boot order has
 *  this module loaded before db init). Falls back to `info`. */
export function loadPersistedLevel(): LogLevel | null {
  try {
    // Lazy require — db init happens later in app.whenReady; before that
    // call this returns null and the boot uses the env override or 'info'.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const db = require('../db') as typeof import('../db');
    const raw = db.loadState(LOG_LEVEL_KEY);
    if (raw && ['debug', 'info', 'warn', 'error'].includes(raw)) {
      return raw as LogLevel;
    }
  } catch {
    // db not initialized yet — fall through.
  }
  return null;
}

export function persistLevel(level: LogLevel): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const db = require('../db') as typeof import('../db');
    db.saveState(LOG_LEVEL_KEY, level);
  } catch {
    // db not ready — runtime change still applies in-memory; next boot
    // re-derives from env / default.
  }
}
