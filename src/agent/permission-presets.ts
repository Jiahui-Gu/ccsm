import type { PermissionRules } from '../types';
import { EMPTY_PERMISSION_RULES } from '../types';

// Standard claude.exe built-in tool names. Discovered via `claude.exe --help`
// (`--tools` accepts "Bash,Edit,Read", etc.) plus the user's own
// `~/.claude/settings.json` entries. Keep in sync with the CLI — adding a
// tool here lights up a new row in the Permissions UI; no other wiring.
export const TOOL_CATALOG: readonly string[] = [
  'Read',
  'Write',
  'Edit',
  'NotebookEdit',
  'Bash',
  'WebFetch',
  'WebSearch',
  'Task',
  'TodoWrite',
  'Glob',
  'Grep',
  'BashOutput',
  'KillShell'
];

// 3-state resolver applied per tool in the Permissions UI table. "ask" is the
// natural default — no entry in either list means the agent follows the
// current `--permission-mode` (which for `default` mode prompts on
// writes/shell).
export type ToolState = 'allow' | 'ask' | 'deny';

export type PresetId = 'readonly' | 'commonDev' | 'everythingExceptBash' | 'custom';

export interface PresetDef {
  id: PresetId;
  label: string;
  description: string;
  rules: PermissionRules;
}

// Preset catalogue. `custom` is special-cased in the UI: it's the "I'll
// edit it myself" marker and carries no rules of its own.
export const PERMISSION_PRESETS: readonly PresetDef[] = [
  {
    id: 'readonly',
    label: 'Read-only tools (safe)',
    description:
      'Only inspection tools. Writes, edits, and shell execution are denied.',
    rules: {
      allowedTools: ['Read', 'Glob', 'Grep', 'BashOutput', 'WebFetch', 'WebSearch'],
      disallowedTools: ['Write', 'Edit', 'NotebookEdit', 'Bash', 'KillShell']
    }
  },
  {
    id: 'commonDev',
    label: 'Common dev tools',
    description:
      'Reads, writes, edits, and a curated Bash whitelist (git/npm/npx/node).',
    rules: {
      allowedTools: [
        'Read',
        'Glob',
        'Grep',
        'BashOutput',
        'Write',
        'Edit',
        'NotebookEdit',
        'WebFetch',
        'WebSearch',
        'TodoWrite',
        'Task',
        'Bash(git:*)',
        'Bash(npm:*)',
        'Bash(npx:*)',
        'Bash(node:*)'
      ],
      disallowedTools: []
    }
  },
  {
    id: 'everythingExceptBash',
    label: 'Everything except Bash',
    description: 'All built-in tools allowed; shell execution blocked.',
    rules: {
      allowedTools: [
        'Read',
        'Write',
        'Edit',
        'NotebookEdit',
        'WebFetch',
        'WebSearch',
        'Task',
        'TodoWrite',
        'Glob',
        'Grep',
        'BashOutput'
      ],
      disallowedTools: ['Bash', 'KillShell']
    }
  },
  {
    id: 'custom',
    label: 'Custom',
    description: 'Hand-crafted via the table and pattern textareas below.',
    rules: EMPTY_PERMISSION_RULES
  }
];

const PRESET_BY_ID: Record<PresetId, PresetDef> = Object.fromEntries(
  PERMISSION_PRESETS.map((p) => [p.id, p])
) as Record<PresetId, PresetDef>;

export function getPreset(id: PresetId): PresetDef {
  return PRESET_BY_ID[id];
}

/**
 * Classify a tool's effective state given the rules. Matching order:
 *   1. exact bare tool name in disallowed → deny
 *   2. `Tool(...)` in disallowed → deny (any deny wins over any allow)
 *   3. exact bare tool name in allowed → allow
 *   4. `Tool(...)` in allowed → allow (any scoped pattern counts as allow)
 *   5. otherwise → ask (fall through to permission-mode)
 */
export function deriveToolState(rules: PermissionRules, tool: string): ToolState {
  const scopedPrefix = `${tool}(`;
  for (const p of rules.disallowedTools) {
    if (p === tool) return 'deny';
    if (p.startsWith(scopedPrefix) && p.endsWith(')')) return 'deny';
  }
  for (const p of rules.allowedTools) {
    if (p === tool) return 'allow';
    if (p.startsWith(scopedPrefix) && p.endsWith(')')) return 'allow';
  }
  return 'ask';
}

/**
 * Apply a new state to a tool, returning updated rules. Strips ALL patterns
 * for that tool (bare + scoped) from both lists before re-adding the single
 * bare entry the new state implies. 'ask' removes all entries.
 */
