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

  it('unknown subtype: log warn and DO NOT reply (forward compat)', async () => {
    const m = makeStdin();
    const warn = vi.fn();
    const rpc = new ControlRpc(m.stdin, { onCanUseTool: allowAll, logger: { warn } });
    rpc.handleIncoming({
      type: 'control_request',
      request_id: 'req_U',
      request: { subtype: 'future_unknown_thing', whatever: true },
    } as ControlRequestFrame);
    await new Promise((r) => setImmediate(r));
    expect(m.lines()).toEqual([]);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toMatch(/unknown control_request subtype/);
    void rpc;
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

    // Simulate ack.
    rpc.handleIncoming({
      type: 'control_response',
      request_id: frame.request_id as string,
      response: { ok: true },
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
      request_id: frame.request_id as string,
      response: {},
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
      request_id: frame.request_id as string,
      response: {},
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
      request_id: frame.request_id as string,
      response: {},
    });
    await expect(p).resolves.toBeUndefined();
  });

  it('outbound times out and rejects when no response arrives', async () => {
    const m = makeStdin();
    const rpc = new ControlRpc(m.stdin, {
      onCanUseTool: allowAll,
      interruptHardKillTimeoutMs: 20,
    });
    await expect(rpc.interrupt()).rejects.toThrow(/timed out/);
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
      interruptHardKillTimeoutMs: 5_000,
    });
    const p = rpc.interrupt();
    rpc.close();
    await expect(p).rejects.toThrow(/closed/);
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
