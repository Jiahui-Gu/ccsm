import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  SdkSessionRunner,
  __setSdkModuleForTests,
} from '../electron/agent-sdk/sessions';
import type { StartOptions } from '../electron/agent/sessions';

// Minimal SDK shape the runner touches: query() returning an AsyncIterator
// + close()/interrupt()/setMaxThinkingTokens()/applyFlagSettings(). We
// fake it per-test so we can assert downgrade behaviour without a real
// CLI subprocess.

type FakeQueryOpts = {
  // First-call behaviour: 'success' yields one system init frame; 'error'
  // throws the supplied Error from .next().
  firstCall: 'success' | 'error';
  firstCallError?: Error;
  applyFlagSettingsBehaviour?: (settings: Record<string, unknown>) => Promise<void>;
};

function makeFakeSdk(
  queries: FakeQueryOpts[],
  observed: { effortAttempts: (string | undefined)[]; applyAttempts: unknown[] },
) {
  let queryIndex = 0;
  const fakeQuery = (call: { options: { effort?: string } }) => {
    const i = queryIndex++;
    const cfg = queries[i];
    if (!cfg) throw new Error(`unexpected query() call #${i}`);
    observed.effortAttempts.push(call.options.effort);
    let yielded = false;
    let endResolve: (() => void) | null = null;
    const endPromise = new Promise<void>((r) => { endResolve = r; });
    const iter: AsyncIterator<unknown> & {
      [Symbol.asyncIterator](): AsyncIterator<unknown>;
      close(): void;
      interrupt(): Promise<void>;
      setMaxThinkingTokens(n: number | null): Promise<void>;
      applyFlagSettings(s: Record<string, unknown>): Promise<void>;
    } = {
      async next() {
        if (cfg.firstCall === 'error') {
          throw cfg.firstCallError ?? new Error('unspecified error');
        }
        if (yielded) {
          // Block until close() so consumer stays alive — mirrors a real
          // SDK session waiting for further frames.
          await endPromise;
          return { done: true, value: undefined };
        }
        yielded = true;
        return {
          done: false,
          value: {
            type: 'system',
            subtype: 'init',
            session_id: 'sid-fake',
          },
        };
      },
      [Symbol.asyncIterator]() {
        return this;
      },
      close() {
        if (endResolve) endResolve();
      },
      interrupt: async () => {},
      setMaxThinkingTokens: async (_n: number | null) => {},
      applyFlagSettings: async (settings: Record<string, unknown>) => {
        observed.applyAttempts.push(settings.effortLevel);
        if (cfg.applyFlagSettingsBehaviour) {
          return cfg.applyFlagSettingsBehaviour(settings);
        }
      },
    };
    return iter;
  };
  return {
    query: fakeQuery,
  } as unknown as typeof import('@anthropic-ai/claude-agent-sdk');
}

// SdkSessionRunner.start() resolves the user binary via binary-resolver.
// Skip that path by supplying an explicit binaryPath on the StartOptions —
// the runner short-circuits resolveClaudeInvocation when binaryPath is set.
function baseOpts(over: Partial<StartOptions> = {}): StartOptions {
  return {
    cwd: '/tmp',
    binaryPath: '/fake/claude',
    permissionMode: 'default',
    ...over,
  };
}

afterEach(() => {
  __setSdkModuleForTests(null);
  vi.useRealTimers();
});

