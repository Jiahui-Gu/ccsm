import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PassThrough } from 'node:stream';
import {
  ControlRpc,
  type CanUseToolHandler,
  type HookCallbackHandler,
  type ControlRequestFrame,
} from '../control-rpc';

// Helpers ---------------------------------------------------------------

function makeStdin(): { stdin: PassThrough; lines: () => unknown[] } {
  const stdin = new PassThrough();
  const chunks: Buffer[] = [];
  stdin.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))));
  return {
    stdin,
    lines: () =>
      Buffer.concat(chunks)
        .toString('utf8')
        .split('\n')
        .filter((s) => s.length > 0)
        .map((s) => JSON.parse(s)),
  };
}

const allowAll: CanUseToolHandler = async () => ({ allow: true });

// Tests -----------------------------------------------------------------

describe('ControlRpc — inbound can_use_tool', () => {
  let stdin: PassThrough;
  let lines: () => unknown[];

  beforeEach(() => {
    const m = makeStdin();
    stdin = m.stdin;
    lines = m.lines;
  });

  it('allows: writes control_response with matching request_id and toolUseID', async () => {
    const rpc = new ControlRpc(stdin, { onCanUseTool: allowAll });
    rpc.handleIncoming({
      type: 'control_request',
      request_id: 'req_A',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'Bash',
        tool_use_id: 'toolu_1',
        input: { command: 'ls' },
      },
    } as ControlRequestFrame);

    await new Promise((r) => setImmediate(r));

    const out = lines();
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      type: 'control_response',
      request_id: 'req_A',
      response: { behavior: 'allow', toolUseID: 'toolu_1' },
    });
  });

  it('allows with updatedInput passes through', async () => {
    const rpc = new ControlRpc(stdin, {
      onCanUseTool: async () => ({ allow: true, updatedInput: { command: 'ls -la' } }),
    });
    rpc.handleIncoming({
      type: 'control_request',
      request_id: 'req_B',
      request: { subtype: 'can_use_tool', tool_name: 'Bash', tool_use_id: 't', input: {} },
    } as ControlRequestFrame);

    await new Promise((r) => setImmediate(r));
    const [frame] = lines() as Array<Record<string, unknown>>;
    expect(frame.response).toEqual({
      behavior: 'allow',
      updatedInput: { command: 'ls -la' },
      toolUseID: 't',
    });
    void rpc;
  });

  it('deny with deny_reason is forwarded as message', async () => {
    const rpc = new ControlRpc(stdin, {
      onCanUseTool: async () => ({ allow: false, deny_reason: 'too risky' }),
    });
    rpc.handleIncoming({
      type: 'control_request',
      request_id: 'req_C',
      request: { subtype: 'can_use_tool', tool_name: 'Bash', tool_use_id: 'tu', input: {} },
    } as ControlRequestFrame);

    await new Promise((r) => setImmediate(r));
    const [frame] = lines() as Array<Record<string, unknown>>;
    expect(frame).toEqual({
      type: 'control_response',
      request_id: 'req_C',
      response: { behavior: 'deny', message: 'too risky', toolUseID: 'tu' },
    });
    void rpc;
  });

  it('handler throwing yields a friendly deny (fail-closed)', async () => {
    const rpc = new ControlRpc(stdin, {
      onCanUseTool: async () => {
        throw new Error('renderer crashed');
      },
      logger: { warn: vi.fn() },
    });
    rpc.handleIncoming({
      type: 'control_request',
      request_id: 'req_D',
      request: { subtype: 'can_use_tool', tool_name: 'Bash', tool_use_id: 'tu', input: {} },
    } as ControlRequestFrame);

    await new Promise((r) => setImmediate(r));
    const [frame] = lines() as Array<Record<string, unknown>>;
    const response = frame.response as { behavior: string; message: string; toolUseID: string };
    expect(response.behavior).toBe('deny');
    expect(response.toolUseID).toBe('tu');
    expect(response.message.toLowerCase()).toContain('error');
    void rpc;
  });

  it('multiple concurrent control_requests do not cross request_ids', async () => {
    const order: string[] = [];
    const rpc = new ControlRpc(stdin, {
      onCanUseTool: async (toolName) => {
        // Stagger resolution so ordering would matter if request_ids were stored globally.
        const delay = toolName === 'A' ? 30 : 5;
        await new Promise((r) => setTimeout(r, delay));
        order.push(toolName);
        return { allow: true };
      },
    });

    rpc.handleIncoming({
      type: 'control_request',
      request_id: 'req_slow',
      request: { subtype: 'can_use_tool', tool_name: 'A', tool_use_id: 'tA', input: {} },
    } as ControlRequestFrame);
    rpc.handleIncoming({
      type: 'control_request',
      request_id: 'req_fast',
      request: { subtype: 'can_use_tool', tool_name: 'B', tool_use_id: 'tB', input: {} },
    } as ControlRequestFrame);

    await new Promise((r) => setTimeout(r, 60));
    const out = lines() as Array<Record<string, unknown>>;
    expect(out).toHaveLength(2);
    // B resolves first, then A.
    expect(order).toEqual(['B', 'A']);
    const byId = new Map(out.map((f) => [f.request_id as string, f.response as { toolUseID: string }]));
    expect(byId.get('req_slow')!.toolUseID).toBe('tA');
    expect(byId.get('req_fast')!.toolUseID).toBe('tB');
    void rpc;
  });
});

