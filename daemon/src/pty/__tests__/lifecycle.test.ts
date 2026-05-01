import { describe, expect, it } from 'vitest';
import {
  PTY_LIFECYCLE_STATES,
  transition,
  type PtyLifecycleEvent,
  type PtyLifecycleEventKind,
  type PtyLifecycleResult,
  type PtyLifecycleState,
  type PtyLifecycleStateOrInitial,
} from '../lifecycle.js';

// T37 — pure FSM tests. No I/O, no DB, no PTY. Verifies every legal and
// illegal (state, event) pair against the spec table in lifecycle.ts.

const ALL_STATES: PtyLifecycleStateOrInitial[] = [
  'initial',
  ...PTY_LIFECYCLE_STATES,
];

const ALL_EVENT_KINDS: PtyLifecycleEventKind[] = [
  'start',
  'pause',
  'resume',
  'exit',
  'shutdown_request',
  'crash',
  'force_kill',
];

function makeEvent(kind: PtyLifecycleEventKind, exitCode = 0): PtyLifecycleEvent {
  switch (kind) {
    case 'start':
      return { kind: 'start' };
    case 'pause':
      return { kind: 'pause' };
    case 'resume':
      return { kind: 'resume' };
    case 'exit':
      return { kind: 'exit', exitCode };
    case 'shutdown_request':
      return { kind: 'shutdown_request' };
    case 'crash':
      return { kind: 'crash', reason: 'test' };
    case 'force_kill':
      return { kind: 'force_kill' };
  }
}

function expectOk(
  result: PtyLifecycleResult,
): asserts result is Extract<PtyLifecycleResult, { ok: true }> {
  if (!result.ok) {
    throw new Error(
      `expected ok transition, got illegal_transition from=${result.error.from} event=${result.error.event}`,
    );
  }
}

function expectIllegal(
  result: PtyLifecycleResult,
  from: PtyLifecycleStateOrInitial,
  event: PtyLifecycleEventKind,
): void {
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error).toEqual({ kind: 'illegal_transition', from, event });
}

describe('PTY_LIFECYCLE_STATES — T28 schema source-of-truth', () => {
  it('matches sessions.state CHECK enum', () => {
    expect([...PTY_LIFECYCLE_STATES].sort()).toEqual(
      ['running', 'paused', 'exited', 'shutting_down', 'crashed'].sort(),
    );
  });
});

describe('legal transitions (per frag-3.5.1 §3.5.1.2)', () => {
  it('initial.start → running', () => {
    const r = transition('initial', { kind: 'start' });
    expectOk(r);
    expect(r.transition.state).toBe<PtyLifecycleState>('running');
    expect(r.transition.output).toBeUndefined();
  });

  it('running.shutdown_request → shutting_down (step 2)', () => {
    const r = transition('running', { kind: 'shutdown_request' });
    expectOk(r);
    expect(r.transition.state).toBe('shutting_down');
  });

  it('running.exit(0) → exited with output.exitCode=0', () => {
    const r = transition('running', { kind: 'exit', exitCode: 0 });
    expectOk(r);
    expect(r.transition.state).toBe('exited');
    expect(r.transition.output).toEqual({ exitCode: 0, signal: null });
  });

  it('running.exit(non-zero) → crashed (clean spec mapping)', () => {
    const r = transition('running', { kind: 'exit', exitCode: 137 });
    expectOk(r);
    expect(r.transition.state).toBe('crashed');
    expect(r.transition.output).toEqual({ exitCode: 137, signal: null });
  });

  it('running.exit carries signal field through output', () => {
    const r = transition('running', {
      kind: 'exit',
      exitCode: 143,
      signal: 'SIGTERM',
    });
    expectOk(r);
    expect(r.transition.output).toEqual({ exitCode: 143, signal: 'SIGTERM' });
  });

  it('running.crash(reason) → crashed with output.reason', () => {
    const r = transition('running', { kind: 'crash', reason: 'jobobject_term' });
    expectOk(r);
    expect(r.transition.state).toBe('crashed');
    expect(r.transition.output).toEqual({ reason: 'jobobject_term' });
  });

  it('running.pause → paused', () => {
    const r = transition('running', { kind: 'pause' });
    expectOk(r);
    expect(r.transition.state).toBe('paused');
  });

  it('running.force_kill → running (signal-only, no state change)', () => {
    const r = transition('running', { kind: 'force_kill' });
    expectOk(r);
    expect(r.transition.state).toBe('running');
  });

  it('shutting_down.exit(0) → exited (step 6 clean reap)', () => {
    const r = transition('shutting_down', { kind: 'exit', exitCode: 0 });
    expectOk(r);
    expect(r.transition.state).toBe('exited');
    expect(r.transition.output).toEqual({ exitCode: 0, signal: null });
  });

  it('shutting_down.exit(non-zero) → crashed', () => {
    const r = transition('shutting_down', { kind: 'exit', exitCode: 1 });
    expectOk(r);
    expect(r.transition.state).toBe('crashed');
  });

  it('shutting_down.pause → paused (step 8 final sweep survivor)', () => {
    const r = transition('shutting_down', { kind: 'pause' });
    expectOk(r);
    expect(r.transition.state).toBe('paused');
  });

  it('shutting_down.crash → crashed', () => {
    const r = transition('shutting_down', { kind: 'crash', reason: 'kill9' });
    expectOk(r);
    expect(r.transition.state).toBe('crashed');
  });

  it('shutting_down.shutdown_request → shutting_down (idempotent drain)', () => {
    const r = transition('shutting_down', { kind: 'shutdown_request' });
    expectOk(r);
    expect(r.transition.state).toBe('shutting_down');
  });

  it('shutting_down.force_kill → shutting_down (escalation, no state change)', () => {
    const r = transition('shutting_down', { kind: 'force_kill' });
    expectOk(r);
    expect(r.transition.state).toBe('shutting_down');
  });

  it('paused.resume → running (frag-6-7 §6.3 next-boot recovery)', () => {
    const r = transition('paused', { kind: 'resume' });
    expectOk(r);
    expect(r.transition.state).toBe('running');
  });
});

