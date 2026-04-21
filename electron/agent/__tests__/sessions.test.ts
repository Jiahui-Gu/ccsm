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
  /** Read everything written to stdin as parsed JSON lines. */
  __stdinLines: () => unknown[];
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

    await runner.start({ ...baseOpts, model: 'sonnet', apiKey: 'sk-test' });

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