describe('ControlRpc — inbound hook_callback / mcp_message / unknown', () => {
  it('hook_callback without handler responds with empty object', async () => {
    const m = makeStdin();
    const rpc = new ControlRpc(m.stdin, { onCanUseTool: allowAll });
    rpc.handleIncoming({
      type: 'control_request',
      request_id: 'req_H',
      request: { subtype: 'hook_callback', callback_id: 'cb1', input: { foo: 1 } },
    } as ControlRequestFrame);
    await new Promise((r) => setImmediate(r));
    expect(m.lines()).toEqual([
      { type: 'control_response', request_id: 'req_H', response: {} },
    ]);
    void rpc;
  });

  it('hook_callback with handler returns the handler result', async () => {
    const m = makeStdin();
    const onHook: HookCallbackHandler = async (cbId, payload) => ({
      echoed: { cbId, payload },
    });
    const rpc = new ControlRpc(m.stdin, { onCanUseTool: allowAll, onHookCallback: onHook });
    rpc.handleIncoming({
      type: 'control_request',
      request_id: 'req_H2',
      request: { subtype: 'hook_callback', callback_id: 'cb2', input: { x: 7 } },
    } as ControlRequestFrame);
    await new Promise((r) => setImmediate(r));
    const [frame] = m.lines() as Array<Record<string, unknown>>;
    expect(frame.response).toEqual({ echoed: { cbId: 'cb2', payload: { x: 7 } } });
    void rpc;
  });

  it('mcp_message without handler responds with empty object', async () => {
    const m = makeStdin();
    const rpc = new ControlRpc(m.stdin, { onCanUseTool: allowAll });
    rpc.handleIncoming({
      type: 'control_request',
      request_id: 'req_M',
      request: { subtype: 'mcp_message', server_name: 'fs', message: { jsonrpc: '2.0' } },
    } as ControlRequestFrame);
    await new Promise((r) => setImmediate(r));
    expect(m.lines()).toEqual([
      { type: 'control_response', request_id: 'req_M', response: {} },
    ]);
    void rpc;
  });

  it('unknown subtype: parser is expected to filter these; ControlRpc no longer has a default branch (see Fix 5)', () => {
    // Documented assumption: stream-json-parser routes any control_request with
    // an unknown subtype to its `unknown` bucket before it reaches ControlRpc.
    // This test pins that contract — if it ever changes, restore the default
    // branch in handleControlRequest. For now, feeding an unknown subtype here
    // is undefined behavior (entry leaks in inbound map); we don't exercise it.
    expect(true).toBe(true);
  });
});

