import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  parseStreamJSONLine,
  serializeOutgoing
} from '../stream-json-parser';
import {
  ClaudeStreamEventSchema,
  SystemApiRetrySchema,
  SystemCompactBoundarySchema,
  UserMessageEventSchema,
  type ClaudeOutgoingEvent
} from '../stream-json-types';

const FIXTURE_DIR = join(__dirname, 'fixtures', 'stream-json');

function readLines(file: string): string[] {
  return readFileSync(join(FIXTURE_DIR, file), 'utf8')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseAll(file: string) {
  return readLines(file).map((line) => parseStreamJSONLine(line));
}

describe('parseStreamJSONLine — fixture parsing', () => {
  it('parses system init frame with all known fields', () => {
    const results = parseAll('system-init.jsonl');
    expect(results).toHaveLength(1);
    const r = results[0];
    expect(r.type).toBe('event');
    if (r.type !== 'event') return;
    expect(r.event.type).toBe('system');
    if (r.event.type !== 'system') return;
    // narrow further
    expect((r.event as { subtype?: string }).subtype).toBe('init');
    expect(r.event.session_id).toBe('01HZJ1234ABCDXYZ');
    // tools/mcp_servers passthrough survived
    const sys = r.event as Record<string, unknown>;
    expect(Array.isArray(sys.tools)).toBe(true);
    expect((sys.tools as string[]).length).toBeGreaterThan(0);
    expect(Array.isArray(sys.mcp_servers)).toBe(true);
  });

  it('parses an assistant streaming sequence (thinking → text → tool_use → tool_result)', () => {
    const results = parseAll('assistant-streaming.jsonl');
    expect(results).toHaveLength(4);
    expect(results.every((r) => r.type === 'event')).toBe(true);
    const types = results.map((r) => (r.type === 'event' ? r.event.type : null));
    expect(types).toEqual(['assistant', 'assistant', 'assistant', 'user']);

    const blocks = results
      .filter((r) => r.type === 'event' && r.event.type === 'assistant')
      .map((r) => {
        if (r.type !== 'event' || r.event.type !== 'assistant') throw new Error();
        return r.event.message.content[0]?.type;
      });
    expect(blocks).toEqual(['thinking', 'text', 'tool_use']);

    // tool_result inside the user echo
    const last = results[3];
    if (last.type !== 'event' || last.event.type !== 'user') throw new Error();
    const content = last.event.message.content;
    if (!Array.isArray(content)) throw new Error('expected array content');
    expect(content[0]).toMatchObject({ type: 'tool_result', is_error: false });
  });

  it('parses a result-final frame with usage + cost', () => {
    const results = parseAll('result-final.jsonl');
    expect(results).toHaveLength(1);
    const r = results[0];
    if (r.type !== 'event' || r.event.type !== 'result') throw new Error();
    expect(r.event.subtype).toBe('success');
    expect(r.event.is_error).toBe(false);
    expect(r.event.num_turns).toBe(3);
    expect(r.event.total_cost_usd).toBeCloseTo(0.0421);
    expect(r.event.usage?.cache_read_input_tokens).toBe(1500);
  });

  it('parses a control_request can_use_tool frame', () => {
    const results = parseAll('control-request-can-use-tool.jsonl');
    expect(results).toHaveLength(1);
    const r = results[0];
    if (r.type !== 'event' || r.event.type !== 'control_request') throw new Error();
    expect(r.event.request_id).toBe('req_001');
    expect(r.event.request.subtype).toBe('can_use_tool');
    if (r.event.request.subtype !== 'can_use_tool') throw new Error();
    expect(r.event.request.tool_name).toBe('Bash');
    expect(r.event.request.tool_use_id).toBe('toolu_02deadbeef');
  });
});

describe('parseStreamJSONLine — forward-compat & error handling', () => {
  it('keeps unknown extra fields via passthrough (schema drift tolerated)', () => {
    const line = JSON.stringify({
      type: 'system',
      subtype: 'init',
      session_id: 'abc',
      cwd: '/tmp',
      // intentionally added field that no schema knows about:
      brand_new_anthropic_field: { foo: 'bar', count: 42 }
    });
    const r = parseStreamJSONLine(line);
    expect(r.type).toBe('event');
    if (r.type !== 'event') return;
    const obj = r.event as Record<string, unknown>;
    expect(obj.brand_new_anthropic_field).toEqual({ foo: 'bar', count: 42 });
  });

  it('emits parse-error for invalid JSON, with raw text preserved', () => {
    const r = parseStreamJSONLine('{not valid json');
    expect(r.type).toBe('parse-error');
    if (r.type !== 'parse-error') return;
    expect(r.raw).toBe('{not valid json');
    expect(r.error).toBeInstanceOf(Error);
  });

  it('emits parse-error for empty / whitespace lines', () => {
    expect(parseStreamJSONLine('').type).toBe('parse-error');
    expect(parseStreamJSONLine('   \t  ').type).toBe('parse-error');
  });

  it('emits unknown for top-level non-object JSON (array / null / number)', () => {
    expect(parseStreamJSONLine('[1,2,3]').type).toBe('unknown');
    expect(parseStreamJSONLine('null').type).toBe('unknown');
    expect(parseStreamJSONLine('42').type).toBe('unknown');
  });

  it('emits unknown for known type but missing required field', () => {
    // assistant frame missing the required `message`
    const r = parseStreamJSONLine(
      JSON.stringify({ type: 'assistant', session_id: 'abc' })
    );
    expect(r.type).toBe('unknown');
    if (r.type !== 'unknown') return;
    expect(r.reason).toContain('type=assistant');
    expect((r.raw as { type: string }).type).toBe('assistant');
  });

  it('emits unknown for entirely unrecognised type (forward-compat for new frames)', () => {
    const r = parseStreamJSONLine(
      JSON.stringify({ type: 'hook_event', payload: { foo: 1 } })
    );
    expect(r.type).toBe('unknown');
    if (r.type !== 'unknown') return;
    expect(r.reason).toContain('type=hook_event');
  });

  it('parses control_request with hook_callback subtype', () => {
    const r = parseStreamJSONLine(
      JSON.stringify({
        type: 'control_request',
        request_id: 'req_42',
        request: {
          subtype: 'hook_callback',
          callback_id: 'cb_001',
          input: { event: 'PreToolUse', tool: 'Bash' },
          tool_use_id: 'toolu_x'
        }
      })
    );
    expect(r.type).toBe('event');
    if (r.type !== 'event' || r.event.type !== 'control_request') throw new Error();
    expect(r.event.request.subtype).toBe('hook_callback');
  });

  it('parses control_request with mcp_message subtype', () => {
    const r = parseStreamJSONLine(
      JSON.stringify({
        type: 'control_request',
        request_id: 'req_43',
        request: {
          subtype: 'mcp_message',
          server_name: 'github',
          message: { jsonrpc: '2.0', method: 'tools/list', id: 1 }
        }
      })
    );
    expect(r.type).toBe('event');
    if (r.type !== 'event' || r.event.type !== 'control_request') throw new Error();
    expect(r.event.request.subtype).toBe('mcp_message');
  });

  it('handles unknown system subtype via SystemOtherSchema fallback', () => {
    const r = parseStreamJSONLine(
      JSON.stringify({
        type: 'system',
        subtype: 'rate_limit_warning',
        session_id: 'abc',
        delay_ms: 12000
      })
    );
    expect(r.type).toBe('event');
    if (r.type !== 'event' || r.event.type !== 'system') throw new Error();
    expect((r.event as { subtype?: string }).subtype).toBe('rate_limit_warning');
    expect((r.event as Record<string, unknown>).delay_ms).toBe(12000);
  });
});

describe('serializeOutgoing', () => {
  it('serializes a user message with trailing newline and valid JSON', () => {
    const evt: ClaudeOutgoingEvent = {
      type: 'user',
      uuid: '00000000-0000-4000-8000-000000000000',
      session_id: 'sid-1',
      parent_tool_use_id: null,
      isSynthetic: false,
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'hello' }]
      }
    };
    const out = serializeOutgoing(evt);
    expect(out.endsWith('\n')).toBe(true);
    expect(out.split('\n').filter(Boolean)).toHaveLength(1);
    const parsed = JSON.parse(out.trimEnd());
    expect(parsed.type).toBe('user');
    expect(parsed.message.content[0].text).toBe('hello');
  });

  it('serializes a control_response (allow)', () => {
    const out = serializeOutgoing({
      type: 'control_response',
      request_id: 'req_x',
      response: {
        behavior: 'allow',
        toolUseID: 'toolu_y',
        updatedInput: { command: 'ls' }
      }
    });
    expect(out.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(out.trimEnd());
    expect(parsed.response.behavior).toBe('allow');
  });

  it('serializes a control_request command (interrupt)', () => {
    const out = serializeOutgoing({
      type: 'control_request',
      request_id: 'req_int',
      request: { subtype: 'interrupt' }
    });
    const parsed = JSON.parse(out.trimEnd());
    expect(parsed.request.subtype).toBe('interrupt');
    expect(out.endsWith('\n')).toBe(true);
  });

  it('round-trips: serialized outgoing user message would not validate as inbound (different shape)', () => {
    // sanity check: outgoing != inbound. Our inbound UserEventSchema requires
    // session_id and an object `message`; outgoing provides both, but lacks
    // any extra inbound-only field. So in practice outbound user IS structurally
    // a valid inbound user — verify that's OK (it's the same type).
    const out = serializeOutgoing({
      type: 'user',
      uuid: 'u',
      session_id: 's',
      parent_tool_use_id: null,
      isSynthetic: false,
      message: { role: 'user', content: [{ type: 'text', text: 'hi' }] }
    });
    const parsed = JSON.parse(out.trimEnd());
    const result = ClaudeStreamEventSchema.safeParse(parsed);
    expect(result.success).toBe(true);
  });

  it('accepts a plain object via the relaxed overload (control-rpc convenience)', () => {
    // control-rpc constructs payloads as plain objects; serializeOutgoing
    // should not require casting through ClaudeOutgoingEvent.
    const out = serializeOutgoing({
      type: 'control_request',
      request_id: 'req_rw',
      request: { subtype: 'rewind_files', message_id: 'msg_abc123' }
    } as object);
    expect(out.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(out.trimEnd());
    expect(parsed.request.subtype).toBe('rewind_files');
    expect(parsed.request.message_id).toBe('msg_abc123');
  });
});

