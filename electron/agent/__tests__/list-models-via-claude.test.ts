import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

// Mock claude-spawner so we never touch the OS / claude.exe.
const { mockSpawnClaude } = vi.hoisted(() => ({ mockSpawnClaude: vi.fn() }));
vi.mock('../claude-spawner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../claude-spawner')>();
  return { ...actual, spawnClaude: mockSpawnClaude };
});

import { listModelsViaClaude, __test__ } from '../list-models-via-claude';

interface FakeProc {
  pid: number | undefined;
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: PassThrough;
  wait: () => Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  kill: ReturnType<typeof vi.fn>;
  getRecentStderr: () => string;
  __exit: (code: number | null) => void;
  __readStdin: () => unknown[];
}

function makeFakeProc(): FakeProc {
  const ee = new EventEmitter();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough();
  const stdinChunks: Buffer[] = [];
  stdin.on('data', (c) => stdinChunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))));

  let resolveWait!: (v: { code: number | null; signal: NodeJS.Signals | null }) => void;
  const waitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (r) => {
      resolveWait = r;
    },
  );

  const proc: FakeProc = {
    pid: 1234,
    stdout,
    stderr,
    stdin,
    wait: () => waitPromise,
    kill: vi.fn(() => {
      // Settle wait() so the listModelsViaClaude wait-handler doesn't keep the
      // promise alive after we've already finish()ed elsewhere.
      resolveWait({ code: 0, signal: null });
    }),
    getRecentStderr: () => '',
    __exit: (code) => resolveWait({ code, signal: null }),
    __readStdin: () =>
      Buffer.concat(stdinChunks)
        .toString('utf8')
        .split('\n')
        .filter((s) => s.length > 0)
        .map((s) => JSON.parse(s)),
  };
  // Suppress "no listener" on ee — included for parity if needed.
  void ee;
  return proc;
}

function emit(stdout: PassThrough, frame: unknown): void {
  stdout.write(JSON.stringify(frame) + '\n');
}

beforeEach(() => {
  mockSpawnClaude.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('listModelsViaClaude — happy paths', () => {
  it('returns models from the system/init frame when present', async () => {
    const proc = makeFakeProc();
    mockSpawnClaude.mockResolvedValue(proc);
    const p = listModelsViaClaude({
      baseUrl: 'http://relay',
      apiKey: 'sk',
      configDir: '/tmp/cfg',
      cwd: '/work',
    });
    // Wait a tick for the splitter to attach.
    await new Promise((r) => setImmediate(r));
    emit(proc.stdout, {
      type: 'system',
      subtype: 'init',
      session_id: 's1',
      models: [
        'claude-sonnet-4-5',
        { id: 'claude-opus-4-5', display_name: 'Opus 4.5' },
      ],
    });
    const res = await p;
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.source).toBe('init');
      expect(res.models).toEqual([
        { id: 'claude-sonnet-4-5' },
        { id: 'claude-opus-4-5', displayName: 'Opus 4.5' },
      ]);
    }
    expect(proc.kill).toHaveBeenCalled();
    // No initialize RPC should have been written — init frame had what we needed.
    expect(proc.__readStdin()).toHaveLength(0);
  });

  it('falls back to control_request {subtype: initialize} when init has no models', async () => {
    const proc = makeFakeProc();
    mockSpawnClaude.mockResolvedValue(proc);
    const p = listModelsViaClaude({
      baseUrl: 'http://relay',
      apiKey: 'sk',
      configDir: '/tmp/cfg',
      cwd: '/work',
    });
    await new Promise((r) => setImmediate(r));
    emit(proc.stdout, { type: 'system', subtype: 'init', session_id: 's1' });
    // Wait for stdin write to land before reading.
    await new Promise((r) => setImmediate(r));
    const writes = proc.__readStdin();
    expect(writes).toHaveLength(1);
    const req = writes[0] as { type: string; request_id: string; request: { subtype: string } };
    expect(req.type).toBe('control_request');
    expect(req.request.subtype).toBe('initialize');

    emit(proc.stdout, {
      type: 'control_response',
      request_id: req.request_id,
      response: { models: [{ id: 'claude-haiku-4-5' }] },
    });
    const res = await p;
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.source).toBe('initialize-rpc');
      expect(res.models).toEqual([{ id: 'claude-haiku-4-5' }]);
    }
  });

  it('returns ok with empty models when neither path yields any', async () => {
    const proc = makeFakeProc();
    mockSpawnClaude.mockResolvedValue(proc);
    const p = listModelsViaClaude({
      baseUrl: 'http://relay',
      apiKey: 'sk',
      configDir: '/tmp/cfg',
      cwd: '/work',
    });
    await new Promise((r) => setImmediate(r));
    emit(proc.stdout, { type: 'system', subtype: 'init', session_id: 's1' });
    await new Promise((r) => setImmediate(r));
    const req = proc.__readStdin()[0] as { request_id: string };
    emit(proc.stdout, {
      type: 'control_response',
      request_id: req.request_id,
      response: {},
    });
    const res = await p;
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.source).toBe('none');
      expect(res.models).toEqual([]);
    }
  });
});

describe('listModelsViaClaude — failure paths', () => {
  it('returns { ok:false } when spawn rejects', async () => {
    mockSpawnClaude.mockRejectedValue(new Error('ENOENT'));
    const res = await listModelsViaClaude({
      baseUrl: 'http://x',
      apiKey: 'sk',
      configDir: '/tmp/cfg',
      cwd: '/work',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('ENOENT');
  });

  it('returns { ok:false, error: "timeout" } when the timer fires before any frame', async () => {
    vi.useFakeTimers();
    const proc = makeFakeProc();
    mockSpawnClaude.mockResolvedValue(proc);
    const p = listModelsViaClaude({
      baseUrl: 'http://x',
      apiKey: 'sk',
      timeoutMs: 50,
      configDir: '/tmp/cfg',
      cwd: '/work',
    });
    await vi.advanceTimersByTimeAsync(60);
    const res = await p;
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('timeout');
  });

  it('returns { ok:false } when claude exits before answering', async () => {
    const proc = makeFakeProc();
    mockSpawnClaude.mockResolvedValue(proc);
    const p = listModelsViaClaude({
      baseUrl: 'http://x',
      apiKey: 'sk',
      configDir: '/tmp/cfg',
      cwd: '/work',
    });
    await new Promise((r) => setImmediate(r));
    proc.__exit(2);
    const res = await p;
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('claude exited');
  });
});

describe('normaliseModels', () => {
  it('coerces string + object shapes and dedupes', () => {
    const out = __test__.normaliseModels([
      'claude-sonnet-4-5',
      { id: 'claude-opus-4-5', display_name: 'Opus' },
      { model: 'claude-haiku-4-5' },
      'claude-sonnet-4-5', // dupe
      { name: '' }, // empty
      null,
    ]);
    expect(out).toEqual([
      { id: 'claude-sonnet-4-5' },
      { id: 'claude-opus-4-5', displayName: 'Opus' },
      { id: 'claude-haiku-4-5' },
    ]);
  });

  it('returns [] for non-array input', () => {
    expect(__test__.normaliseModels(undefined)).toEqual([]);
    expect(__test__.normaliseModels(null)).toEqual([]);
    expect(__test__.normaliseModels({ models: [] })).toEqual([]);
  });
});
