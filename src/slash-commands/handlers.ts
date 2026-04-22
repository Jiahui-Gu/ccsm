// Client-side implementations for the slash commands listed in
// src/slash-commands/registry.ts. Importing this module as a side-effect
// attaches `clientHandler` to the relevant SLASH_COMMANDS entries; the
// dispatcher in registry.ts then prefers them over pass-through.
//
// Keep each handler small and inject dependencies through the single
// SlashCommandContext argument; tests mock the store and window.agentory
// directly (see tests/slash-commands-handlers.test.ts).

import { useStore } from '../stores/store';
import type { MessageBlock } from '../types';
import { SLASH_COMMANDS, type SlashCommandContext } from './registry';
import { openSettings } from './ui-bridge';
import { triggerPrFlow } from '../lib/pr-flow';

function nextId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function appendStatus(
  sessionId: string,
  title: string,
  detail?: string,
  tone: 'info' | 'warn' = 'info'
): void {
  useStore.getState().appendBlocks(sessionId, [
    { kind: 'status', id: nextId('local'), tone, title, detail }
  ]);
}

function appendError(sessionId: string, text: string): void {
  useStore.getState().appendBlocks(sessionId, [
    { kind: 'error', id: nextId('local-err'), text }
  ]);
}

function formatTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function formatCost(usd: number): string {
  if (usd <= 0) return '$0';
  return `$${usd.toFixed(usd < 0.01 ? 4 : 3)}`;
}

// ---------- /clear ----------
// Create a fresh session in the same group and switch to it. The old session
// gets an info banner so the user has a breadcrumb if they want to flip back.
export function handleClear(ctx: SlashCommandContext): void {
  const store = useStore.getState();
  const current = store.sessions.find((s) => s.id === ctx.sessionId);
  // Leave a breadcrumb in the OLD session before switching away.
  store.appendBlocks(ctx.sessionId, [
    { kind: 'status', id: nextId('clear'), tone: 'info', title: 'New session created', detail: 'Context cleared — switched to a fresh session.' }
  ]);
  // `createSession` picks the focused / active group automatically and flips
  // activeId. We don't need to pass cwd — it'll inherit from the active
  // session's recent projects / defaults. If we DO know the old cwd though,
  // use it so the fresh session starts in the same folder.
  store.createSession(current?.cwd ?? null);
}

// ---------- /cost ----------
// Render a local info banner with cumulative token / cost counters sourced
// from statsBySession (aggregated in agent/lifecycle on each `result` frame).
export function handleCost(ctx: SlashCommandContext): void {
  const stats = useStore.getState().statsBySession[ctx.sessionId];
  if (!stats || (stats.turns === 0 && stats.inputTokens === 0 && stats.outputTokens === 0)) {
    appendStatus(ctx.sessionId, 'No cost data yet', 'Send a message first to see token usage.');
    return;
  }
  const parts: string[] = [];
  parts.push(`${stats.turns} turn${stats.turns === 1 ? '' : 's'}`);
  parts.push(`${formatTokens(stats.inputTokens)} in / ${formatTokens(stats.outputTokens)} out`);
  if (stats.costUsd > 0) parts.push(formatCost(stats.costUsd));
  appendStatus(ctx.sessionId, 'Session cost', parts.join(' · '));
}

// ---------- /config ----------
export function handleConfig(_ctx: SlashCommandContext): void {
  openSettings('appearance');
}

// ---------- /model ----------
// No in-chat model dropdown exposed yet; route to the Connection tab where
// the model defaults live.
export function handleModel(_ctx: SlashCommandContext): void {
  openSettings('connection');
}

// ---------- /help ----------
// Render a local info banner listing the registry with short descriptions.
// Grouped by category; client-handled commands get a `(client)` suffix so
// users can tell them apart from pass-through ones.
export function handleHelp(ctx: SlashCommandContext): void {
  const groups = new Map<string, Array<{ name: string; description: string; client: boolean }>>();
  for (const cmd of SLASH_COMMANDS) {
    const cat = cmd.category ?? 'built-in';
    const list = groups.get(cat) ?? [];
    list.push({
      name: cmd.name,
      description: cmd.description,
      client: !!cmd.clientHandler
    });
    groups.set(cat, list);
  }
  const lines: string[] = [];
  for (const [cat, list] of groups) {
    lines.push(`[${cat}]`);
    for (const c of list) {
      const mark = c.client ? ' ⚠' : '';
      const tag = c.client ? 'client' : 'passthru';
      lines.push(`  /${c.name}${mark}  (${tag})  — ${c.description}`);
    }
  }
  lines.push('');
  lines.push('Commands starting with ⚠ are client-side only; others pass through to claude.exe and may be ignored in non-interactive mode.');
  appendStatus(ctx.sessionId, 'Slash commands', lines.join('\n'));
}

// ---------- /compact ----------
// Pass-through to claude.exe. The Agent SDK natively handles `/compact` when
// sent as a prompt in stream-json mode — see
// https://code.claude.com/docs/en/agent-sdk/slash-commands. The CLI emits a
// `system { subtype: 'compact_boundary', compact_metadata }` frame which our
// systemBlocks() translator already renders as a status banner ("Conversation
// compacted (manual) — Compacted N → M tokens in T ms"). No client-side work
// needed; we just trust the SDK and let the existing translator surface it.
//
// `blocksToTranscript` is still exported below for tests and future reuse.

// Exported for tests; also used by /compact. Flattens the visible message
// blocks into a plain-text transcript the model can chew on.
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
        // These are ephemeral — skip.
        break;
    }
  }
  return lines.join('\n');
}

// ---------- /pr ----------
// Owned end-to-end by PrFlowProvider — preflight, Radix form, gh pr create,
// CI polling. This handler just fires the trigger the provider registered
// on mount. If the provider isn't mounted (e.g. early in boot), surface an
// error block so the user knows why nothing happened.
export function handlePr(ctx: SlashCommandContext): void {
  const dispatched = triggerPrFlow(ctx.sessionId);
  if (!dispatched) {
    appendError(
      ctx.sessionId,
      '/pr flow is not available (PrFlowProvider not mounted).'
    );
  }
}

// Attach handlers to registry entries. Module side-effect; imported once by
// the app bootstrap (src/index.tsx or wherever we kick things off) and once
// by the unit tests that exercise dispatch.
function attach(name: string, handler: (ctx: SlashCommandContext) => void | Promise<void>): void {
  const entry = SLASH_COMMANDS.find((c) => c.name === name);
  if (entry) entry.clientHandler = handler;
}

attach('clear', handleClear);
attach('cost', handleCost);
attach('config', handleConfig);
attach('model', handleModel);
attach('help', handleHelp);
attach('pr', handlePr);
