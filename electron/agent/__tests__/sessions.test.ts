import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

// Mock claude-spawner so SessionRunner.start() never touches the real OS.
const { mockSpawnClaude } = vi.hoisted(() => ({ mockSpawnClaude: vi.fn() }));
vi.mock('../claude-spawner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../claude-spawner')>();
  return { ...actual, spawnClaude: mockSpawnClaude };
});

import { SessionRunner, type StartOptions } from '../sessions';

interface FakeChild extends EventEmitter {
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: PassThrough;
}

interface FakeProc {
  pid: number | undefined;
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: PassThrough;
  wait: () => Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  kill: ReturnType<typeof vi.fn>;
  getRecentStderr: () => string;
  /** Test-only helper to settle wait(). */
  __exit: (code: number | null, signal?: NodeJS.Signals | null) => void;
  /** Read stdin as parsed JSON lines, EXCLUDING the protocol initialize frame. */
  __stdinLines: () => unknown[];
  /** Read every JSON line written to stdin (initialize included). */
  __rawStdinLines: () => unknown[];
}

function makeFakeProc(): FakeProc {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();

  const stdinChunks: Buffer[] = [];
  child.stdin.on('data', (c) => stdinChunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))));

  let resolveWait: (v: { code: number | null; signal: NodeJS.Signals | null }) => void;
  const waitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) => {
    resolveWait = r;
  });

  const proc: FakeProc = {
    pid: 1234,
    stdout: child.stdout,
    stderr: child.stderr,
    stdin: child.stdin,
    wait: () => waitPromise,
    kill: vi.fn(),
    getRecentStderr: () => '',
    __exit: (code, signal = null) => resolveWait({ code, signal }),
    __stdinLines: () =>
      Buffer.concat(stdinChunks)
        .toString('utf8')
        .split('\n')
        .filter((s) => s.length > 0)
        .map((s) => JSON.parse(s))
        // Filter out the `initialize` handshake SessionRunner sends right
        // after spawn — most tests assert on user messages / outbound control
        // requests and don't care about this protocol-level frame. The dedicated
        // "sends an `initialize` control_request" test reads the unfiltered
        // stream via __rawStdinLines below.
        .filter((m) => {
          if (typeof m !== 'object' || m === null) return true;
          const obj = m as { type?: string; request?: { subtype?: string } };
          return !(obj.type === 'control_request' && obj.request?.subtype === 'initialize');
        }),
    __rawStdinLines: () =>
      Buffer.concat(stdinChunks)
        .toString('utf8')
        .split('\n')
        .filter((s) => s.length > 0)
        .map((s) => JSON.parse(s)),
  };
  return proc;
}

function emitFrame(stdout: PassThrough, frame: unknown): void {
  stdout.write(JSON.stringify(frame) + '\n');
}

const baseOpts: StartOptions = { cwd: '/work', configDir: '/tmp/cfg' };

