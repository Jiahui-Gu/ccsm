import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { MessageBlock } from '../types';

export type ToolResultPatch = {
  toolUseId: string;
  result: string;
  isError: boolean;
};

export type SdkTranslation = {
  append: MessageBlock[];
  toolResults: ToolResultPatch[];
};

const EMPTY: SdkTranslation = { append: [], toolResults: [] };

export function sdkMessageToTranslation(msg: SDKMessage): SdkTranslation {
  switch (msg.type) {
    case 'assistant':
      return { append: assistantBlocksWithError(msg), toolResults: [] };
    case 'user':
      return { append: [], toolResults: extractToolResults(msg) };
    case 'system':
      return { append: systemBlocks(msg), toolResults: [] };
    case 'result':
      return { append: resultBlocks(msg), toolResults: [] };
    default:
      return EMPTY;
  }
}

function assistantBlocksWithError(msg: any): MessageBlock[] {
  const out = assistantBlocks(msg);
  if (msg.error === 'rate_limit') {
    out.push({
      kind: 'status',
      id: `${msg.uuid ?? cryptoRandom()}:rate`,
      tone: 'warn',
      title: 'Rate limit hit',
      detail: 'The API is throttling this account. The next request will queue and retry.'
    });
  } else if (typeof msg.error === 'string' && msg.error) {
    out.push({
      kind: 'status',
      id: `${msg.uuid ?? cryptoRandom()}:err`,
      tone: 'warn',
      title: errorTitle(msg.error),
      detail: undefined
    });
  }
  return out;
}

function errorTitle(code: string): string {
  switch (code) {
    case 'authentication_failed': return 'Authentication failed';
    case 'billing_error': return 'Billing error';
    case 'rate_limit': return 'Rate limit hit';
    case 'invalid_request': return 'Invalid request';
    case 'server_error': return 'Server error';
    case 'max_output_tokens': return 'Hit max output tokens';
    default: return 'Assistant error';
  }
}

function systemBlocks(msg: any): MessageBlock[] {
  if (msg.subtype === 'compact_boundary') {
    const m = msg.compact_metadata ?? {};
    const detail = m.pre_tokens
      ? `Compacted ${m.pre_tokens.toLocaleString()} → ${m.post_tokens?.toLocaleString() ?? '?'} tokens` +
        (m.duration_ms ? ` in ${m.duration_ms}ms` : '')
      : undefined;
    return [
      {
        kind: 'status',
        id: msg.uuid ?? cryptoRandom(),
        tone: 'info',
        title: m.trigger === 'manual' ? 'Conversation compacted (manual)' : 'Conversation auto-compacted',
        detail
      }
    ];
  }
  if (msg.subtype === 'api_retry') {
    const delay = typeof msg.retry_delay_ms === 'number' ? Math.round(msg.retry_delay_ms / 1000) : '?';
    const max = msg.max_retries ?? '?';
    return [
      {
        kind: 'status',
        id: msg.uuid ?? cryptoRandom(),
        tone: 'warn',
        title: `Retrying API request (${msg.attempt}/${max})`,
        detail: `Next attempt in ~${delay}s${msg.error_status ? ` · HTTP ${msg.error_status}` : ''}`
      }
    ];
  }
  return [];
}

type AnyContent =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: unknown; is_error?: boolean }
  | { type: string; [k: string]: unknown };

function assistantBlocks(msg: any): MessageBlock[] {
  const out: MessageBlock[] = [];
  const baseId = msg.uuid ?? msg.message?.id ?? cryptoRandom();
  const content: AnyContent[] = msg.message?.content ?? [];
  let textIdx = 0;
  let toolIdx = 0;
  for (const c of content) {
    if (c.type === 'text' && typeof (c as { text: string }).text === 'string') {
      out.push({ kind: 'assistant', id: `${baseId}:t${textIdx++}`, text: (c as { text: string }).text });
    } else if (c.type === 'tool_use') {
      const tu = c as { id: string; name: string; input: unknown };
      if (tu.name === 'TodoWrite') {
        const todos = parseTodos(tu.input);
        out.push({
          kind: 'todo',
          id: `${baseId}:tu${toolIdx++}`,
          toolUseId: tu.id,
          todos
        });
      } else {
        out.push({
          kind: 'tool',
          id: `${baseId}:tu${toolIdx++}`,
          toolUseId: tu.id,
          name: tu.name,
          brief: briefForTool(tu.name, tu.input),
          expanded: false
        });
      }
    }
  }
  return out;
}