export function setToolState(
  rules: PermissionRules,
  tool: string,
  state: ToolState
): PermissionRules {
  const scopedPrefix = `${tool}(`;
  const strip = (xs: string[]): string[] =>
    xs.filter((p) => p !== tool && !(p.startsWith(scopedPrefix) && p.endsWith(')')));
  const allowedTools = strip(rules.allowedTools);
  const disallowedTools = strip(rules.disallowedTools);
  if (state === 'allow') allowedTools.push(tool);
  else if (state === 'deny') disallowedTools.push(tool);
  return { allowedTools, disallowedTools };
}

/**
 * Merge global + per-session rules. Session wins for any tool whose state
 * the session has explicitly declared. A pattern appearing on both allow
 * and disallow lists (e.g. session allows `Bash(git:*)` while global denies
 * `Bash`) is resolved by deny-wins across the merged output — safer default.
 */
export function mergeRules(
  global: PermissionRules,
  session: PermissionRules | undefined
): PermissionRules {
  if (!session) return { ...global };
  const allowedTools = dedupe([...global.allowedTools, ...session.allowedTools]);
  const disallowedTools = dedupe([...global.disallowedTools, ...session.disallowedTools]);
  // Deny-wins: strip anything that exists in both lists (bare match or the
  // scoped variant) from the allowed list.
  const denied = new Set(disallowedTools);
  const denyCovers = (pattern: string): boolean => {
    if (denied.has(pattern)) return true;
    const openIdx = pattern.indexOf('(');
    if (openIdx > 0) {
      const bare = pattern.slice(0, openIdx);
      if (denied.has(bare)) return true;
    }
    return false;
  };
  return {
    allowedTools: allowedTools.filter((p) => !denyCovers(p)),
    disallowedTools
  };
}

function dedupe<T>(xs: readonly T[]): T[] {
  const seen = new Set<T>();
  const out: T[] = [];
  for (const x of xs) {
    if (seen.has(x)) continue;
    seen.add(x);
    out.push(x);
  }
  return out;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

/**
 * Sanity check for user-entered patterns. We don't attempt full grammar
 * parsing — claude.exe itself enforces that. We only reject obviously
 * malformed entries (empty, unbalanced parens, whitespace-only names) so the
 * effective-flags preview can't turn into gibberish.
 */
export function validatePatterns(patterns: readonly string[]): ValidationResult {
  const errors: string[] = [];
  for (const raw of patterns) {
    const p = raw.trim();
    if (!p) {
      // Empty lines are tolerated by the UI (it trims before saving) — skip
      // silently rather than flagging.
      continue;
    }
    let depth = 0;
    let hadOpen = false;
    for (const ch of p) {
      if (ch === '(') {
        depth += 1;
        hadOpen = true;
      } else if (ch === ')') {
        depth -= 1;
        if (depth < 0) break;
      }
    }
    if (depth !== 0) {
      errors.push(`Unbalanced parens: "${p}"`);
      continue;
    }
    if (hadOpen) {
      const openIdx = p.indexOf('(');
      const name = p.slice(0, openIdx).trim();
      if (!name) {
        errors.push(`Missing tool name before parens: "${p}"`);
        continue;
      }
    } else if (/\s/.test(p)) {
      errors.push(`Tool name may not contain whitespace: "${p}"`);
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Parse a textarea blob (one pattern per line) into a trimmed, deduped
 * string array. Empty/whitespace-only lines are dropped.
 */
export function parsePatternLines(blob: string): string[] {
  return dedupe(
    blob
      .split(/\r?\n/)
      .map((x) => x.trim())
      .filter((x) => x.length > 0)
  );
}

/** Render an array of patterns back into a newline-joined textarea value. */
export function serializePatternLines(patterns: readonly string[]): string {
  return patterns.join('\n');
}

/**
 * Produce the exact CLI flag fragment we'll pass to claude.exe. Returns an
 * empty string when both arrays are empty — keeps the preview tight when the
 * user hasn't touched anything.
 */
export function renderEffectiveFlags(
  permissionMode: string,
  rules: PermissionRules
): string {
  const parts: string[] = [`--permission-mode ${permissionMode}`];
  if (rules.allowedTools.length > 0) {
    parts.push(`--allowedTools "${rules.allowedTools.join(' ')}"`);
  }
  if (rules.disallowedTools.length > 0) {
    parts.push(`--disallowedTools "${rules.disallowedTools.join(' ')}"`);
  }
  return parts.join(' ');
}
