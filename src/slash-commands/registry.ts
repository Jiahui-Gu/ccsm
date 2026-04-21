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

export type SlashCommand = {
  name: string;
  description: string;
  icon?: LucideIcon;
  category?: SlashCommandCategory;
};

// Order = display order. Keep the most-used ones near the top.
// Names verified against `claude.exe` interactive REPL prompt (typing `/`).
export const SLASH_COMMANDS: SlashCommand[] = [
  { name: 'help',    description: 'List available commands',                       icon: HelpCircle,       category: 'built-in' },
  { name: 'clear',   description: 'Start a new conversation and clear context',    icon: Eraser,           category: 'built-in' },
  { name: 'compact', description: 'Summarize conversation to free context',        icon: Minimize2,        category: 'built-in' },
  { name: 'model',   description: 'Switch model for this session',                 icon: Cpu,              category: 'built-in' },
  { name: 'config',  description: 'Open settings',                                 icon: Settings,         category: 'built-in' },
  { name: 'cost',    description: 'Show session cost and token usage',             icon: CircleDollarSign, category: 'built-in' },
  { name: 'resume',  description: 'Resume a previous session',                     icon: History,          category: 'built-in' },
  { name: 'memory',  description: 'Manage CLAUDE.md memory',                       icon: Brain,            category: 'built-in' },
  { name: 'init',    description: 'Initialize CLAUDE.md in current project',       icon: FolderPlus,       category: 'built-in' },
  { name: 'login',   description: 'Sign in to Claude',                             icon: LogIn,            category: 'built-in' },
  { name: 'logout',  description: 'Sign out',                                      icon: LogOut,           category: 'built-in' },
  { name: 'status',  description: 'Show auth and session status',                  icon: Activity,         category: 'built-in' },
  { name: 'doctor',  description: 'Check installation health',                     icon: Stethoscope,      category: 'built-in' },
  { name: 'bug',     description: 'Report a bug',                                  icon: Bug,              category: 'built-in' },
  { name: 'mcp',     description: 'Manage MCP servers',                            icon: Plug,             category: 'built-in' },
  { name: 'hooks',   description: 'Manage hooks',                                  icon: Webhook,          category: 'built-in' },
  { name: 'agents',  description: 'Manage custom agents',                          icon: Users,            category: 'built-in' },
  { name: 'review',  description: 'Review a pull request',                         icon: FileSearch,       category: 'built-in' }
];

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
