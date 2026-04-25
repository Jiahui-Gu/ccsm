import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The runner pulls binary-resolver to find a system claude binary. Mock so
// start() never touches the filesystem.
vi.mock('../../agent/binary-resolver', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../agent/binary-resolver')>();
  return {
    ...actual,
    resolveClaudeInvocation: vi.fn().mockResolvedValue({ kind: 'binary', path: '/fake/claude' }),
  };
});

import { SdkSessionRunner, __setSdkModuleForTests } from '../sessions';
import type { StartOptions } from '../../agent/sessions';

/**
 * Build a fake SDK whose query() returns an async-iterable that we drive
 * manually plus a stub for interrupt / setPermissionMode / setModel / close.
 */
function makeFakeSdk() {
  let lastOptions: unknown = null;
  let queueResolve: ((v: IteratorResult<unknown>) => void) | null = null;
  const buffer: unknown[] = [];
  let closed = false;

  const interrupt = vi.fn().mockResolvedValue(undefined);
  const setPermissionMode = vi.fn().mockResolvedValue(undefined);
  const setModel = vi.fn().mockResolvedValue(undefined);
  const close = vi.fn();

  const query = (args: unknown) => {
    lastOptions = args;
    const iter = {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<unknown>> {
            if (buffer.length > 0) return Promise.resolve({ value: buffer.shift(), done: false });
            if (closed) return Promise.resolve({ value: undefined, done: true });
            return new Promise((resolve) => {
              queueResolve = resolve;
            });
          },
        };
      },
      interrupt,
      setPermissionMode,
      setModel,
      close,
    };
    return iter;
  };

  return {
    sdk: { query },
    push(msg: unknown) {
      if (queueResolve) {
        const r = queueResolve;
        queueResolve = null;
        r({ value: msg, done: false });
      } else {
        buffer.push(msg);
      }
    },
    finish() {
      closed = true;
      if (queueResolve) {
        const r = queueResolve;
        queueResolve = null;
        r({ value: undefined, done: true });
      }
    },
    getOptions: () => lastOptions as { options?: Record<string, unknown> } | null,
    interrupt,
    setPermissionMode,
    setModel,
    close,
  };
}

const noop = () => {};
const baseStart: StartOptions = { cwd: '/tmp/fake' };

