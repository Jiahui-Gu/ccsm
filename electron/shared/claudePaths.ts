// Single source of truth for "where the Claude CLI stores its config".
//
// Why this exists: the formula
//   `process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude')`
// was duplicated verbatim across 4+ call sites in electron/, plus two call
// sites that hardcoded `os.homedir() + '.claude'` and SILENTLY IGNORED the
// env-var override (electron/ipc/systemIpc.ts settings.json read +
// electron/import-scanner.ts projects-root). When users rely on
// `CLAUDE_CONFIG_DIR` to run parallel CLI configs (see memory:
// project_cli_config_reuse — ccsm exports this env var so the bundled
// claude.exe and the GUI loaders agree on which tree to read), those two
// hardcoded sites would read the wrong directory: the settings dialog showed
// stale connection info, and the import scanner listed sessions from the
// non-active config tree.
//
// All electron/ code that needs a `~/.claude`-style path should call these
// helpers instead of recomputing the formula. Each helper reads the env var
// LAZILY (every call), so tests and at-runtime env mutations are honored —
// do NOT cache the result at module load.
//
// Note: `electron/ptyHost/jsonlResolver.ts` deliberately does NOT use this
// helper — it has its own `USERPROFILE || HOME || null` semantics (returns
// null when neither is set) that differ from `os.homedir()`'s passwd-based
// fallback. Its existing tests assert that null behavior; converting it
// would silently change runtime behavior. Leave it as the lone exception.

import * as path from 'node:path';
import * as os from 'node:os';

/**
 * Absolute path to the Claude CLI's config directory.
 *
 * Precedence:
 *   1. `process.env.CLAUDE_CONFIG_DIR` if set (production: ccsm sets this so
 *      the bundled claude.exe and the GUI loaders read the same tree)
 *   2. `<os.homedir()>/.claude` (default — what the CLI does when the env
 *      var is unset)
 *
 * Read lazily on every call so tests can mutate the env var per-case and
 * a runtime `process.env.CLAUDE_CONFIG_DIR =` assignment is honored on the
 * next call.
 */
export function getClaudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
}

/**
 * Absolute path to the CLI's per-project transcript root:
 * `<claudeConfigDir>/projects`. Each subdirectory is a project, named by
 * the URL-safe encoding of its cwd (`cwdToProjectKey`), and contains the
 * `<sid>.jsonl` transcript files.
 */
export function getClaudeProjectsDir(): string {
  return path.join(getClaudeConfigDir(), 'projects');
}

/**
 * Absolute path to the CLI's user settings file:
 * `<claudeConfigDir>/settings.json`. Read by the new-session default-model
 * lookup; the user edits it via `claude /config` or by hand. ccsm never
 * writes it.
 */
export function getClaudeSettingsPath(): string {
  return path.join(getClaudeConfigDir(), 'settings.json');
}