describe('illegal transitions — typed error', () => {
  it('initial rejects every event except start', () => {
    for (const kind of ALL_EVENT_KINDS) {
      if (kind === 'start') continue;
      const r = transition('initial', makeEvent(kind));
      expectIllegal(r, 'initial', kind);
    }
  });

  it('running rejects start and resume', () => {
    expectIllegal(transition('running', { kind: 'start' }), 'running', 'start');
    expectIllegal(transition('running', { kind: 'resume' }), 'running', 'resume');
  });

  it('shutting_down rejects start and resume', () => {
    expectIllegal(
      transition('shutting_down', { kind: 'start' }),
      'shutting_down',
      'start',
    );
    expectIllegal(
      transition('shutting_down', { kind: 'resume' }),
      'shutting_down',
      'resume',
    );
  });

  it('paused rejects every event except resume', () => {
    for (const kind of ALL_EVENT_KINDS) {
      if (kind === 'resume') continue;
      const r = transition('paused', makeEvent(kind));
      expectIllegal(r, 'paused', kind);
    }
  });

  it('exited rejects every event (terminal — idempotency)', () => {
    for (const kind of ALL_EVENT_KINDS) {
      const r = transition('exited', makeEvent(kind));
      expectIllegal(r, 'exited', kind);
    }
  });

  it('exited.exit(code) is illegal (already exited — idempotency)', () => {
    const r = transition('exited', { kind: 'exit', exitCode: 0 });
    expectIllegal(r, 'exited', 'exit');
  });

  it('crashed rejects every event including start (no in-place restart)', () => {
    for (const kind of ALL_EVENT_KINDS) {
      const r = transition('crashed', makeEvent(kind));
      expectIllegal(r, 'crashed', kind);
    }
  });

  it('crashed.start is explicitly illegal (fresh session row required)', () => {
    const r = transition('crashed', { kind: 'start' });
    expectIllegal(r, 'crashed', 'start');
  });
});

describe('full (state × event) coverage matrix', () => {
  it('every (state, event) pair returns either ok or typed illegal_transition', () => {
    for (const from of ALL_STATES) {
      for (const kind of ALL_EVENT_KINDS) {
        const r = transition(from, makeEvent(kind));
        if (r.ok) {
          expect(PTY_LIFECYCLE_STATES).toContain(r.transition.state);
        } else {
          expect(r.error.kind).toBe('illegal_transition');
          expect(r.error.from).toBe(from);
          expect(r.error.event).toBe(kind);
        }
      }
    }
  });
});

describe('purity', () => {
  it('repeated calls with the same input return equal results (no hidden state)', () => {
    const a = transition('running', { kind: 'exit', exitCode: 0 });
    const b = transition('running', { kind: 'exit', exitCode: 0 });
    expect(a).toEqual(b);
  });

  it('does not mutate the input event object', () => {
    const ev: PtyLifecycleEvent = { kind: 'exit', exitCode: 7, signal: 'SIGSEGV' };
    const snapshot = JSON.parse(JSON.stringify(ev));
    transition('running', ev);
    expect(ev).toEqual(snapshot);
  });
});