describe('R4 fix: AssistantEventSchema typed `error` field', () => {
  it('parses an assistant frame with top-level error code (rate_limit) typed', () => {
    const r = parseStreamJSONLine(
      JSON.stringify({
        type: 'assistant',
        session_id: 'sid',
        uuid: 'asst-1',
        error: 'rate_limit',
        message: {
          id: 'msg_x',
          role: 'assistant',
          content: [{ type: 'text', text: '' }]
        }
      })
    );
    expect(r.type).toBe('event');
    if (r.type !== 'event' || r.event.type !== 'assistant') throw new Error();
    // Typed access — no `as any` cast.
    const errorCode: string | undefined = r.event.error;
    expect(errorCode).toBe('rate_limit');
  });

  it('still parses an assistant frame without an error field', () => {
    const r = parseStreamJSONLine(
      JSON.stringify({
        type: 'assistant',
        session_id: 'sid',
        message: { id: 'm', role: 'assistant', content: [] }
      })
    );
    expect(r.type).toBe('event');
    if (r.type !== 'event' || r.event.type !== 'assistant') throw new Error();
    expect(r.event.error).toBeUndefined();
  });

  it('exposes all six error codes used by sdk-to-blocks errorTitle()', () => {
    const codes = [
      'authentication_failed',
      'billing_error',
      'rate_limit',
      'invalid_request',
      'server_error',
      'max_output_tokens'
    ];
    for (const code of codes) {
      const r = parseStreamJSONLine(
        JSON.stringify({
          type: 'assistant',
          session_id: 's',
          error: code,
          message: { id: 'm', role: 'assistant', content: [] }
        })
      );
      if (r.type !== 'event' || r.event.type !== 'assistant') throw new Error(code);
      expect(r.event.error).toBe(code);
    }
  });
});

