// Slash command registry.
//
// Two flavours coexist in the picker:
//
//   - BUILT-IN: a tiny static list (`/clear`, `/compact`). `/clear` runs
//     locally because it must reach into the renderer state machine; the
//     CLI's own `/clear` only knows how to wipe its in-process context, not
//     ours. `/compact` is pure pass-through.
//
//   - DYNAMIC: discovered at runtime by scanning user / project / plugin
//     command directories on disk (see electron/commands-loader.ts). These
//     are ALWAYS pass-through — Agentory deliberately does not parse the
//     markdown body or inject anything into the system prompt; the CLI
//     already knows how to execute its own commands. We're just surfacing
//     them in the GUI picker so users don't have to remember names.
//
// Anything that's not built-in or dynamic falls through to claude.exe as a
// raw `/foo` line, which is intentional: forward-compat with new commands
// the CLI ships before we sync.

import { Eraser, Minimize2, type LucideIcon } from 'lucide-react';

export type SlashCommandSource = 'built-in' | 'user' | 'project' | 'plugin';

export type SlashCommandContext = {
  sessionId: string;
  args: string;
};

export type SlashCommand = {
  name: string;
  description?: string;
  icon?: LucideIcon;
  source: SlashCommandSource;
  /** Plugin namespace, only set when source === 'plugin'. */
  pluginId?: string;
  /** From frontmatter `argument-hint` — surfaced in the picker tooltip. */
  argumentHint?: string;
  /**
   * When true the raw `/name …` text is forwarded to claude.exe. When false
   * the local `clientHandler` runs instead (built-ins only — dynamic
   * commands are always pass-through).
   */
  passThrough: boolean;
  clientHandler?: (ctx: SlashCommandContext) => void | Promise<void>;
};

// Built-in commands. Order = display order in the BUILT-IN section of the
// picker. Keep this list deliberately tiny — the rule is "if the CLI can do
// it, let the CLI do it"; we only own commands whose effect is local to
// Agentory's own state.
export const BUILT_IN_COMMANDS: SlashCommand[] = [
  {
    name: 'clear',
    description: 'Start a new conversation and clear context',
    icon: Eraser,
    source: 'built-in',
    passThrough: false,
  },
  {
    name: 'compact',
    description: 'Summarize conversation to free context',
    icon: Minimize2,
    source: 'built-in',
    passThrough: true,
  },
];

// Parse a raw input line into a slash command + args. Returns null when the
// text is not a bare slash invocation (e.g., empty, no leading slash,
// multi-line first line, etc.). Whitespace-only args collapse to ''.
//
// Allowed name chars include `:` so plugin-namespaced commands like
// `/superpowers:brainstorm` parse correctly.
export function parseSlashInvocation(raw: string): { name: string; args: string } | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('/')) return null;
  const firstNewline = trimmed.indexOf('\n');
  if (firstNewline !== -1) return null;
  const body = trimmed.slice(1);
  if (!body) return null;
  const spaceIdx = body.search(/\s/);
  const name = spaceIdx === -1 ? body : body.slice(0, spaceIdx);
  const args = spaceIdx === -1 ? '' : body.slice(spaceIdx + 1).trim();
  if (!/^[a-zA-Z][a-zA-Z0-9_:.-]*$/.test(name)) return null;
  return { name, args };
}

// Look up a command by exact name. The caller passes in the *current*
// command list (built-ins ⊕ dynamic) so this stays a pure function.
export function findSlashCommand(
  all: SlashCommand[],
  name: string
): SlashCommand | undefined {
  return all.find((c) => c.name === name);
}

export type DispatchOutcome = 'handled' | 'pass-through' | 'unknown';

// Dispatch a parsed slash command. The caller passes the merged command
// list (built-ins ⊕ disk-discovered).
//
// - 'handled'      — local clientHandler ran; do NOT forward.
// - 'pass-through' — known dynamic / pass-through command; forward to claude.exe.
// - 'unknown'      — name doesn't match anything we know; caller decides
//                    (current InputBar still forwards so future CLI commands
//                    keep working before our registry catches up).
export async function dispatchSlashCommand(
  raw: string,
  all: SlashCommand[],
  ctx: SlashCommandContext
): Promise<DispatchOutcome> {
  const parsed = parseSlashInvocation(raw);
  if (!parsed) return 'unknown';
  const cmd = findSlashCommand(all, parsed.name);
  if (!cmd) return 'unknown';
  if (cmd.clientHandler) {
    await cmd.clientHandler({ ...ctx, args: parsed.args });
    return 'handled';
  }
  return cmd.passThrough ? 'pass-through' : 'handled';
}

