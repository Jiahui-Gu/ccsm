// Client-side handler for the one built-in command CCSM owns.
//
// `/clear` must reach into the renderer state machine to wipe the active
// session's transcript / queue / resume id without removing the session
// row. The CLI's own `/clear` only knows how to wipe its in-process
// context, so we run this locally and skip pass-through.
//
// `/compact` is pure pass-through — handled by the CLI itself.
//
// Importing this module attaches the handler as a side-effect, the same
// pattern as before. Tests import it for the same reason.

import { useStore } from '../stores/store';
import type { MessageBlock } from '../types';
import { BUILT_IN_COMMANDS, type SlashCommandContext } from './registry';

function nextId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

// ---------- /clear ----------
// Wipe the CURRENT session's conversation context (transcript, queue, stats,
// resume id) without removing the session row. Earlier implementations
// called `store.createSession(...)` here, which made the sidebar count jump
// by one on every /clear — surprising users into thinking the command
// misfired. Don't do that.
export function handleClear(ctx: SlashCommandContext): void {
  const store = useStore.getState();
  const session = store.sessions.find((s) => s.id === ctx.sessionId);
  if (!session) return;
  const wasRunning = !!store.runningSessions[ctx.sessionId];
  if (wasRunning) {
    void window.ccsm?.agentClose?.(ctx.sessionId);
  }
  store.resetSessionContext(ctx.sessionId);
  store.appendBlocks(ctx.sessionId, [
    {
      kind: 'status',
      id: nextId('clear'),
      tone: 'info',
      title: 'Context cleared',
      detail: 'Conversation history wiped. The next message starts a fresh turn.'
    }
  ]);
}

// Exported for tests that previously used it; flatten visible blocks into
// a plain-text transcript. Kept around because dropping it would be a
// pointless API churn for callers, and it's <30 LOC.
export function blocksToTranscript(blocks: MessageBlock[]): string {
  const lines: string[] = [];
  for (const b of blocks) {
    switch (b.kind) {
      case 'user':
        lines.push(`User: ${b.text}`);
        break;
      case 'assistant':
        lines.push(`Assistant: ${b.text}`);
        break;
      case 'tool':
        lines.push(`Tool(${b.name}): ${b.brief}${b.result ? `\n  → ${b.result.slice(0, 400)}` : ''}`);
        break;
      case 'todo':
        lines.push(`Todos: ${b.todos.map((t) => `[${t.status}] ${t.content}`).join('; ')}`);
        break;
      case 'status':
        lines.push(`(${b.tone}) ${b.title}${b.detail ? ` — ${b.detail}` : ''}`);
        break;
      case 'error':
        lines.push(`Error: ${b.text}`);
        break;
      case 'waiting':
      case 'question':
        // Ephemeral — skip.
        break;
    }
  }
  return lines.join('\n');
}

// ---------- /config ----------
// Open the Settings dialog. We can't import App-level React state here, so
// we dispatch a window CustomEvent that App.tsx listens for. This mirrors
// the upstream CLI's `/config` (which pops its inline config view) — in our
// Electron UI the analogous surface is the Radix Settings dialog. Defaults
// to the first tab; users can navigate from there.
export function handleConfig(_ctx: SlashCommandContext): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('ccsm:open-settings'));
}

// Attach the local handler as a module side-effect, same as before.
function attach(name: string, handler: (ctx: SlashCommandContext) => void | Promise<void>): void {
  const entry = BUILT_IN_COMMANDS.find((c) => c.name === name);
  if (entry) entry.clientHandler = handler;
}

attach('clear', handleClear);
attach('config', handleConfig);

// `/think` was removed when the StatusBar Thinking chip dropdown landed —
// the chip is the canonical surface (visible at all times, no need to
// open the slash picker first). Keeping the slash + Switch facsimile in
// parallel meant two entry points users had to learn for the same
// 5-state setting; we deleted the slash to keep one obvious door.