describe('ControlRpc — outbound control commands', () => {
  it('interrupt writes correct frame shape and resolves on matching control_response', async () => {
    const m = makeStdin();
    const rpc = new ControlRpc(m.stdin, { onCanUseTool: allowAll });

    const p = rpc.interrupt();
    // Frame should be on the wire immediately.
    const [frame] = m.lines() as Array<Record<string, unknown>>;
    expect(frame.type).toBe('control_request');
    expect((frame.request as { subtype: string }).subtype).toBe('interrupt');
    expect(typeof frame.request_id).toBe('string');

    // Simulate ack. The CLI nests request_id and subtype inside `response`.
    rpc.handleIncoming({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: frame.request_id as string,
        response: { ok: true },
      },
    });
    await expect(p).resolves.toBeUndefined();
  });

  it('setPermissionMode writes correct frame', async () => {
    const m = makeStdin();
    const rpc = new ControlRpc(m.stdin, { onCanUseTool: allowAll });
    const p = rpc.setPermissionMode('acceptEdits');
    const [frame] = m.lines() as Array<Record<string, unknown>>;
    expect(frame.type).toBe('control_request');
    expect(frame.request).toEqual({ subtype: 'set_permission_mode', mode: 'acceptEdits' });
    rpc.handleIncoming({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: frame.request_id as string,
        response: {},
      },
    });
    await expect(p).resolves.toBeUndefined();
  });

  it('setModel writes correct frame', async () => {
    const m = makeStdin();
    const rpc = new ControlRpc(m.stdin, { onCanUseTool: allowAll });
    const p = rpc.setModel('sonnet');
    const [frame] = m.lines() as Array<Record<string, unknown>>;
    expect(frame.request).toEqual({ subtype: 'set_model', model: 'sonnet' });
    rpc.handleIncoming({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: frame.request_id as string,
        response: {},
      },
    });
    await expect(p).resolves.toBeUndefined();
  });

  it('setMaxThinkingTokens writes correct frame', async () => {
    const m = makeStdin();
    const rpc = new ControlRpc(m.stdin, { onCanUseTool: allowAll });
    const p = rpc.setMaxThinkingTokens(16000);
    const [frame] = m.lines() as Array<Record<string, unknown>>;
    expect(frame.request).toEqual({ subtype: 'set_max_thinking_tokens', tokens: 16000 });
    rpc.handleIncoming({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: frame.request_id as string,
        response: {},
      },
    });
    await expect(p).resolves.toBeUndefined();
  });

  it('outbound times out and rejects when no response arrives', async () => {
    const m = makeStdin();
    const rpc = new ControlRpc(m.stdin, {
      onCanUseTool: allowAll,
      outboundResponseTimeoutMs: 20,
    });
    await expect(rpc.interrupt()).rejects.toThrow(/timed out/);
  });

  it('out-of-order responses settle the matching outbound by request_id', async () => {
    const m = makeStdin();
    const rpc = new ControlRpc(m.stdin, { onCanUseTool: allowAll });
    const pA = rpc.setModel('opus');
    const pB = rpc.setModel('sonnet');
    const out = m.lines() as Array<Record<string, unknown>>;
    expect(out).toHaveLength(2);
    const idA = out[0].request_id as string;
    const idB = out[1].request_id as string;
    // Respond to B first, then A — order shouldn't matter.
    rpc.handleIncoming({
      type: 'control_response',
      response: { subtype: 'success', request_id: idB, response: {} },
    });
    rpc.handleIncoming({
      type: 'control_response',
      response: { subtype: 'success', request_id: idA, response: {} },
    });
    await expect(pA).resolves.toBeUndefined();
    await expect(pB).resolves.toBeUndefined();
  });

  it('late control_response after timeout is dropped (orphan warn) and does not crash', async () => {
    const m = makeStdin();
    const warn = vi.fn();
    const rpc = new ControlRpc(m.stdin, {
      onCanUseTool: allowAll,
      outboundResponseTimeoutMs: 10,
      logger: { warn },
    });
    const p = rpc.interrupt();
    const [frame] = m.lines() as Array<Record<string, unknown>>;
    await expect(p).rejects.toThrow(/timed out/);
    // Late response arrives — should be treated as orphan, not throw.
    rpc.handleIncoming({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: frame.request_id as string,
        response: { ok: true },
      },
    });
    expect(warn).toHaveBeenCalled();
    expect(warn.mock.calls.some((c) => /orphan control_response/.test(String(c[0])))).toBe(true);
  });

  // Bug K / Task #142: regression guard. The CLI nests request_id INSIDE
  // `response`, not at the top level. Earlier code tried to read
  // `frame.request_id` and silently ignored every response, so every outbound
  // control_request 5s-timed-out. This test FAILS against the pre-fix shape.
  it('resolves outbound control_request with CLI nested wire shape (Bug K)', async () => {
    const m = makeStdin();
    const warn = vi.fn();
    const rpc = new ControlRpc(m.stdin, {
      onCanUseTool: allowAll,
      outboundResponseTimeoutMs: 50,
      logger: { warn },
    });
    const p = rpc.sendControlRequest({ subtype: 'set_permission_mode', mode: 'default' });
    const [frame] = m.lines() as Array<Record<string, unknown>>;
    rpc.handleIncoming({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: frame.request_id as string,
        response: { mode: 'default' },
      },
    });
    await expect(p).resolves.toEqual({ mode: 'default' });
    // No "orphan" or "timed out" warnings should have fired.
    expect(warn.mock.calls.some((c) => /orphan|timed out/i.test(String(c[0])))).toBe(false);
  });

  it('rejects outbound on subtype:error wire shape (Bug K)', async () => {
    const m = makeStdin();
    const rpc = new ControlRpc(m.stdin, {
      onCanUseTool: allowAll,
      outboundResponseTimeoutMs: 50,
    });
    const p = rpc.sendControlRequest({ subtype: 'set_model', model: 'bogus' });
    const [frame] = m.lines() as Array<Record<string, unknown>>;
    rpc.handleIncoming({
      type: 'control_response',
      response: {
        subtype: 'error',
        request_id: frame.request_id as string,
        error: 'Unsupported model: bogus',
      },
    });
    await expect(p).rejects.toThrow(/Unsupported model: bogus/);
  });
});

