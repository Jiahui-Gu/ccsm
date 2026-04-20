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
      return { append: assistantBlocks(msg), toolResults: [] };
    case 'user':
      return { append: [], toolResults: extractToolResults(msg) };
    case 'system':
      return EMPTY;
    case 'result':
      return { append: resultBlocks(msg), toolResults: [] };
    default:
      return EMPTY;
  }
}

type AnyContent =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: unknown; is_error?: boolean }
  | { type: string; [k: string]: unknown };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
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
  return out;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function resultBlocks(msg: any): MessageBlock[] {
  if (msg.subtype === 'success' || msg.is_error === false) return [];
  const text = typeof msg.error === 'string' ? msg.error : msg.subtype ?? 'Run failed';
  return [{ kind: 'error', id: msg.uuid ?? cryptoRandom(), text }];
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
