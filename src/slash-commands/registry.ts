// Slash command registry.
//
// IMPORTANT: we do NOT interpret or execute these commands. This registry
// exists purely to drive the in-chat discoverability picker. When the user
// picks a command, we drop `/<name> ` into the textarea and let them hit
// Enter — the raw text (including the slash) is passed through to the
// underlying claude.exe process via the normal user-message path.
//
// Which commands actually *respond meaningfully* when sent through
// `--input-format stream-json` is a separate question (see PR body). For
// the picker, any command that the CLI exposes at a `/`-prompt is fair
// game to advertise.
import {
  HelpCircle,
  Eraser,
  Minimize2,
  Cpu,
  Settings,
  CircleDollarSign,
  History,
  Brain,
  FolderPlus,
  LogIn,
  LogOut,
  Activity,
  Stethoscope,
  Bug,
  Plug,
  Webhook,
  Users,
  FileSearch,
  type LucideIcon
} from 'lucide-react';

export type SlashCommandCategory = 'built-in' | 'skill';

// Context handed to a client-side handler. Intentionally minimal — we pass
// only what the current MVP handlers need; expand if a future command warrants
// it. Keep `sessionId` and `args` stable so tests can stub freely.
export type SlashCommandContext = {
  sessionId: string;
  args: string;
};

export type SlashCommand = {
  name: string;
  description: string;
  icon?: LucideIcon;
  category?: SlashCommandCategory;
  // When true the raw `/name …` text is forwarded to claude.exe as a user
  // message. When false the client handler owns execution and the command is
  // NOT forwarded (claude.exe would silently drop most of them in
  // --input-format stream-json anyway — see PR body for details).
  passThrough: boolean;
  // Optional client-side executor. If present the dispatcher prefers it over
  // pass-through regardless of `passThrough`, but convention is to set
  // `passThrough: false` whenever a handler exists.
  clientHandler?: (ctx: SlashCommandContext) => void | Promise<void>;
};

// Order = display order. Keep the most-used ones near the top.
// Names verified against `claude.exe` interactive REPL prompt (typing `/`).
//
// `passThrough: false` = we handle locally (see src/slash-commands/handlers.ts).
// `passThrough: true`  = forwarded to claude.exe via the normal message path.
//   Note: claude.exe in --input-format stream-json mode silently drops most
//   slash commands. We still forward them because (a) the list may grow or
//   be fixed upstream, and (b) silently eating the `/foo` text is less bad
//   than pretending it isn't a command.
export const SLASH_COMMANDS: SlashCommand[] = [
  { name: 'help',    description: 'List available commands',                       icon: HelpCircle,       category: 'built-in', passThrough: false },
  { name: 'clear',   description: 'Start a new conversation and clear context',    icon: Eraser,           category: 'built-in', passThrough: false },
  { name: 'compact', description: 'Summarize conversation to free context',        icon: Minimize2,        category: 'built-in', passThrough: false },
  { name: 'model',   description: 'Switch model for this session',                 icon: Cpu,              category: 'built-in', passThrough: false },
  { name: 'config',  description: 'Open settings',                                 icon: Settings,         category: 'built-in', passThrough: false },
  { name: 'cost',    description: 'Show session cost and token usage',             icon: CircleDollarSign, category: 'built-in', passThrough: false },
  { name: 'resume',  description: 'Resume a previous session',                     icon: History,          category: 'built-in', passThrough: true  },
  { name: 'memory',  description: 'Manage CLAUDE.md memory',                       icon: Brain,            category: 'built-in', passThrough: true  },
  { name: 'init',    description: 'Initialize CLAUDE.md in current project',       icon: FolderPlus,       category: 'built-in', passThrough: true  },
  { name: 'login',   description: 'Sign in to Claude',                             icon: LogIn,            category: 'built-in', passThrough: true  },
  { name: 'logout',  description: 'Sign out',                                      icon: LogOut,           category: 'built-in', passThrough: true  },
  { name: 'status',  description: 'Show auth and session status',                  icon: Activity,         category: 'built-in', passThrough: true  },
  { name: 'doctor',  description: 'Check installation health',                     icon: Stethoscope,      category: 'built-in', passThrough: true  },
  { name: 'bug',     description: 'Report a bug',                                  icon: Bug,              category: 'built-in', passThrough: true  },
  { name: 'mcp',     description: 'Manage MCP servers',                            icon: Plug,             category: 'built-in', passThrough: true  },
  { name: 'hooks',   description: 'Manage hooks',                                  icon: Webhook,          category: 'built-in', passThrough: true  },
  { name: 'agents',  description: 'Manage custom agents',                          icon: Users,            category: 'built-in', passThrough: true  },
  { name: 'review',  description: 'Review a pull request',                         icon: FileSearch,       category: 'built-in', passThrough: true  }
];