describe('agent-sdk/SdkSessionRunner', () => {
  let fake: ReturnType<typeof makeFakeSdk>;

  beforeEach(() => {
    fake = makeFakeSdk();
    __setSdkModuleForTests(
      fake.sdk as unknown as typeof import('@anthropic-ai/claude-agent-sdk'),
    );
  });

  afterEach(() => {
    __setSdkModuleForTests(null);
  });

  it('start() forwards cwd, model, resume, binary path, and permission mode', async () => {
    const runner = new SdkSessionRunner('s1', noop, noop, noop, noop);
    await runner.start({
      cwd: '/work',
      model: 'claude-3-5',
      resumeSessionId: 'sess-prev',
      binaryPath: '/usr/local/bin/claude',
      permissionMode: 'acceptEdits',
    });

    const opts = fake.getOptions()?.options ?? {};
    expect(opts.cwd).toBe('/work');
    expect(opts.model).toBe('claude-3-5');
    expect(opts.resume).toBe('sess-prev');
    expect(opts.pathToClaudeCodeExecutable).toBe('/usr/local/bin/claude');
    expect(opts.permissionMode).toBe('acceptEdits');
    expect(opts.includePartialMessages).toBe(true);
    runner.close();
  });

  it('coerces legacy permission mode aliases into SDK modes', async () => {
    const runner = new SdkSessionRunner('s2', noop, noop, noop, noop);
    await runner.start({ ...baseStart, permissionMode: 'yolo' });
    const opts = fake.getOptions()?.options ?? {};
    expect(opts.permissionMode).toBe('bypassPermissions');
    expect(opts.allowDangerouslySkipPermissions).toBe(true);
    runner.close();
  });

  it('emits translated SDK messages to onEvent and captures cliSessionId from init', async () => {
    const events: unknown[] = [];
    const runner = new SdkSessionRunner('s3', (e) => events.push(e), noop, noop, noop);
    await runner.start(baseStart);

    fake.push({
      type: 'system',
      subtype: 'init',
      session_id: 'cli-xyz',
      cwd: '/work',
      tools: [],
      mcp_servers: [],
      model: 'claude',
      permissionMode: 'default',
      apiKeySource: 'env',
    });
    fake.push({
      type: 'assistant',
      session_id: 'cli-xyz',
      message: { role: 'assistant', content: [] },
    });
    fake.push({ type: 'status' }); // dropped
    // wait one microtask cycle so the consumer drains
    await new Promise((r) => setTimeout(r, 10));

    expect(events).toHaveLength(2);
    expect((events[0] as { type?: string }).type).toBe('system');
    expect((events[1] as { type?: string }).type).toBe('assistant');
    runner.close();
  });

  it('onExit fires on iterator completion with no error', async () => {
    const exits: Array<{ error?: string }> = [];
    const runner = new SdkSessionRunner('s4', noop, (info) => exits.push(info), noop, noop);
    await runner.start(baseStart);
    fake.finish();
    await new Promise((r) => setTimeout(r, 10));
    expect(exits).toHaveLength(1);
    expect(exits[0].error).toBeUndefined();
  });

  it('interrupt() delegates to Query.interrupt()', async () => {
    const runner = new SdkSessionRunner('s5', noop, noop, noop, noop);
    await runner.start(baseStart);
    await runner.interrupt();
    expect(fake.interrupt).toHaveBeenCalledTimes(1);
    runner.close();
  });

  it('setPermissionMode() delegates to Query.setPermissionMode()', async () => {
    const runner = new SdkSessionRunner('s6', noop, noop, noop, noop);
    await runner.start(baseStart);
    await runner.setPermissionMode('plan');
    expect(fake.setPermissionMode).toHaveBeenCalledWith('plan');
    runner.close();
  });

  it('setModel() delegates only if model is provided', async () => {
    const runner = new SdkSessionRunner('s7', noop, noop, noop, noop);
    await runner.start(baseStart);
    await runner.setModel(undefined);
    expect(fake.setModel).not.toHaveBeenCalled();
    await runner.setModel('claude-x');
    expect(fake.setModel).toHaveBeenCalledWith('claude-x');
    runner.close();
  });

  it('cancelToolUse() silently falls back to turn-level interrupt without diagnostic', async () => {
    const diags: Array<{ code: string }> = [];
    const runner = new SdkSessionRunner(
      's8',
      noop,
      noop,
      noop,
      (d) => diags.push(d),
    );
    await runner.start(baseStart);
    await runner.cancelToolUse('toolUse-42');
    expect(diags.some((d) => d.code === 'tool_cancel_fallback')).toBe(false);
    expect(fake.interrupt).toHaveBeenCalled();
    runner.close();
  });

  it('canUseTool routes to onPermissionRequest and resolvePermission settles allow', async () => {
    let capturedReq: { requestId: string; toolName: string; input: unknown } | null = null;
    const runner = new SdkSessionRunner(
      's9',
      noop,
      noop,
      (req) => {
        capturedReq = req;
      },
      noop,
    );
    await runner.start({ ...baseStart, permissionMode: 'default' });

    // Pluck the canUseTool callback off the options the SDK received.
    const canUseTool = (fake.getOptions()?.options as { canUseTool?: (toolName: string, input: unknown, ctx: { signal: AbortSignal; toolUseID: string }) => Promise<unknown> }).canUseTool!;
    const ac = new AbortController();
    const decisionP = canUseTool('Bash', { command: 'ls' }, { signal: ac.signal, toolUseID: 't1' });

    // Wait for the request to land in the host.
    await new Promise((r) => setTimeout(r, 5));
    expect(capturedReq).not.toBeNull();

    runner.resolvePermission(capturedReq!.requestId, 'allow');
    const decision = (await decisionP) as { behavior: string };
    expect(decision.behavior).toBe('allow');
    runner.close();
  });

  it('canUseTool deny path produces a behaviour:deny decision', async () => {
    let capturedReq: { requestId: string } | null = null;
    const runner = new SdkSessionRunner(
      's10',
      noop,
      noop,
      (req) => {
        capturedReq = req;
      },
      noop,
    );
    await runner.start({ ...baseStart, permissionMode: 'default' });

    const canUseTool = (fake.getOptions()?.options as { canUseTool?: (toolName: string, input: unknown, ctx: { signal: AbortSignal; toolUseID: string }) => Promise<unknown> }).canUseTool!;
    const ac = new AbortController();
    const decisionP = canUseTool('Bash', {}, { signal: ac.signal, toolUseID: 't2' });
    await new Promise((r) => setTimeout(r, 5));

    runner.resolvePermission(capturedReq!.requestId, 'deny');
    const decision = (await decisionP) as { behavior: string };
    expect(decision.behavior).toBe('deny');
    runner.close();
  });

  it('canUseTool short-circuits to allow in bypassPermissions mode', async () => {
    const onPerm = vi.fn();
    const runner = new SdkSessionRunner('s11', noop, noop, onPerm, noop);
    await runner.start({ ...baseStart, permissionMode: 'bypassPermissions' });

    const canUseTool = (fake.getOptions()?.options as { canUseTool?: (toolName: string, input: unknown, ctx: { signal: AbortSignal; toolUseID: string }) => Promise<unknown> }).canUseTool!;
    const ac = new AbortController();
    const decision = (await canUseTool('Bash', {}, { signal: ac.signal, toolUseID: 't3' })) as {
      behavior: string;
    };
    expect(decision.behavior).toBe('allow');
    expect(onPerm).not.toHaveBeenCalled();
    runner.close();
  });

  it('canUseTool short-circuits AskUserQuestion (passthrough tool)', async () => {
    const onPerm = vi.fn();
    const runner = new SdkSessionRunner('s12', noop, noop, onPerm, noop);
    await runner.start({ ...baseStart, permissionMode: 'default' });

    const canUseTool = (fake.getOptions()?.options as { canUseTool?: (toolName: string, input: unknown, ctx: { signal: AbortSignal; toolUseID: string }) => Promise<unknown> }).canUseTool!;
    const ac = new AbortController();
    const decision = (await canUseTool(
      'AskUserQuestion',
      {},
      { signal: ac.signal, toolUseID: 't4' },
    )) as { behavior: string };
    expect(decision.behavior).toBe('allow');
    expect(onPerm).not.toHaveBeenCalled();
    runner.close();
  });

  it('close() resolves outstanding permission requests as denied', async () => {
    let capturedReq: { requestId: string } | null = null;
    const runner = new SdkSessionRunner(
      's13',
      noop,
      noop,
      (req) => {
        capturedReq = req;
      },
      noop,
    );
    await runner.start({ ...baseStart, permissionMode: 'default' });
    const canUseTool = (fake.getOptions()?.options as { canUseTool?: (toolName: string, input: unknown, ctx: { signal: AbortSignal; toolUseID: string }) => Promise<unknown> }).canUseTool!;
    const ac = new AbortController();
    const p = canUseTool('Bash', {}, { signal: ac.signal, toolUseID: 't5' });
    await new Promise((r) => setTimeout(r, 5));
    expect(capturedReq).not.toBeNull();

    runner.close();
    const decision = (await p) as { behavior: string };
    expect(decision.behavior).toBe('deny');
  });

  it('getPid() returns undefined (SDK does not expose child pid)', () => {
    const runner = new SdkSessionRunner('s14', noop, noop, noop, noop);
    expect(runner.getPid()).toBeUndefined();
  });
});