function extractToolResults(msg: any): ToolResultPatch[] {
  const content: AnyContent[] = msg.message?.content ?? [];
  if (!Array.isArray(content)) return [];
  const out: ToolResultPatch[] = [];
  for (const c of content) {
    if (c.type !== 'tool_result') continue;
    const tr = c as { tool_use_id: string; content: unknown; is_error?: boolean };
    out.push({
      toolUseId: tr.tool_use_id,
      result: stringifyToolResult(tr.content),
      isError: tr.is_error === true
    });
  }
  return out;
}

function stringifyToolResult(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return JSON.stringify(content ?? '', null, 2);
  // SDK tool_result.content is typically an array of {type:'text', text:string} parts.
  const parts: string[] = [];
  for (const part of content) {
    if (part && typeof part === 'object' && (part as { type?: string }).type === 'text') {
      const t = (part as { text?: unknown }).text;
      if (typeof t === 'string') parts.push(t);
    } else {
      parts.push(JSON.stringify(part));
    }
  }
  return parts.join('\n');
}

function resultBlocks(msg: any): MessageBlock[] {
  if (msg.subtype === 'success' || msg.is_error === false) {
    return [resultStatsFooter(msg)];
  }
  const text = typeof msg.error === 'string' ? msg.error : msg.subtype ?? 'Run failed';
  return [{ kind: 'error', id: msg.uuid ?? cryptoRandom(), text }];
}

function resultStatsFooter(msg: any): MessageBlock {
  const parts: string[] = [];
  if (typeof msg.num_turns === 'number') parts.push(`${msg.num_turns} turn${msg.num_turns === 1 ? '' : 's'}`);
  if (typeof msg.duration_ms === 'number') parts.push(formatDuration(msg.duration_ms));
  const usage = msg.usage ?? {};
  const inTok = (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
  const outTok = usage.output_tokens ?? 0;
  if (inTok || outTok) {
    parts.push(`${formatTokens(inTok)} in / ${formatTokens(outTok)} out`);
  }
  if (typeof msg.total_cost_usd === 'number' && msg.total_cost_usd > 0) {
    parts.push(`$${msg.total_cost_usd.toFixed(msg.total_cost_usd < 0.01 ? 4 : 3)}`);
  }
  return {
    kind: 'status',
    id: msg.uuid ?? cryptoRandom(),
    tone: 'info',
    title: 'Done',
    detail: parts.join(' · ')
  };
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s - m * 60);
  return `${m}m${rem}s`;
}

function formatTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function briefForTool(name: string, input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const i = input as Record<string, unknown>;
  const pick = (...keys: string[]): string => {
    for (const k of keys) {
      const v = i[k];
      if (typeof v === 'string') return v;
    }
    return '';
  };
  const v =
    pick('file_path', 'path', 'pattern', 'command', 'query', 'url', 'description') || JSON.stringify(input);
  return v.length > 80 ? v.slice(0, 77) + '…' : v;
}

function cryptoRandom(): string {
  return Math.random().toString(36).slice(2, 10);
}

function parseTodos(input: unknown): import('../types').TodoItem[] {
  if (!input || typeof input !== 'object') return [];
  const raw = (input as { todos?: unknown }).todos;
  if (!Array.isArray(raw)) return [];
  const out: import('../types').TodoItem[] = [];
  for (const t of raw) {
    if (!t || typeof t !== 'object') continue;
    const o = t as Record<string, unknown>;
    const content = typeof o.content === 'string' ? o.content : '';
    if (!content) continue;
    const status = o.status === 'in_progress' || o.status === 'completed' ? o.status : 'pending';
    out.push({
      content,
      status,
      activeForm: typeof o.activeForm === 'string' ? o.activeForm : undefined
    });
  }
  return out;
}
