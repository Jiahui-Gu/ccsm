import type {
  AssistantEvent,
  ClaudeStreamEvent,
  ContentBlock,
  ResultEvent,
  SystemEvent,
  ToolResultBlock,
  ToolUseBlock,
  UserEvent
} from '../../electron/agent/stream-json-types';
import type { MessageBlock, TodoItem } from '../types';
import { parseQuestions } from './ask-user-question';

export type ToolResultPatch = {
  toolUseId: string;
  result: string;
  isError: boolean;
};

export type StreamTranslation = {
  append: MessageBlock[];
  toolResults: ToolResultPatch[];
};

const EMPTY: StreamTranslation = { append: [], toolResults: [] };

export type AssistantStreamPatch = {
  blockId: string;
  appendText: string;
  done: boolean;
};

// Mirrors the SDK-era streamer but consumes stream_event frames coming straight
// from claude.exe stdout. The wire shape (message_start / content_block_delta /
// content_block_stop) is identical between SDK and direct spawn — the SDK was a
// pass-through for these — so the state machine is unchanged.
export class PartialAssistantStreamer {
  private currentMessageId: string | null = null;

  consume(msg: unknown): AssistantStreamPatch | null {
    const event = (msg as { event?: unknown } | null)?.event as
      | { type?: string; message?: { id?: unknown }; index?: number; delta?: { type?: string; text?: unknown } }
      | undefined;
    if (!event || typeof event !== 'object') return null;
    if (event.type === 'message_start') {
      const id = event.message?.id;
      this.currentMessageId = typeof id === 'string' ? id : null;
      return null;
    }
    if (event.type === 'message_stop') {
      this.currentMessageId = null;
      return null;
    }
    if (!this.currentMessageId) return null;
    if (event.type === 'content_block_delta') {
      const d = event.delta;
      if (!d || d.type !== 'text_delta') return null;
      const text = typeof d.text === 'string' ? d.text : '';
      if (!text) return null;
      return {
        blockId: `${this.currentMessageId}:c${event.index}`,
        appendText: text,
        done: false
      };
    }
    if (event.type === 'content_block_stop') {
      return {
        blockId: `${this.currentMessageId}:c${event.index}`,
        appendText: '',
        done: true
      };
    }
    return null;
  }
}

export function streamEventToTranslation(event: ClaudeStreamEvent | { type: string }): StreamTranslation {
  switch (event.type) {
    case 'assistant':
      return { append: assistantBlocksWithError(event as AssistantEvent), toolResults: [] };
    case 'user':
      return { append: [], toolResults: extractToolResults(event as UserEvent) };
    case 'system':
      return { append: systemBlocks(event as SystemEvent), toolResults: [] };
    case 'result':
      return { append: resultBlocks(event as ResultEvent), toolResults: [] };
    default:
      return EMPTY;
  }
}

function assistantBlocksWithError(msg: AssistantEvent): MessageBlock[] {
  const out = assistantBlocks(msg);
  const err = msg.error;
  if (err === 'rate_limit') {
    out.push({
      kind: 'status',
      id: `${msg.uuid ?? cryptoRandom()}:rate`,
      tone: 'warn',
      title: 'Rate limit hit',
      detail: 'The API is throttling this account. The next request will queue and retry.'
    });
  } else if (typeof err === 'string' && err) {
    out.push({
      kind: 'status',
      id: `${msg.uuid ?? cryptoRandom()}:err`,
      tone: 'warn',
      title: errorTitle(err),
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

function systemBlocks(msg: SystemEvent): MessageBlock[] {
  if (msg.subtype === 'compact_boundary') {
    const m = (msg as { compact_metadata?: { trigger?: string; pre_tokens?: number; post_tokens?: number; duration_ms?: number } }).compact_metadata ?? {};
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
    const m = msg as { attempt?: number; max_retries?: number; retry_delay_ms?: number; error_status?: number | string };
    const delay = typeof m.retry_delay_ms === 'number' ? Math.round(m.retry_delay_ms / 1000) : '?';
    const max = m.max_retries ?? '?';
    return [
      {
        kind: 'status',
        id: msg.uuid ?? cryptoRandom(),
        tone: 'warn',
        title: `Retrying API request (${m.attempt}/${max})`,
        detail: `Next attempt in ~${delay}s${m.error_status ? ` · HTTP ${m.error_status}` : ''}`
      }
    ];
  }
  return [];
}

function assistantBlocks(msg: AssistantEvent): MessageBlock[] {
  const out: MessageBlock[] = [];
  const baseId = msg.message?.id ?? msg.uuid ?? cryptoRandom();
  const content: ContentBlock[] = msg.message?.content ?? [];
  let toolIdx = 0;
  for (let idx = 0; idx < content.length; idx++) {
    const c = content[idx];
    if (c.type === 'text' && typeof c.text === 'string') {
      out.push({ kind: 'assistant', id: `${baseId}:c${idx}`, text: c.text });
    } else if (c.type === 'tool_use') {
      const tu = c as ToolUseBlock;
      if (tu.name === 'TodoWrite') {
        out.push({
          kind: 'todo',
          id: `${baseId}:tu${toolIdx++}`,
          toolUseId: tu.id,
          todos: parseTodos(tu.input)
        });
      } else if (tu.name === 'AskUserQuestion') {
        const questions = parseQuestions(tu.input);
        if (questions.length > 0) {
          out.push({
            kind: 'question',
            id: `${baseId}:tu${toolIdx++}`,
            toolUseId: tu.id,
            questions
          });
        } else {
          // Malformed AskUserQuestion input — fall back to a regular tool block
          // so the user at least sees the raw payload instead of nothing.
          out.push({
            kind: 'tool',
            id: `${baseId}:tu${toolIdx++}`,
            toolUseId: tu.id,
            name: tu.name,
            brief: briefForTool(tu.name, tu.input),
            expanded: false,
            input: tu.input
          });
        }
      } else {
        out.push({
          kind: 'tool',
          id: `${baseId}:tu${toolIdx++}`,
          toolUseId: tu.id,
          name: tu.name,
          brief: briefForTool(tu.name, tu.input),
          expanded: false,
          input: tu.input
        });
      }
    }
  }
  return out;
}

function extractToolResults(msg: UserEvent): ToolResultPatch[] {
  const content = msg.message?.content;
  if (!Array.isArray(content)) return [];
  const out: ToolResultPatch[] = [];
  for (const c of content) {
    if (!c || typeof c !== 'object' || (c as { type?: string }).type !== 'tool_result') continue;
    const tr = c as ToolResultBlock;
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

function resultBlocks(msg: ResultEvent): MessageBlock[] {
  if (msg.subtype === 'success' || msg.is_error === false) {
    return [resultStatsFooter(msg)];
  }
  const text = typeof msg.error === 'string' ? msg.error : msg.subtype ?? 'Run failed';
  return [{ kind: 'error', id: msg.uuid ?? cryptoRandom(), text }];
}

function resultStatsFooter(msg: ResultEvent): MessageBlock {
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

function briefForTool(_name: string, input: unknown): string {
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

function parseTodos(input: unknown): TodoItem[] {
  if (!input || typeof input !== 'object') return [];
  const raw = (input as { todos?: unknown }).todos;
  if (!Array.isArray(raw)) return [];
  const out: TodoItem[] = [];
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