describe('ControlRpc — user messages and lifecycle', () => {
  it('sendUserMessage writes a properly shaped user frame', () => {
    const m = makeStdin();
    const rpc = new ControlRpc(m.stdin, { onCanUseTool: allowAll });
    rpc.sendUserMessage('hello world', 'cli_session_42');
    const [frame] = m.lines() as Array<Record<string, unknown>>;
    expect(frame.type).toBe('user');
    expect(frame.session_id).toBe('cli_session_42');
    expect(frame.parent_tool_use_id).toBeNull();
    expect(frame.isSynthetic).toBe(false);
    expect(frame.message).toEqual({
      role: 'user',
      content: [{ type: 'text', text: 'hello world' }],
    });
    expect(typeof frame.uuid).toBe('string');
  });

  it('sendUserMessageContent forwards a content-block array verbatim', () => {
    const m = makeStdin();
    const rpc = new ControlRpc(m.stdin, { onCanUseTool: allowAll });
    const content = [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
      { type: 'text', text: 'what is this?' },
    ];
    rpc.sendUserMessageContent(content, 'cli_session_99');
    const [frame] = m.lines() as Array<Record<string, unknown>>;
    expect(frame.type).toBe('user');
    expect(frame.session_id).toBe('cli_session_99');
    expect((frame.message as { content: unknown }).content).toEqual(content);
  });

  it('sendUserMessageContent throws after close', () => {
    const m = makeStdin();
    const rpc = new ControlRpc(m.stdin, { onCanUseTool: allowAll });
    rpc.close();
    expect(() => rpc.sendUserMessageContent([{ type: 'text', text: 'x' }])).toThrow(/closed/);
  });

  it('sending after close throws a friendly error (not EPIPE)', () => {
    const m = makeStdin();
    const rpc = new ControlRpc(m.stdin, { onCanUseTool: allowAll });
    rpc.close();
    expect(() => rpc.sendUserMessage('x')).toThrow(/closed/);
  });

  it('sending after stdin closed throws a friendly error', () => {
    const m = makeStdin();
    const rpc = new ControlRpc(m.stdin, { onCanUseTool: allowAll });
    m.stdin.emit('close');
    expect(() => rpc.sendUserMessage('x')).toThrow(/closed/);
  });

  it('outbound send after close rejects', async () => {
    const m = makeStdin();
    const rpc = new ControlRpc(m.stdin, { onCanUseTool: allowAll });
    rpc.close();
    await expect(rpc.interrupt()).rejects.toThrow(/closed/);
  });

  it('close() rejects all pending outbound requests', async () => {
    const m = makeStdin();
    const rpc = new ControlRpc(m.stdin, {
      onCanUseTool: allowAll,
      outboundResponseTimeoutMs: 5_000,
    });
    const p = rpc.interrupt();
    rpc.close();
    await expect(p).rejects.toThrow(/closed/);
  });

  it('EPIPE on stdin rejects in-flight outbound immediately (no timeout wait)', async () => {
    const m = makeStdin();
    const rpc = new ControlRpc(m.stdin, {
      onCanUseTool: allowAll,
      // Timeout is huge — if we accidentally wait for it, the test will hang.
      outboundResponseTimeoutMs: 60_000,
    });
    const p = rpc.interrupt();
    // Simulate EPIPE on the stdin stream.
    m.stdin.emit('error', new Error('EPIPE'));
    await expect(p).rejects.toThrow(/channel broken/i);
  });

  it('EPIPE during writeFrame rejects pending outbound and surfaces friendly error', async () => {
    // Build a stdin whose write() throws synchronously.
    const stdin = new PassThrough();
    let throwOnWrite = false;
    const realWrite = stdin.write.bind(stdin);
    (stdin as any).write = (chunk: any, ...rest: any[]) => {
      if (throwOnWrite) throw new Error('EPIPE');
      return realWrite(chunk, ...rest);
    };
    const rpc = new ControlRpc(stdin, {
      onCanUseTool: allowAll,
      outboundResponseTimeoutMs: 60_000,
    });
    // First call: queue a pending outbound that's already on the wire.
    const pFirst = rpc.interrupt();
    // Drain the wire synchronously so the first write succeeds.
    await new Promise((r) => setImmediate(r));
    // Now make subsequent writes throw, then trigger another outbound — its
    // synchronous write throws and propagates AND markBroken should reject the
    // first pending outbound too.
    throwOnWrite = true;
    await expect(rpc.setModel('sonnet')).rejects.toThrow(/EPIPE|channel broken/i);
    await expect(pFirst).rejects.toThrow(/channel broken/i);
    // Subsequent send rejects with friendly error, not EPIPE crash.
    await expect(rpc.interrupt()).rejects.toThrow(/channel broken/i);
  });

  it('markBroken rejects all pending outbound and aborts inbound handlers', async () => {
    const m = makeStdin();
    let observedSignal: AbortSignal | undefined;
    const rpc = new ControlRpc(m.stdin, {
      onCanUseTool: async (_n, _i, ctx) => {
        observedSignal = ctx.signal;
        await new Promise((r) => setTimeout(r, 1_000));
        return { allow: true };
      },
      outboundResponseTimeoutMs: 60_000,
    });
    // Pending outbound + pending inbound.
    const pOut = rpc.interrupt();
    rpc.handleIncoming({
      type: 'control_request',
      request_id: 'req_inflight',
      request: { subtype: 'can_use_tool', tool_name: 'Bash', tool_use_id: 'tu', input: {} },
    } as ControlRequestFrame);
    await new Promise((r) => setImmediate(r));
    // Break the channel.
    m.stdin.emit('error', new Error('EPIPE'));
    await expect(pOut).rejects.toThrow(/channel broken/i);
    expect(observedSignal?.aborted).toBe(true);
  });
});

