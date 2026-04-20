import { describe, it, expect } from 'vitest';
import { sdkMessageToTranslation } from '../src/agent/sdk-to-blocks';

// Minimal SDKMessage shapes — the production type is broad and we only need
// the fields the translator actually inspects. Cast through unknown to avoid
// having to mock the entire SDK type surface.
const asSdk = <T>(x: T) => x as unknown as Parameters<typeof sdkMessageToTranslation>[0];

describe('sdkMessageToTranslation', () => {
  it('drops user echoes (avoids dup with InputBar local echo)', () => {
    const out = sdkMessageToTranslation(
      asSdk({
        type: 'user',
        message: { content: [{ type: 'text', text: 'hello' }] }
      })
    );
    expect(out.append).toEqual([]);
    expect(out.toolResults).toEqual([]);
  });

  it('drops unknown system subtypes (init etc.)', () => {
    const out = sdkMessageToTranslation(asSdk({ type: 'system', subtype: 'init' }));
    expect(out.append).toEqual([]);
    expect(out.toolResults).toEqual([]);
  });

  it('compact_boundary system message becomes an info status banner', () => {
    const out = sdkMessageToTranslation(
      asSdk({
        type: 'system',
        subtype: 'compact_boundary',
        uuid: 'sys-1',
        compact_metadata: { trigger: 'auto', pre_tokens: 124000, post_tokens: 18000, duration_ms: 950 }
      })
    );
    expect(out.append).toHaveLength(1);
    expect(out.append[0]).toMatchObject({ kind: 'status', tone: 'info' });
    const b = out.append[0] as { title: string; detail?: string };
    expect(b.title).toMatch(/auto-compacted/i);
    expect(b.detail).toContain('124,000');
    expect(b.detail).toContain('18,000');
  });

  it('api_retry system message becomes a warn status banner with attempt + delay', () => {
    const out = sdkMessageToTranslation(
      asSdk({
        type: 'system',
        subtype: 'api_retry',
        uuid: 'sys-2',
        attempt: 2,
        max_retries: 5,
        retry_delay_ms: 4000,
        error_status: 503,
        error: 'server_error'
      })
    );
    expect(out.append).toHaveLength(1);
    const b = out.append[0] as { tone: string; title: string; detail?: string };
    expect(b.tone).toBe('warn');
    expect(b.title).toContain('2/5');
    expect(b.detail).toContain('4s');
    expect(b.detail).toContain('503');
  });

  it('assistant message with rate_limit error appends a rate-limit warn banner', () => {
    const out = sdkMessageToTranslation(
      asSdk({
        type: 'assistant',
        uuid: 'asst-1',
        message: { id: 'm', content: [{ type: 'text', text: 'partial' }] },
        error: 'rate_limit'
      })
    );
    // text block + status banner
    expect(out.append).toHaveLength(2);
    expect(out.append[1]).toMatchObject({ kind: 'status', tone: 'warn', title: 'Rate limit hit' });
  });

  it('drops successful result messages (no noise on completion)', () => {
    const out = sdkMessageToTranslation(
      asSdk({ type: 'result', subtype: 'success', is_error: false })
    );
    expect(out.append).toEqual([]);
  });

  it('emits an error block on failed result', () => {
    const out = sdkMessageToTranslation(
      asSdk({ type: 'result', subtype: 'error_max_turns', is_error: true })
    );
    expect(out.append).toHaveLength(1);
    expect(out.append[0]).toMatchObject({ kind: 'error' });
  });

  it('translates assistant text into one assistant block', () => {
    const out = sdkMessageToTranslation(
      asSdk({
        type: 'assistant',
        uuid: 'msg-1',
        message: { content: [{ type: 'text', text: 'Sure, here is the plan.' }] }
      })
    );
    expect(out.append).toEqual([
      { kind: 'assistant', id: 'msg-1:t0', text: 'Sure, here is the plan.' }
    ]);
  });

  it('translates tool_use into a tool block carrying toolUseId, name, brief', () => {
    const out = sdkMessageToTranslation(
      asSdk({
        type: 'assistant',
        uuid: 'msg-2',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'toolu_001',
              name: 'Read',
              input: { file_path: '/a/b/c.ts' }
            }
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

  it('splits mixed text + tool_use into separate blocks in order', () => {
    const out = sdkMessageToTranslation(
      asSdk({
        type: 'assistant',
        uuid: 'msg-3',
        message: {
          content: [
            { type: 'text', text: 'Looking now.' },
            { type: 'tool_use', id: 'toolu_002', name: 'Bash', input: { command: 'ls -la' } },
            { type: 'text', text: 'Done.' }
          ]
        }
      })
    );
    expect(out.append).toHaveLength(3);
    expect(out.append.map((b) => b.kind)).toEqual(['assistant', 'tool', 'assistant']);
    expect(out.append[1]).toMatchObject({ name: 'Bash', brief: 'ls -la', toolUseId: 'toolu_002' });
  });

  it('extracts tool_result patches from user messages without appending blocks', () => {
    const out = sdkMessageToTranslation(
      asSdk({
        type: 'user',
        message: {
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

  it('flags is_error on tool_result patches', () => {
    const out = sdkMessageToTranslation(
      asSdk({
        type: 'user',
        message: {
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
    const out = sdkMessageToTranslation(
      asSdk({
        type: 'user',
        message: {
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

  it('truncates long brief to 80 chars with ellipsis', () => {
    const longCmd = 'a'.repeat(200);
    const out = sdkMessageToTranslation(
      asSdk({
        type: 'assistant',
        uuid: 'msg-4',
        message: {
          content: [{ type: 'tool_use', id: 'toolu_004', name: 'Bash', input: { command: longCmd } }]
        }
      })
    );
    const brief = (out.append[0] as { brief: string }).brief;
    expect(brief.length).toBe(78); // 77 chars + ellipsis
    expect(brief.endsWith('…')).toBe(true);
  });

  it('falls back to JSON.stringify for unknown tool input shape', () => {
    const out = sdkMessageToTranslation(
      asSdk({
        type: 'assistant',
        uuid: 'msg-5',
        message: {
          content: [{ type: 'tool_use', id: 'toolu_005', name: 'Custom', input: { weird: 42 } }]
        }
      })
    );
    expect((out.append[0] as { brief: string }).brief).toBe('{"weird":42}');
  });

  it('returns empty translation for unknown SDK message types', () => {
    const out = sdkMessageToTranslation(asSdk({ type: 'mystery' }));
    expect(out).toEqual({ append: [], toolResults: [] });
  });
});