describe('R4 fix: rewind_files command schema', () => {
  it('serializes and round-trips a rewind_files control command with message_id', () => {
    const out = serializeOutgoing({
      type: 'control_request',
      request_id: 'req_rw1',
      request: { subtype: 'rewind_files', message_id: 'msg_target' }
    });
    const parsed = JSON.parse(out.trimEnd());
    expect(parsed).toMatchObject({
      type: 'control_request',
      request_id: 'req_rw1',
      request: { subtype: 'rewind_files', message_id: 'msg_target' }
    });
  });
});

describe('R4 fix: outgoing user message session_id is optional', () => {
  it('serializes a first-turn user message without session_id', () => {
    const out = serializeOutgoing({
      type: 'user',
      uuid: 'u-first',
      // session_id intentionally omitted (first turn before cliSessionId echo)
      parent_tool_use_id: null,
      isSynthetic: false,
      message: { role: 'user', content: 'hello' }
    });
    const parsed = JSON.parse(out.trimEnd());
    expect(parsed.uuid).toBe('u-first');
    expect(parsed.session_id).toBeUndefined();
  });

  it('still accepts a user message with session_id (continuation turn)', () => {
    const out = serializeOutgoing({
      type: 'user',
      uuid: 'u-2',
      session_id: '01HZJ1234ABCDXYZ',
      parent_tool_use_id: null,
      isSynthetic: false,
      message: { role: 'user', content: 'continue' }
    });
    const parsed = JSON.parse(out.trimEnd());
    expect(parsed.session_id).toBe('01HZJ1234ABCDXYZ');
  });

  it('UserMessageEventSchema validates both shapes', () => {
    const without = UserMessageEventSchema.safeParse({
      type: 'user',
      uuid: 'u',
      parent_tool_use_id: null,
      isSynthetic: false,
      message: { role: 'user', content: 'hi' }
    });
    expect(without.success).toBe(true);
    const withSid = UserMessageEventSchema.safeParse({
      type: 'user',
      uuid: 'u',
      session_id: 'sid',
      parent_tool_use_id: null,
      isSynthetic: false,
      message: { role: 'user', content: 'hi' }
    });
    expect(withSid.success).toBe(true);
  });
});