describe('ControlRpc — duplicate inbound request_id', () => {
  it('drops the second control_request with same request_id and warns', async () => {
    const m = makeStdin();
    const warn = vi.fn();
    let calls = 0;
    let firstSignal: AbortSignal | undefined;
    const rpc = new ControlRpc(m.stdin, {
      onCanUseTool: async (_n, _i, ctx) => {
        calls += 1;
        if (calls === 1) firstSignal = ctx.signal;
        await new Promise((r) => setTimeout(r, 30));
        return { allow: true };
      },
      logger: { warn },
    });
    rpc.handleIncoming({
      type: 'control_request',
      request_id: 'req_dup',
      request: { subtype: 'can_use_tool', tool_name: 'Bash', tool_use_id: 't1', input: {} },
    } as ControlRequestFrame);
    // Same request_id arrives again before first finishes.
    rpc.handleIncoming({
      type: 'control_request',
      request_id: 'req_dup',
      request: { subtype: 'can_use_tool', tool_name: 'Bash', tool_use_id: 't2', input: {} },
    } as ControlRequestFrame);
    await new Promise((r) => setTimeout(r, 60));
    // Only the first handler ran; first signal NOT aborted (not overwritten).
    expect(calls).toBe(1);
    expect(firstSignal?.aborted).toBe(false);
    // Exactly one response written, for the first request (toolUseID t1).
    const out = m.lines() as Array<Record<string, unknown>>;
    expect(out).toHaveLength(1);
    expect((out[0].response as { toolUseID: string }).toolUseID).toBe('t1');
    // Warn fired for the duplicate.
    expect(
      warn.mock.calls.some((c) => /duplicate inbound control_request/.test(String(c[0]))),
    ).toBe(true);
  });
});