beforeEach(() => {
  mockSpawnClaude.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('SessionRunner.start', () => {
  it('spawns claude with the provided options and forwards stream-json events', async () => {
    const proc = makeFakeProc();
    mockSpawnClaude.mockResolvedValue(proc);

    const events: unknown[] = [];
    const runner = new SessionRunner('s1', (m) => events.push(m), () => {}, () => {});

    await runner.start({ ...baseOpts, model: 'sonnet', envOverrides: { ANTHROPIC_API_KEY: 'sk-test' } });

    expect(mockSpawnClaude).toHaveBeenCalledTimes(1);
    const passed = mockSpawnClaude.mock.calls[0][0];
    expect(passed.cwd).toBe('/work');
    expect(passed.configDir).toBe('/tmp/cfg');
    expect(passed.model).toBe('sonnet');
    expect(passed.envOverrides.ANTHROPIC_API_KEY).toBe('sk-test');

    emitFrame(proc.stdout, {
      type: 'system',
      subtype: 'init',
      session_id: 'cli_abc',
      tools: [],
    });
    emitFrame(proc.stdout, {
      type: 'assistant',
      session_id: 'cli_abc',
      message: { id: 'msg_1', role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
    });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(events).toHaveLength(2);
    const [sys, assistant] = events as Array<{ type: string }>;
    expect(sys.type).toBe('system');
    expect(assistant.type).toBe('assistant');

    runner.close();
  });

  it('falls back to the env-based config dir when none is provided', async () => {
    const proc = makeFakeProc();
    mockSpawnClaude.mockResolvedValue(proc);
    process.env.AGENTORY_CLAUDE_CONFIG_DIR = '/env/cfg';

    const runner = new SessionRunner('s2', () => {}, () => {}, () => {});
    try {
      await runner.start({ cwd: '/w' });
      expect(mockSpawnClaude.mock.calls[0][0].configDir).toBe('/env/cfg');
    } finally {
      delete process.env.AGENTORY_CLAUDE_CONFIG_DIR;
      runner.close();
    }
  });

  it("defaults configDir to the user's ~/.claude so login state is shared with the CLI", async () => {
    const proc = makeFakeProc();
    mockSpawnClaude.mockResolvedValue(proc);
    // Make sure the env override is not set for this test.
    const prev = process.env.AGENTORY_CLAUDE_CONFIG_DIR;
    delete process.env.AGENTORY_CLAUDE_CONFIG_DIR;

    const os = await import('node:os');
    const path = await import('node:path');
    const expected = path.join(os.homedir(), '.claude');

    const runner = new SessionRunner('s2b', () => {}, () => {}, () => {});
    try {
      await runner.start({ cwd: '/w' });
      expect(mockSpawnClaude.mock.calls[0][0].configDir).toBe(expected);
    } finally {
      if (prev !== undefined) process.env.AGENTORY_CLAUDE_CONFIG_DIR = prev;
      runner.close();
    }
  });

  it('coerces SDK-only permission modes (dontAsk / auto) to default for the CLI', async () => {
    const proc = makeFakeProc();
    mockSpawnClaude.mockResolvedValue(proc);
    const runner = new SessionRunner('s3', () => {}, () => {}, () => {});
    await runner.start({ ...baseOpts, permissionMode: 'dontAsk' });
    expect(mockSpawnClaude.mock.calls[0][0].permissionMode).toBe('default');
    runner.close();
  });

  it('start() is idempotent — second call is a no-op', async () => {
    const proc = makeFakeProc();
    mockSpawnClaude.mockResolvedValue(proc);
    const runner = new SessionRunner('s4', () => {}, () => {}, () => {});
    await runner.start(baseOpts);
    await runner.start(baseOpts);
    expect(mockSpawnClaude).toHaveBeenCalledTimes(1);
    runner.close();
  });

  it('sends an `initialize` control_request immediately after spawn registering the PreToolUse permission hook', async () => {
    const proc = makeFakeProc();
    mockSpawnClaude.mockResolvedValue(proc);
    const runner = new SessionRunner('s-init', () => {}, () => {}, () => {});
    try {
      await runner.start(baseOpts);
      // Allow the queued control_request write to flush.
      await new Promise((r) => setImmediate(r));
      const lines = proc.__rawStdinLines();
      const init = lines.find(
        (l): l is { type: string; request: { subtype: string; hooks: Record<string, Array<{ matcher?: string; hookCallbackIds: string[] }>> } } =>
          typeof l === 'object' &&
          l !== null &&
          (l as { type?: string }).type === 'control_request' &&
          (l as { request?: { subtype?: string } }).request?.subtype === 'initialize',
      );
      expect(init, 'expected an initialize control_request on stdin').toBeDefined();
      // The CLI 2.x rule engine handles built-in tools entirely client-side
      // and only emits `can_use_tool` for ask-style tools. We register a
      // PreToolUse hook with matcher `.*` so EVERY tool invocation routes
      // back through the host for a permission decision. Without this,
      // Bash/Write/Edit run silently in `default` mode with no UI prompt.
      expect(init?.request.hooks).toEqual({
        PreToolUse: [
          { matcher: '.*', hookCallbackIds: ['agentory-permission'] },
        ],
      });
    } finally {
      runner.close();
    }
  });
});

describe('SessionRunner.send', () => {
  it('writes a stream-json user message including the cliSessionId once init has fired', async () => {
    const proc = makeFakeProc();
    mockSpawnClaude.mockResolvedValue(proc);
    const runner = new SessionRunner('s5', () => {}, () => {}, () => {});
    await runner.start(baseOpts);

    runner.send('first turn'); // before init -> no session_id
    emitFrame(proc.stdout, { type: 'system', subtype: 'init', session_id: 'cli_xyz' });
    await new Promise((r) => setImmediate(r));
    runner.send('second turn');
    await new Promise((r) => setImmediate(r));

    const lines = proc.__stdinLines() as Array<Record<string, unknown>>;
    expect(lines).toHaveLength(2);
    expect(lines[0].type).toBe('user');
    expect(lines[0].session_id).toBeUndefined();
    expect(lines[1].session_id).toBe('cli_xyz');

    runner.close();
  });

  it('send() after close is a no-op', async () => {
    const proc = makeFakeProc();
    mockSpawnClaude.mockResolvedValue(proc);
    const runner = new SessionRunner('s6', () => {}, () => {}, () => {});
    await runner.start(baseOpts);
    runner.close();
    runner.send('whatever');
    expect(proc.__stdinLines()).toEqual([]);
  });
});

describe('SessionRunner permission roundtrip', () => {
  it('forwards inbound can_use_tool to onPermissionRequest and writes back the user decision', async () => {
    const proc = makeFakeProc();
    mockSpawnClaude.mockResolvedValue(proc);
    const requests: Array<{ requestId: string; toolName: string }> = [];
    const runner = new SessionRunner(
      's7',
      () => {},
      () => {},
      (req) => requests.push({ requestId: req.requestId, toolName: req.toolName })
    );
    await runner.start(baseOpts);

    emitFrame(proc.stdout, {
      type: 'control_request',
      request_id: 'req_1',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'Bash',
        tool_use_id: 'toolu_a',
        input: { command: 'ls' },
      },
    });
    await new Promise((r) => setImmediate(r));
    expect(requests).toHaveLength(1);
    const [{ requestId }] = requests;

    expect(runner.resolvePermission(requestId, 'allow')).toBe(true);
    await new Promise((r) => setImmediate(r));

    const lines = proc.__stdinLines() as Array<Record<string, unknown>>;
    const resp = lines.find((l) => l.type === 'control_response');
    expect(resp).toBeDefined();
    expect(resp!.request_id).toBe('req_1');
    expect(resp!.response).toMatchObject({ behavior: 'allow', toolUseID: 'toolu_a' });

    runner.close();
  });

  it('resolvePermission with an unknown id returns false', () => {
    const runner = new SessionRunner('s7b', () => {}, () => {}, () => {});
    expect(runner.resolvePermission('nope', 'deny')).toBe(false);
  });

  it('deny decision flows through as behavior:deny', async () => {
    const proc = makeFakeProc();
    mockSpawnClaude.mockResolvedValue(proc);
    let captured = '';
    const runner = new SessionRunner('s8', () => {}, () => {}, (req) => {
      captured = req.requestId;
    });
    await runner.start(baseOpts);
    emitFrame(proc.stdout, {
      type: 'control_request',
      request_id: 'req_2',
      request: { subtype: 'can_use_tool', tool_name: 'Bash', tool_use_id: 'tu', input: {} },
    });
    await new Promise((r) => setImmediate(r));
    runner.resolvePermission(captured, 'deny');
    await new Promise((r) => setImmediate(r));
    const lines = proc.__stdinLines() as Array<Record<string, unknown>>;
    const resp = lines.find((l) => l.type === 'control_response') as Record<string, unknown>;
    expect((resp.response as Record<string, unknown>).behavior).toBe('deny');
    runner.close();
  });
});

describe('SessionRunner PreToolUse hook permission', () => {
  it('routes a hook_callback for a Bash tool through onPermissionRequest and writes back permissionDecision:allow', async () => {
    const proc = makeFakeProc();
    mockSpawnClaude.mockResolvedValue(proc);
    const seen: Array<{ requestId: string; toolName: string; input: Record<string, unknown> }> = [];
    const runner = new SessionRunner('s-hook-1', () => {}, () => {}, (req) => seen.push(req));
    await runner.start(baseOpts);

    emitFrame(proc.stdout, {
      type: 'control_request',
      request_id: 'req_hk_1',
      request: {
        subtype: 'hook_callback',
        callback_id: 'agentory-permission',
        input: {
          hook_event_name: 'PreToolUse',
          tool_name: 'Bash',
          tool_input: { command: 'echo hi' },
          tool_use_id: 'tu_hk',
          permission_mode: 'default',
        },
        tool_use_id: 'tu_hk',
      },
    });
    await new Promise((r) => setImmediate(r));
    expect(seen).toHaveLength(1);
    expect(seen[0].toolName).toBe('Bash');
    expect(seen[0].input.command).toBe('echo hi');

    expect(runner.resolvePermission(seen[0].requestId, 'allow')).toBe(true);
    await new Promise((r) => setImmediate(r));

    const lines = proc.__stdinLines() as Array<Record<string, unknown>>;
    const resp = lines.find((l) => l.type === 'control_response' && l.request_id === 'req_hk_1') as Record<string, unknown>;
    expect(resp).toBeDefined();
    expect(resp.response).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
      },
    });

    runner.close();
  });

  it('writes back permissionDecision:deny with reason when user denies', async () => {
    const proc = makeFakeProc();
    mockSpawnClaude.mockResolvedValue(proc);
    let captured = '';
    const runner = new SessionRunner('s-hook-2', () => {}, () => {}, (req) => {
      captured = req.requestId;
    });
    await runner.start(baseOpts);

    emitFrame(proc.stdout, {
      type: 'control_request',
      request_id: 'req_hk_2',
      request: {
        subtype: 'hook_callback',
        callback_id: 'agentory-permission',
        input: {
          hook_event_name: 'PreToolUse',
          tool_name: 'Write',
          tool_input: { file_path: '/x', content: 'y' },
          permission_mode: 'default',
        },
      },
    });
    await new Promise((r) => setImmediate(r));
    runner.resolvePermission(captured, 'deny');
    await new Promise((r) => setImmediate(r));

    const lines = proc.__stdinLines() as Array<Record<string, unknown>>;
    const resp = lines.find((l) => l.type === 'control_response' && l.request_id === 'req_hk_2') as Record<string, unknown>;
    expect(resp.response).toMatchObject({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
      },
    });
    const out = resp.response as { hookSpecificOutput: { permissionDecisionReason?: string } };
    expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(/denied/i);
    runner.close();
  });

  it('passes through (no UI prompt) for AskUserQuestion / ExitPlanMode so the legacy can_use_tool path renders specialized UI', async () => {
    const proc = makeFakeProc();
    mockSpawnClaude.mockResolvedValue(proc);
    const seen: Array<{ toolName: string }> = [];
    const runner = new SessionRunner('s-hook-3', () => {}, () => {}, (req) => seen.push(req));
    await runner.start(baseOpts);

    emitFrame(proc.stdout, {
      type: 'control_request',
      request_id: 'req_hk_3',
      request: {
        subtype: 'hook_callback',
        callback_id: 'agentory-permission',
        input: {
          hook_event_name: 'PreToolUse',
          tool_name: 'AskUserQuestion',
          tool_input: { questions: [] },
          permission_mode: 'default',
        },
      },
    });
    await new Promise((r) => setImmediate(r));
    expect(seen).toHaveLength(0);

    const lines = proc.__stdinLines() as Array<Record<string, unknown>>;
    const resp = lines.find((l) => l.type === 'control_response' && l.request_id === 'req_hk_3') as Record<string, unknown>;
    // Empty `{}` response means "no opinion, continue" — the CLI then fires
    // can_use_tool which the existing handler treats as a questions block.
    expect(resp.response).toEqual({});
    runner.close();
  });

  it('auto-allows (no UI prompt) when permission_mode is bypassPermissions or acceptEdits', async () => {
    const proc = makeFakeProc();
    mockSpawnClaude.mockResolvedValue(proc);
    const seen: Array<{ toolName: string }> = [];
    const runner = new SessionRunner('s-hook-4', () => {}, () => {}, (req) => seen.push(req));
    await runner.start(baseOpts);

    for (const [reqId, mode] of [
      ['req_hk_bp', 'bypassPermissions'],
      ['req_hk_ae', 'acceptEdits'],
    ] as const) {
      emitFrame(proc.stdout, {
        type: 'control_request',
        request_id: reqId,
        request: {
          subtype: 'hook_callback',
          callback_id: 'agentory-permission',
          input: {
            hook_event_name: 'PreToolUse',
            tool_name: 'Bash',
            tool_input: { command: 'rm -rf /tmp/x' },
            permission_mode: mode,
          },
        },
      });
    }
    await new Promise((r) => setImmediate(r));
    expect(seen).toHaveLength(0);

    const lines = proc.__stdinLines() as Array<Record<string, unknown>>;
    const responses = lines.filter((l) => l.type === 'control_response');
    expect(responses).toHaveLength(2);
    for (const r of responses) expect(r.response).toEqual({});
    runner.close();
  });

  it('ignores hook_callback frames with an unknown callback id (defensive)', async () => {
    const proc = makeFakeProc();
    mockSpawnClaude.mockResolvedValue(proc);
    const seen: unknown[] = [];
    const runner = new SessionRunner('s-hook-5', () => {}, () => {}, (req) => seen.push(req));
    await runner.start(baseOpts);

    emitFrame(proc.stdout, {
      type: 'control_request',
      request_id: 'req_hk_unknown',
      request: {
        subtype: 'hook_callback',
        callback_id: 'some-other-hook',
        input: { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {}, permission_mode: 'default' },
      },
    });
    await new Promise((r) => setImmediate(r));
    expect(seen).toHaveLength(0);

    const lines = proc.__stdinLines() as Array<Record<string, unknown>>;
    const resp = lines.find((l) => l.type === 'control_response' && l.request_id === 'req_hk_unknown') as Record<string, unknown>;
    expect(resp.response).toEqual({});
    runner.close();
  });
});