// Pure filter used by the picker and unit tests. Matches a substring
// against both `name` and `description` (case-insensitive). Ranking puts
// exact name matches first, then prefix, then substring, then description
// hits — same scheme as before. `pluginId` is checked so typing a plugin
// prefix narrows the list correctly.
export function filterSlashCommands(all: SlashCommand[], query: string): SlashCommand[] {
  const q = query.trim().toLowerCase();
  if (!q) return all;
  type Ranked = { cmd: SlashCommand; rank: number; index: number };
  const ranked: Ranked[] = [];
  for (let i = 0; i < all.length; i++) {
    const c = all[i];
    const name = c.name.toLowerCase();
    const desc = (c.description ?? '').toLowerCase();
    let rank: number;
    if (name === q) rank = 0;
    else if (name.startsWith(q)) rank = 1;
    else if (name.includes(q)) rank = 2;
    else if (desc.includes(q)) rank = 3;
    else continue;
    ranked.push({ cmd: c, rank, index: i });
  }
  ranked.sort((a, b) => (a.rank - b.rank) || (a.index - b.index));
  return ranked.map((r) => r.cmd);
}

// Detects whether the textarea content is currently "typing a slash
// command" — i.e. it starts with `/` on the first line and the caret sits
// within that first token (no space encountered yet).
export type SlashTriggerState =
  | { active: false }
  | { active: true; query: string };

export function detectSlashTrigger(value: string, caret: number): SlashTriggerState {
  if (!value.startsWith('/')) return { active: false };
  const firstNewline = value.indexOf('\n');
  const firstLineEnd = firstNewline === -1 ? value.length : firstNewline;
  if (caret > firstLineEnd) return { active: false };
  const firstLine = value.slice(0, firstLineEnd);
  const firstSpace = firstLine.indexOf(' ');
  if (firstSpace !== -1) return { active: false };
  return { active: true, query: firstLine.slice(1) };
}

// ──────────────────── dynamic command loader (renderer) ────────────────────
//
// Wraps the IPC. Lives here (not in InputBar) so unit tests can stub the
// bridge directly via `window.agentory`. Returns an empty array — never
// throws — when the bridge is missing (browser-only probes) or the IPC
// call rejects.

export type DynamicCommand = {
  name: string;
  description?: string;
  argumentHint?: string;
  source: 'user' | 'project' | 'plugin';
  pluginId?: string;
};

export async function loadDynamicCommands(
  cwd: string | null | undefined
): Promise<SlashCommand[]> {
  const bridge = (typeof window !== 'undefined' ? window.agentory : undefined);
  if (!bridge?.commands?.list) return [];
  let raw: DynamicCommand[];
  try {
    raw = await bridge.commands.list(cwd ?? null);
  } catch (err) {
    console.warn('[slash] commands:list failed', err);
    return [];
  }
  return raw.map((d) => ({
    name: d.name,
    description: d.description,
    argumentHint: d.argumentHint,
    source: d.source,
    pluginId: d.pluginId,
    passThrough: true,
  }));
}

// Group commands for the picker. Stable order: built-in first, then user,
// project, plugin. Within each group preserves the input order.
export type SlashCommandGroup = {
  source: SlashCommandSource;
  commands: SlashCommand[];
};

export function groupSlashCommands(all: SlashCommand[]): SlashCommandGroup[] {
  const order: SlashCommandSource[] = ['built-in', 'user', 'project', 'plugin'];
  const buckets = new Map<SlashCommandSource, SlashCommand[]>();
  for (const src of order) buckets.set(src, []);
  for (const cmd of all) {
    const list = buckets.get(cmd.source);
    if (list) list.push(cmd);
  }
  return order
    .map((source) => ({ source, commands: buckets.get(source) ?? [] }))
    .filter((g) => g.commands.length > 0);
}
