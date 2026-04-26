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
  const setMaxThinkingTokens = vi.fn().mockResolvedValue(undefined);
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
      setMaxThinkingTokens,
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
    setMaxThinkingTokens,
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

  it('disables CLI IDE auto-connect so VS Code lockfiles do not bind to ccsm sessions', async () => {
    // Regression: with a VS Code Claude Code extension running, a lockfile
    // at $CLAUDE_CONFIG_DIR/ide/<pid>.lock advertises ideName="Visual
    // Studio Code" + workspaceFolders. The bundled CLI auto-connects when
    // a lockfile's workspaceFolders include the session cwd, and the agent
    // then identifies itself as "Claude Code (VS Code integration)" — wrong
    // for ccsm, an independent Electron app. Setting
    // CLAUDE_CODE_AUTO_CONNECT_IDE=false trips the bundled-CLI kill-switch
    // (`!a7(env)` in the IDE-attach gate) and forces standalone identity.
    const runner = new SdkSessionRunner('s2b', noop, noop, noop, noop);
    await runner.start(baseStart);
    const opts = fake.getOptions()?.options ?? {};
    const env = (opts.env ?? {}) as Record<string, string>;
    expect(env.CLAUDE_CODE_AUTO_CONNECT_IDE).toBe('false');
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBe('ccsm-desktop');
    expect(env.CLAUDE_AGENT_SDK_CLIENT_APP).toBe('ccsm-desktop/0.1.0');
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

  it('setMaxThinkingTokens() forwards both endpoint values (0 and 31999)', async () => {
    const runner = new SdkSessionRunner('s7b', noop, noop, noop, noop);
    await runner.start(baseStart);
    await runner.setMaxThinkingTokens(0);
    expect(fake.setMaxThinkingTokens).toHaveBeenCalledWith(0);
    await runner.setMaxThinkingTokens(31999);
    expect(fake.setMaxThinkingTokens).toHaveBeenLastCalledWith(31999);
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
    const input = { command: 'ls -la' };
    const decision = (await canUseTool('Bash', input, { signal: ac.signal, toolUseID: 't3' })) as {
      behavior: string;
      updatedInput?: unknown;
    };
    expect(decision.behavior).toBe('allow');
    // Bug #169 / PR #313: every allow path must echo `updatedInput` so the
    // CLI's over-the-wire schema accepts the response.
    expect(decision.updatedInput).toBe(input);
    expect(onPerm).not.toHaveBeenCalled();
    runner.close();
  });

  it.each([
    ['bypassPermissions', 's11a'],
    ['acceptEdits', 's11b'],
    ['auto', 's11c'],
  ] as const)(
    'canUseTool early-return in %s mode echoes updatedInput=input (Bug #169)',
    async (mode, id) => {
      const onPerm = vi.fn();
      const runner = new SdkSessionRunner(id, noop, noop, onPerm, noop);
      await runner.start({ ...baseStart, permissionMode: mode });
      const canUseTool = (fake.getOptions()?.options as { canUseTool?: (toolName: string, input: unknown, ctx: { signal: AbortSignal; toolUseID: string }) => Promise<unknown> }).canUseTool!;
      const ac = new AbortController();
      const input = { file_path: '/tmp/x', content: 'hi' };
      const decision = (await canUseTool('Write', input, { signal: ac.signal, toolUseID: `tu-${id}` })) as {
        behavior: string;
        updatedInput?: unknown;
      };
      expect(decision.behavior).toBe('allow');
      expect(decision.updatedInput).toBe(input);
      expect(onPerm).not.toHaveBeenCalled();
      runner.close();
    },
  );

  it('canUseTool emits onPermissionRequest for AskUserQuestion (passthrough tool routes to renderer UI)', async () => {
    // Regression for "agent invoked AskUserQuestion but no question card showed
    // up in the UI": the SDK runner originally short-circuited PASSTHROUGH_TOOLS
    // to `behavior: 'allow'` here, never notifying the renderer — so no
    // QuestionStickyHost card mounted, the SDK got an instant allow with empty
    // input, and the model received an empty tool_result body. The contract is:
    // PASSTHROUGH tools MUST surface through onPermissionRequest so the
    // renderer's bespoke question / plan UI is the single source of truth.
    const onPerm = vi.fn();
    const runner = new SdkSessionRunner('s12', noop, noop, onPerm, noop);
    await runner.start({ ...baseStart, permissionMode: 'default' });

    const canUseTool = (fake.getOptions()?.options as { canUseTool?: (toolName: string, input: unknown, ctx: { signal: AbortSignal; toolUseID: string }) => Promise<unknown> }).canUseTool!;
    const ac = new AbortController();
    const input = { questions: [{ question: 'y/n?', options: [{ label: 'y' }, { label: 'n' }] }] };
    // Kick off the canUseTool call but don't await — it should suspend on the
    // pending permission promise until we resolve it.
    const decisionPromise = canUseTool('AskUserQuestion', input, {
      signal: ac.signal,
      toolUseID: 't4',
    });
    // Yield so the runner has a chance to call onPermissionRequest synchronously.
    await new Promise((r) => setImmediate(r));
    expect(onPerm).toHaveBeenCalledTimes(1);
    const req = onPerm.mock.calls[0][0] as { requestId: string; toolName: string; input: unknown };
    expect(req.toolName).toBe('AskUserQuestion');
    expect(req.input).toBe(input);
    expect(typeof req.requestId).toBe('string');

    // Renderer settles the request via resolvePermission — the question UI's
    // submit/reject path always denies the canUseTool gate (then sends the
    // user's answers as the next user message). See QuestionStickyHost.
    runner.resolvePermission(req.requestId, 'deny');
    const decision = (await decisionPromise) as { behavior: string; message?: string };
    expect(decision.behavior).toBe('deny');
    runner.close();
  });

  // PreToolUse hook (#94): forces the CLI to defer built-in tools (Bash etc.)
  // to canUseTool instead of auto-allowing via its safe-command heuristics.
  // The CLI sees `permissionDecision: 'ask'` for non-passthrough tools and
  // `'allow'` for passthrough/bypass paths.
  type HookFn = (
    input: { hook_event_name: 'PreToolUse'; tool_name: string },
    toolUseID: string | undefined,
    options: { signal: AbortSignal },
  ) => Promise<{
    hookSpecificOutput?: { hookEventName: string; permissionDecision?: string };
  }>;
  const getPreToolUseHook = (): HookFn => {
    const opts = fake.getOptions()?.options as {
      hooks?: { PreToolUse?: Array<{ matcher?: string; hooks: HookFn[] }> };
    };
    const matcher = opts.hooks?.PreToolUse?.[0];
    if (!matcher) throw new Error('PreToolUse hook matcher not registered');
    expect(matcher.matcher).toBe('.*');
    return matcher.hooks[0];
  };

  it('PreToolUse hook returns ask for built-in tools in default mode (#94)', async () => {
    const runner = new SdkSessionRunner('s12-pt-default', noop, noop, noop, noop);
    await runner.start({ ...baseStart, permissionMode: 'default' });
    const hook = getPreToolUseHook();
    const ac = new AbortController();
    const out = await hook(
      { hook_event_name: 'PreToolUse', tool_name: 'Bash' },
      'tu-bash',
      { signal: ac.signal },
    );
    expect(out.hookSpecificOutput?.hookEventName).toBe('PreToolUse');
    expect(out.hookSpecificOutput?.permissionDecision).toBe('ask');
    runner.close();
  });

  it('PreToolUse hook returns ask for passthrough tools so canUseTool fires (#94)', async () => {
    // PASSTHROUGH tools must reach canUseTool so onPermissionRequest can mount
    // the renderer's question / plan UI. Returning 'allow' here would let the
    // CLI bypass canUseTool and synthesize an empty tool_result — exactly the
    // bug "agent asked but nothing showed up in UI".
    const runner = new SdkSessionRunner('s12-pt-pass', noop, noop, noop, noop);
    await runner.start({ ...baseStart, permissionMode: 'default' });
    const hook = getPreToolUseHook();
    const ac = new AbortController();
    for (const tool of ['AskUserQuestion', 'ExitPlanMode']) {
      const out = await hook(
        { hook_event_name: 'PreToolUse', tool_name: tool },
        'tu-pass',
        { signal: ac.signal },
      );
      expect(out.hookSpecificOutput?.permissionDecision).toBe('ask');
    }
    runner.close();
  });

  it('PreToolUse hook returns ask for passthrough tools even in bypass modes', async () => {
    // bypassPermissions / acceptEdits / auto skip the host round-trip for
    // ordinary tools, but passthrough tools (AskUserQuestion / ExitPlanMode)
    // must always reach canUseTool — the user explicitly opted into those
    // interactions; bypass mode applies to "tools the agent uses without
    // asking", not "questions the agent asks the user".
    for (const mode of ['bypassPermissions', 'acceptEdits', 'auto'] as const) {
      const runner = new SdkSessionRunner(`s12-pt-pass-${mode}`, noop, noop, noop, noop);
      await runner.start({ ...baseStart, permissionMode: mode });
      const hook = getPreToolUseHook();
      const ac = new AbortController();
      const out = await hook(
        { hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion' },
        'tu-aq',
        { signal: ac.signal },
      );
      expect(out.hookSpecificOutput?.permissionDecision).toBe('ask');
      runner.close();
    }
  });

  it.each(['bypassPermissions', 'acceptEdits', 'auto'] as const)(
    'PreToolUse hook returns allow in %s mode (no host round-trip needed)',
    async (mode) => {
      const runner = new SdkSessionRunner(`s12-pt-${mode}`, noop, noop, noop, noop);
      await runner.start({ ...baseStart, permissionMode: mode });
      const hook = getPreToolUseHook();
      const ac = new AbortController();
      const out = await hook(
        { hook_event_name: 'PreToolUse', tool_name: 'Bash' },
        'tu-bypass',
        { signal: ac.signal },
      );
      expect(out.hookSpecificOutput?.permissionDecision).toBe('allow');
      runner.close();
    },
  );

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
