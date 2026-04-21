import { describe, it, expect } from 'vitest';
import {
  PartialAssistantStreamer,
  streamEventToTranslation
} from '../src/agent/stream-to-blocks';

const asEvent = <T>(x: T) => x as unknown as Parameters<typeof streamEventToTranslation>[0];
const asPartial = <T>(x: T) => x as unknown as Parameters<PartialAssistantStreamer['consume']>[0];

describe('streamEventToTranslation', () => {
  it('drops user echoes (avoids dup with InputBar local echo)', () => {
    const out = streamEventToTranslation(
      asEvent({
        type: 'user',
        session_id: 's1',
        message: { role: 'user', content: [{ type: 'text', text: 'hello' }] }
      })
    );
    expect(out.append).toEqual([]);
    expect(out.toolResults).toEqual([]);
  });

  it('drops system init frames (no banner)', () => {
    const out = streamEventToTranslation(
      asEvent({ type: 'system', subtype: 'init', session_id: 's1' })
    );
    expect(out).toEqual({ append: [], toolResults: [] });
  });

  it('compact_boundary system message becomes an info status banner', () => {
    const out = streamEventToTranslation(
      asEvent({
        type: 'system',
        subtype: 'compact_boundary',
        uuid: 'sys-1',
        compact_metadata: { trigger: 'auto', pre_tokens: 124000, post_tokens: 18000, duration_ms: 950 }
      })
    );
    expect(out.append).toHaveLength(1);
    const b = out.append[0] as { kind: string; tone: string; title: string; detail?: string };
    expect(b.kind).toBe('status');
    expect(b.tone).toBe('info');
    expect(b.title).toMatch(/auto-compacted/i);
    expect(b.detail).toContain('124,000');
    expect(b.detail).toContain('18,000');
  });

  it('api_retry system message becomes a warn status banner with attempt + delay', () => {
    const out = streamEventToTranslation(
      asEvent({
        type: 'system',
        subtype: 'api_retry',
        uuid: 'sys-2',
        attempt: 2,
        max_retries: 5,
        retry_delay_ms: 4000,
        error_status: 503
      })
    );
    expect(out.append).toHaveLength(1);
    const b = out.append[0] as { tone: string; title: string; detail?: string };
    expect(b.tone).toBe('warn');
    expect(b.title).toContain('2/5');
    expect(b.detail).toContain('4s');
    expect(b.detail).toContain('503');
  });

  it('translates assistant text into one assistant block', () => {
    const out = streamEventToTranslation(
      asEvent({
        type: 'assistant',
        session_id: 's',
        uuid: 'msg-1',
        message: { id: 'm-id-1', role: 'assistant', content: [{ type: 'text', text: 'Sure.' }] }
      })
    );
    expect(out.append).toEqual([{ kind: 'assistant', id: 'm-id-1:c0', text: 'Sure.' }]);
  });

  it('assistant message with rate_limit error appends a rate-limit warn banner', () => {
    const out = streamEventToTranslation(
      asEvent({
        type: 'assistant',
        session_id: 's',
        uuid: 'asst-1',
        message: { id: 'm', role: 'assistant', content: [{ type: 'text', text: 'partial' }] },
        error: 'rate_limit'
      })
    );
    expect(out.append).toHaveLength(2);
    expect(out.append[1]).toMatchObject({ kind: 'status', tone: 'warn', title: 'Rate limit hit' });
  });

  it('assistant message with arbitrary error code emits a generic error banner', () => {
    const out = streamEventToTranslation(
      asEvent({
        type: 'assistant',
        session_id: 's',
        uuid: 'asst-2',
        message: { id: 'm', role: 'assistant', content: [] },
        error: 'authentication_failed'
      })
    );
    expect(out.append).toHaveLength(1);
    expect(out.append[0]).toMatchObject({
      kind: 'status',
      tone: 'warn',
      title: 'Authentication failed'
    });
  });

  it('translates tool_use into a tool block carrying toolUseId, name, brief', () => {
    const out = streamEventToTranslation(
      asEvent({
        type: 'assistant',
        session_id: 's',
        uuid: 'msg-2',
        message: {
          id: 'm-id-2',
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'toolu_001', name: 'Read', input: { file_path: '/a/b/c.ts' } }
          ]
        }
      })
    );
    expect(out.append).toHaveLength(1);
    expect(out.append[0]).toMatchObject({
      kind: 'tool',
      toolUseId: 'toolu_001',
      name: 'Read',
      brief: '/a/b/c.ts',
      expanded: false
    });
  });

  it('TodoWrite tool_use becomes a todo block (not generic tool)', () => {
    const out = streamEventToTranslation(
      asEvent({
        type: 'assistant',
        session_id: 's',
        uuid: 'msg-todo',
        message: {
          id: 'm-todo',
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'tu-1',
              name: 'TodoWrite',
              input: {
                todos: [
                  { content: 'Write tests', status: 'completed' },
                  { content: 'Implement', status: 'in_progress', activeForm: 'Implementing' }
                ]
              }
            }
          ]
        }
      })
    );
    expect(out.append).toHaveLength(1);
    const b = out.append[0] as { kind: string; todos?: Array<{ status: string; activeForm?: string }> };
    expect(b.kind).toBe('todo');
    expect(b.todos).toHaveLength(2);
    expect(b.todos![1].activeForm).toBe('Implementing');
  });

  it('extracts tool_result patches from user messages without appending blocks', () => {
    const out = streamEventToTranslation(
      asEvent({
        type: 'user',
        session_id: 's',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_001',
              content: [{ type: 'text', text: 'file contents here' }]
            }
          ]
        }
      })
    );
    expect(out.append).toEqual([]);
    expect(out.toolResults).toEqual([
      { toolUseId: 'toolu_001', result: 'file contents here', isError: false }
    ]);
  });

  it('flags is_error on tool_result patches with plain string content', () => {
    const out = streamEventToTranslation(
      asEvent({
        type: 'user',
        session_id: 's',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_002',
              content: 'permission denied',
              is_error: true
            }
          ]
        }
      })
    );
    expect(out.toolResults).toEqual([
      { toolUseId: 'toolu_002', result: 'permission denied', isError: true }
    ]);
  });

  it('joins multi-part text tool_result content', () => {
    const out = streamEventToTranslation(
      asEvent({
        type: 'user',
        session_id: 's',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_003',
              content: [
                { type: 'text', text: 'line one' },
                { type: 'text', text: 'line two' }
              ]
            }
          ]
        }
      })
    );
    expect(out.toolResults[0].result).toBe('line one\nline two');
  });

  it('successful result emits a stats footer', () => {
    const out = streamEventToTranslation(
      asEvent({
        type: 'result',
        subtype: 'success',
        is_error: false,
        session_id: 's',
        uuid: 'res-1',
        num_turns: 3,
        duration_ms: 12500,
        total_cost_usd: 0.0123,
        usage: { input_tokens: 4500, output_tokens: 1200, cache_read_input_tokens: 8000 }
      })
    );
    expect(out.append).toHaveLength(1);
    const b = out.append[0] as { kind: string; tone: string; title: string; detail?: string };
    expect(b.kind).toBe('status');
    expect(b.tone).toBe('info');
    expect(b.title).toBe('Done');
    expect(b.detail).toContain('3 turns');
    expect(b.detail).toContain('12.5s');
    expect(b.detail).toMatch(/13k in/);
    expect(b.detail).toContain('1.2k out');
    expect(b.detail).toContain('$0.012');
  });

  it('failed (abnormal end) result emits an error block', () => {
    const out = streamEventToTranslation(
      asEvent({
        type: 'result',
        subtype: 'error_max_turns',
        is_error: true,
        session_id: 's',
        uuid: 'res-err'
      })
    );
    expect(out.append).toHaveLength(1);
    expect(out.append[0]).toMatchObject({ kind: 'error' });
  });

  it('returns empty translation for unknown frame types', () => {
    const out = streamEventToTranslation(asEvent({ type: 'agent_metadata', agent_id: 'a' }));
    expect(out).toEqual({ append: [], toolResults: [] });
  });
});

