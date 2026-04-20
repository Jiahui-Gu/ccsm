import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { MessageBlock } from '../types';

// Translate one SDK message into zero or more MessageBlocks for ChatStream.
// Tool calls become collapsed `tool` blocks (result wired up later when the
// matching tool_result user message arrives — for MVP we keep tool + result
// in separate blocks rather than reconciling, which keeps this fn pure).
export function sdkMessageToBlocks(msg: SDKMessage): MessageBlock[] {
  switch (msg.type) {
    case 'assistant':
      return assistantBlocks(msg);
    case 'user':
      // We render the user's outgoing text locally in InputBar for zero-latency
      // echo. The SDK echoes the same text back as a user message — skip it to
      // avoid duplicates. Tool_result echoes also live in user messages but
      // those don't render as separate turns either (the tool block carries
      // the result).
      return [];
    case 'system':
      // SDK system messages (init, compact_boundary, api_retry, …) carry no
      // user-visible chat content; surfacing them as chat blocks would be noise.
      return [];
    case 'result':
      return resultBlocks(msg);
    default:
      return [];
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
        name: tu.name,
        brief: briefForTool(tu.name, tu.input),
        expanded: false
      });
    }
  }
  return out;
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
  // Cheap-but-useful summary per common tool. Truncate hard.
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