// Parse a raw input line into a slash command + args. Returns null when the
// text is not a bare slash invocation (e.g., empty, no leading slash,
// multi-line first line etc.). Whitespace-only args collapse to ''.
export function parseSlashInvocation(raw: string): { name: string; args: string } | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('/')) return null;
  // Must be a single-line invocation — a multi-line message starting with '/'
  // is almost certainly prose, not a command.
  const firstNewline = trimmed.indexOf('\n');
  if (firstNewline !== -1) return null;
  const body = trimmed.slice(1);
  if (!body) return null;
  const spaceIdx = body.search(/\s/);
  const name = spaceIdx === -1 ? body : body.slice(0, spaceIdx);
  const args = spaceIdx === -1 ? '' : body.slice(spaceIdx + 1).trim();
  if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(name)) return null;
  return { name, args };
}

// Look up a command by exact name. Returns undefined for unknown names —
// callers decide whether to pass an unknown `/foo` through to claude.exe.
export function findSlashCommand(name: string): SlashCommand | undefined {
  return SLASH_COMMANDS.find((c) => c.name === name);
}

// Dispatch a parsed slash command. Picks the client handler when one is
// registered, regardless of `passThrough` (handlers win). Returns:
//   - 'handled'      — handler ran (or is running async); caller must NOT forward.
//   - 'pass-through' — no handler registered; caller should forward raw text.
//   - 'unknown'      — name doesn't match any known command; caller decides.
export type DispatchOutcome = 'handled' | 'pass-through' | 'unknown';

export async function dispatchSlashCommand(
  raw: string,
  ctx: SlashCommandContext
): Promise<DispatchOutcome> {
  const parsed = parseSlashInvocation(raw);
  if (!parsed) return 'unknown';
  const cmd = findSlashCommand(parsed.name);
  if (!cmd) return 'unknown';
  if (cmd.clientHandler) {
    await cmd.clientHandler({ ...ctx, args: parsed.args });
    return 'handled';
  }
  return cmd.passThrough ? 'pass-through' : 'handled';
}

// Pure filter used by the picker and unit tests. Matches a substring against
// both `name` and `description` (case-insensitive). No fuzzy; MVP.
export function filterSlashCommands(all: SlashCommand[], query: string): SlashCommand[] {
  const q = query.trim().toLowerCase();
  if (!q) return all;
  return all.filter(
    (c) => c.name.toLowerCase().includes(q) || c.description.toLowerCase().includes(q)
  );
}

// Detects whether the textarea content is currently "typing a slash
// command" — i.e. it starts with `/` on the first line and the caret sits
// within that first token (no space encountered yet).
//
// Returns { active: true, query } if the picker should open, else
// { active: false }. Keeping this pure makes it trivial to unit test.
export type SlashTriggerState =
  | { active: false }
  | { active: true; query: string };

export function detectSlashTrigger(value: string, caret: number): SlashTriggerState {
  if (!value.startsWith('/')) return { active: false };
  // Must be on the first line — if the user has a multi-line message
  // starting with `/`, that's almost certainly a real message, not a
  // command.
  const firstNewline = value.indexOf('\n');
  const firstLineEnd = firstNewline === -1 ? value.length : firstNewline;
  // Caret must fall within the first line.
  if (caret > firstLineEnd) return { active: false };
  const firstLine = value.slice(0, firstLineEnd);
  // No space in the first line = still composing the command name.
  const firstSpace = firstLine.indexOf(' ');
  if (firstSpace !== -1) return { active: false };
  // query = everything after the leading `/` on the first line
  return { active: true, query: firstLine.slice(1) };
}