function startEvent(messageId: string) {
  return asPartial({
    type: 'stream_event',
    event: { type: 'message_start', message: { id: messageId } }
  });
}
function deltaEvent(index: number, text: string) {
  return asPartial({
    type: 'stream_event',
    event: { type: 'content_block_delta', index, delta: { type: 'text_delta', text } }
  });
}
function stopBlock(index: number) {
  return asPartial({
    type: 'stream_event',
    event: { type: 'content_block_stop', index }
  });
}

describe('PartialAssistantStreamer (stream-json)', () => {
  it('emits one patch per text_delta keyed by message.id + content index', () => {
    const s = new PartialAssistantStreamer();
    s.consume(startEvent('msg-X'));
    expect(s.consume(deltaEvent(0, 'Hel'))).toEqual({
      blockId: 'msg-X:c0',
      appendText: 'Hel',
      done: false
    });
    expect(s.consume(deltaEvent(0, 'lo'))).toEqual({
      blockId: 'msg-X:c0',
      appendText: 'lo',
      done: false
    });
  });

  it('marks done on content_block_stop', () => {
    const s = new PartialAssistantStreamer();
    s.consume(startEvent('msg-X'));
    expect(s.consume(stopBlock(0))).toEqual({
      blockId: 'msg-X:c0',
      appendText: '',
      done: true
    });
  });

  it('returns null for deltas before message_start', () => {
    const s = new PartialAssistantStreamer();
    expect(s.consume(deltaEvent(0, 'leak'))).toBeNull();
  });

  it('clears state on message_stop and ignores subsequent deltas', () => {
    const s = new PartialAssistantStreamer();
    s.consume(startEvent('msg-X'));
    s.consume(asPartial({ type: 'stream_event', event: { type: 'message_stop' } }));
    expect(s.consume(deltaEvent(0, 'leak'))).toBeNull();
  });

  it('streamed block id matches the finalized assistant block id (so they coalesce)', () => {
    const s = new PartialAssistantStreamer();
    s.consume(startEvent('msg-Z'));
    const partial = s.consume(deltaEvent(0, 'Hi'));
    const final = streamEventToTranslation(
      asEvent({
        type: 'assistant',
        session_id: 's',
        uuid: 'sdk-uuid-Z',
        message: { id: 'msg-Z', role: 'assistant', content: [{ type: 'text', text: 'Hi there' }] }
      })
    );
    expect(partial?.blockId).toBe((final.append[0] as { id: string }).id);
  });

  it('ignores non-text deltas (input_json, thinking)', () => {
    const s = new PartialAssistantStreamer();
    s.consume(startEvent('msg-X'));
    expect(
      s.consume(
        asPartial({
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            index: 1,
            delta: { type: 'input_json_delta', partial_json: '{"x"' }
          }
        })
      )
    ).toBeNull();
  });
});