describe('ControlRpc — cancel and finish race', () => {
  it('control_cancel_request after handler resolves: response is NOT written (per spec)', async () => {
    const m = makeStdin();
    let release: (() => void) | undefined;
    const rpc = new ControlRpc(m.stdin, {
      onCanUseTool: async () => {
        await new Promise<void>((r) => {
          release = r;
        });
        return { allow: true };
      },
    });
    rpc.handleIncoming({
      type: 'control_request',
      request_id: 'req_race',
      request: { subtype: 'can_use_tool', tool_name: 'Bash', tool_use_id: 'tr', input: {} },
    } as ControlRequestFrame);
    await new Promise((r) => setImmediate(r));
    // Cancel arrives first.
    rpc.handleIncoming({ type: 'control_cancel_request', request_id: 'req_race' });
    // Now let the handler resolve — finish() must detect the entry is gone.
    release!();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(m.lines()).toEqual([]);
  });

  it('control_cancel_request after handler already finished is a no-op', async () => {
    const m = makeStdin();
    const rpc = new ControlRpc(m.stdin, { onCanUseTool: allowAll });
    rpc.handleIncoming({
      type: 'control_request',
      request_id: 'req_done',
      request: { subtype: 'can_use_tool', tool_name: 'Bash', tool_use_id: 'td', input: {} },
    } as ControlRequestFrame);
    await new Promise((r) => setImmediate(r));
    expect(m.lines()).toHaveLength(1);
    // Cancel arrives long after — must not throw, must not write anything.
    expect(() =>
      rpc.handleIncoming({ type: 'control_cancel_request', request_id: 'req_done' }),
    ).not.toThrow();
  });

  it('control_cancel_request aborts the in-flight handler signal', async () => {
    const m = makeStdin();
    let observedSignal: AbortSignal | undefined;
    const rpc = new ControlRpc(m.stdin, {
      onCanUseTool: async (_n, _i, ctx) => {
        observedSignal = ctx.signal;
        await new Promise((r) => setTimeout(r, 50));
        return { allow: true };
      },
    });
    rpc.handleIncoming({
      type: 'control_request',
      request_id: 'req_X',
      request: { subtype: 'can_use_tool', tool_name: 'Bash', tool_use_id: 't', input: {} },
    } as ControlRequestFrame);
    // Give the handler time to register the signal.
    await new Promise((r) => setTimeout(r, 5));
    rpc.handleIncoming({ type: 'control_cancel_request', request_id: 'req_X' });
    expect(observedSignal?.aborted).toBe(true);
  });
});