describe('SessionRunner outbound control', () => {
  it('interrupt() sends a control_request and resolves on control_response', async () => {
    const proc = makeFakeProc();
    mockSpawnClaude.mockResolvedValue(proc);
    const runner = new SessionRunner('s9', () => {}, () => {}, () => {});
    await runner.start(baseOpts);

    const p = runner.interrupt();
    await new Promise((r) => setImmediate(r));
    const out = proc.__stdinLines() as Array<Record<string, unknown>>;
    const req = out.find((l) => l.type === 'control_request') as Record<string, unknown>;
    expect(req).toBeDefined();
    expect((req.request as Record<string, unknown>).subtype).toBe('interrupt');
    emitFrame(proc.stdout, {
      type: 'control_response',
      request_id: req.request_id,
      response: {},
    });
    await expect(p).resolves.toBeUndefined();
    runner.close();
  });

  it('setModel() forwards a set_model control_request', async () => {
    const proc = makeFakeProc();
    mockSpawnClaude.mockResolvedValue(proc);
    const runner = new SessionRunner('s10', () => {}, () => {}, () => {});
    await runner.start(baseOpts);

    const p = runner.setModel('opus');
    await new Promise((r) => setImmediate(r));
    const out = proc.__stdinLines() as Array<Record<string, unknown>>;
    const req = out.find(
      (l) => l.type === 'control_request' &&
        (l.request as Record<string, unknown>).subtype === 'set_model'
    ) as Record<string, unknown>;
    expect((req.request as Record<string, unknown>).model).toBe('opus');
    emitFrame(proc.stdout, { type: 'control_response', request_id: req.request_id, response: {} });
    await expect(p).resolves.toBeUndefined();
    runner.close();
  });

  it('setModel() is a no-op when model is undefined', async () => {
    const proc = makeFakeProc();
    mockSpawnClaude.mockResolvedValue(proc);
    const runner = new SessionRunner('s10b', () => {}, () => {}, () => {});
    await runner.start(baseOpts);
    await runner.setModel(undefined);
    expect(proc.__stdinLines()).toEqual([]);
    runner.close();
  });
});