describe('SdkSessionRunner: launch effort fallback', () => {
  it('downgrades from max -> high when CLI rejects "effort unsupported"', async () => {
    const observed = { effortAttempts: [] as (string | undefined)[], applyAttempts: [] as unknown[] };
    __setSdkModuleForTests(
      makeFakeSdk(
        [
          { firstCall: 'error', firstCallError: new Error('effort level "max" is not supported') },
          { firstCall: 'error', firstCallError: new Error('effort xhigh is unsupported by this model') },
          { firstCall: 'success' }, // high accepted
        ],
        observed,
      ),
    );
    const events: unknown[] = [];
    const exits: unknown[] = [];
    const diags: { code: string; message: string }[] = [];
    const runner = new SdkSessionRunner(
      'sid-1',
      (m) => events.push(m),
      (e) => exits.push(e),
      () => {},
      (d) => diags.push({ code: d.code, message: d.message }),
    );
    await runner.start(baseOpts({ effortLevel: 'max' }));
    // Spin the event loop so the spawned attemptRun + probe + downgrades run.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(observed.effortAttempts).toEqual(['max', 'xhigh', 'high']);
    // Two downgrade diagnostics + one success-after-downgrade diagnostic.
    expect(diags.filter((d) => d.code === 'effort_downgrade_on_launch').length).toBe(2);
    expect(diags.filter((d) => d.code === 'effort_downgraded_active').length).toBe(1);
    // No exit (consumer still alive).
    expect(exits.length).toBe(0);
    runner.close();
  });

  it('non-effort errors do NOT trigger downgrade — surfaces via onExit', async () => {
    const observed = { effortAttempts: [] as (string | undefined)[], applyAttempts: [] as unknown[] };
    __setSdkModuleForTests(
      makeFakeSdk(
        [{ firstCall: 'error', firstCallError: new Error('connection refused') }],
        observed,
      ),
    );
    const exits: { error?: string }[] = [];
    const runner = new SdkSessionRunner(
      'sid-2',
      () => {},
      (e) => exits.push(e),
      () => {},
    );
    await runner.start(baseOpts({ effortLevel: 'max' }));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(observed.effortAttempts).toEqual(['max']);
    expect(exits.length).toBe(1);
    expect(exits[0].error).toMatch(/connection refused/);
  });

  it('gives up at off, surfaces last error', async () => {
    const observed = { effortAttempts: [] as (string | undefined)[], applyAttempts: [] as unknown[] };
    __setSdkModuleForTests(
      makeFakeSdk(
        [
          { firstCall: 'error', firstCallError: new Error('effort max unsupported') },
          { firstCall: 'error', firstCallError: new Error('effort xhigh unsupported') },
          { firstCall: 'error', firstCallError: new Error('effort high unsupported') },
          { firstCall: 'error', firstCallError: new Error('effort medium unsupported') },
          { firstCall: 'error', firstCallError: new Error('effort low unsupported') },
          { firstCall: 'error', firstCallError: new Error('effort off unsupported') },
        ],
        observed,
      ),
    );
    const exits: { error?: string }[] = [];
    const runner = new SdkSessionRunner(
      'sid-3',
      () => {},
      (e) => exits.push(e),
      () => {},
    );
    await runner.start(baseOpts({ effortLevel: 'max' }));
    for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 0));
    expect(observed.effortAttempts).toEqual(['max', 'xhigh', 'high', 'medium', 'low', undefined]);
    expect(exits.length).toBe(1);
    expect(exits[0].error).toMatch(/effort off unsupported/);
  });
});

describe('SdkSessionRunner: mid-session effort fallback', () => {
  it('applyFlagSettings rejection downgrades and retries until accepted', async () => {
    const observed = { effortAttempts: [] as (string | undefined)[], applyAttempts: [] as unknown[] };
    __setSdkModuleForTests(
      makeFakeSdk(
        [
          {
            firstCall: 'success',
            applyFlagSettingsBehaviour: async (s) => {
              if (s.effortLevel === 'max' || s.effortLevel === 'xhigh') {
                throw new Error(`effort ${s.effortLevel} is not supported`);
              }
            },
          },
        ],
        observed,
      ),
    );
    const diags: { code: string }[] = [];
    const runner = new SdkSessionRunner(
      'sid-4',
      () => {},
      () => {},
      () => {},
      (d) => diags.push({ code: d.code }),
    );
    await runner.start(baseOpts({ effortLevel: 'high' }));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    // Mid-session: user picks max.
    await runner.setEffort('max');
    expect(observed.applyAttempts).toEqual(['max', 'xhigh', 'high']);
    expect(diags.filter((d) => d.code === 'effort_downgrade_on_apply').length).toBe(2);
    runner.close();
  });

  it('non-effort applyFlagSettings rejection does NOT loop — single warn', async () => {
    const observed = { effortAttempts: [] as (string | undefined)[], applyAttempts: [] as unknown[] };
    __setSdkModuleForTests(
      makeFakeSdk(
        [
          {
            firstCall: 'success',
            applyFlagSettingsBehaviour: async (s) => {
              if (s.effortLevel === 'max') throw new Error('something else broke');
            },
          },
        ],
        observed,
      ),
    );
    const diags: { code: string }[] = [];
    const runner = new SdkSessionRunner(
      'sid-5',
      () => {},
      () => {},
      () => {},
      (d) => diags.push({ code: d.code }),
    );
    await runner.start(baseOpts({ effortLevel: 'high' }));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    await runner.setEffort('max');
    // No downgrade diagnostics; just one apply_flag_settings_failed.
    expect(diags.filter((d) => d.code === 'effort_downgrade_on_apply').length).toBe(0);
    expect(diags.filter((d) => d.code === 'apply_flag_settings_failed').length).toBe(1);
    runner.close();
  });
});