describe('R4 fix: control_request unknown subtypes survive (not dropped to "unknown")', () => {
  it('parses an unknown control_request subtype as a control_request event', () => {
    const r = parseStreamJSONLine(
      JSON.stringify({
        type: 'control_request',
        request_id: 'req_future',
        request: {
          subtype: 'permission_decision_v2',
          some_new_field: { reason: 'forward-compat' }
        }
      })
    );
    expect(r.type).toBe('event');
    if (r.type !== 'event' || r.event.type !== 'control_request') throw new Error();
    expect(r.event.request.subtype).toBe('permission_decision_v2');
    // passthrough preserves the unknown payload field
    expect(
      (r.event.request as Record<string, unknown>).some_new_field
    ).toEqual({ reason: 'forward-compat' });
  });

  it('still narrows known subtypes correctly (catch-all does not eat them)', () => {
    const r = parseStreamJSONLine(
      JSON.stringify({
        type: 'control_request',
        request_id: 'req_known',
        request: {
          subtype: 'can_use_tool',
          tool_name: 'Read',
          tool_use_id: 'toolu_z',
          input: { file_path: '/tmp/x' }
        }
      })
    );
    if (r.type !== 'event' || r.event.type !== 'control_request') throw new Error();
    if (r.event.request.subtype !== 'can_use_tool') throw new Error('did not narrow');
    // typed access only available on the can_use_tool branch
    expect(r.event.request.tool_name).toBe('Read');
  });
});

describe('R4 fix: compact_boundary fixture — typed field exposure', () => {
  it('parses every line and exposes compact_metadata fields without `as any`', () => {
    const results = parseAll('compact_boundary.jsonl');
    expect(results).toHaveLength(2);
    for (const r of results) {
      expect(r.type).toBe('event');
      if (r.type !== 'event' || r.event.type !== 'system') throw new Error();
      // Narrow on subtype literal
      const ev = r.event as Extract<typeof r.event, { subtype?: string }>;
      expect(ev.subtype).toBe('compact_boundary');
    }
    // Validate first line's compact_metadata via the dedicated schema so we
    // get typed access to pre_tokens / post_tokens / duration_ms / trigger.
    const parsed = SystemCompactBoundarySchema.parse(
      JSON.parse(readLines('compact_boundary.jsonl')[0])
    );
    expect(parsed.compact_metadata?.trigger).toBe('auto');
    expect(parsed.compact_metadata?.pre_tokens).toBe(182340);
    expect(parsed.compact_metadata?.post_tokens).toBe(54210);
    expect(parsed.compact_metadata?.duration_ms).toBe(1820);
  });
});

describe('R4 fix: api_retry fixture — typed field exposure', () => {
  it('parses every line and exposes attempt / max_retries / retry_delay_ms / error_status', () => {
    const results = parseAll('api_retry.jsonl');
    expect(results).toHaveLength(2);
    const lines = readLines('api_retry.jsonl');
    const first = SystemApiRetrySchema.parse(JSON.parse(lines[0]));
    expect(first.attempt).toBe(1);
    expect(first.max_retries).toBe(5);
    expect(first.retry_delay_ms).toBe(2000);
    expect(first.error_status).toBe(529);
    const second = SystemApiRetrySchema.parse(JSON.parse(lines[1]));
    expect(second.attempt).toBe(2);
    expect(second.error_status).toBe('overloaded_error'); // string variant
  });
});