describe('SessionRunner exit handling', () => {
  it('calls onExit({}) on a clean exit', async () => {
    const proc = makeFakeProc();
    mockSpawnClaude.mockResolvedValue(proc);
    const exits: Array<{ error?: string }> = [];
    const runner = new SessionRunner('s11', () => {}, (info) => exits.push(info), () => {});
    await runner.start(baseOpts);
    proc.stdout.end();
    proc.__exit(0, null);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(exits).toHaveLength(1);
    expect(exits[0].error).toBeUndefined();
  });

  it('surfaces a non-zero exit code in onExit.error', async () => {
    const proc = makeFakeProc();
    proc.getRecentStderr = () => 'boom';
    mockSpawnClaude.mockResolvedValue(proc);
    const exits: Array<{ error?: string }> = [];
    const runner = new SessionRunner('s12', () => {}, (info) => exits.push(info), () => {});
    await runner.start(baseOpts);
    proc.stdout.end();
    proc.__exit(7, null);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(exits).toHaveLength(1);
    expect(exits[0].error).toContain('code=7');
    expect(exits[0].error).toContain('boom');
  });

  it('surfaces an onExit error if spawnClaude rejects', async () => {
    mockSpawnClaude.mockRejectedValue(new Error('binary missing'));
    const runner = new SessionRunner('s13', () => {}, () => {}, () => {});
    await expect(runner.start(baseOpts)).rejects.toThrow('binary missing');
  });
});

describe('SessionRunner.close', () => {
  it('denies any outstanding permission prompts', async () => {
    const proc = makeFakeProc();
    mockSpawnClaude.mockResolvedValue(proc);
    let capturedRequestId = '';
    const runner = new SessionRunner('s14', () => {}, () => {}, (req) => {
      capturedRequestId = req.requestId;
    });
    await runner.start(baseOpts);
    emitFrame(proc.stdout, {
      type: 'control_request',
      request_id: 'req_close',
      request: { subtype: 'can_use_tool', tool_name: 'Bash', tool_use_id: 'tu', input: {} },
    });
    await new Promise((r) => setImmediate(r));
    expect(capturedRequestId).not.toBe('');

    runner.close();
    proc.__exit(0);
    await new Promise((r) => setImmediate(r));
    // After close, resolvePermission can no longer settle — the entry was
    // wiped synchronously.
    expect(runner.resolvePermission(capturedRequestId, 'allow')).toBe(false);
  });
});
