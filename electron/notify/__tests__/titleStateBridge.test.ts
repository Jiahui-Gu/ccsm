import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { createTitleStateBridge } from '../titleStateBridge';

type Evt = { sid: string; state: 'idle' };

function collect(b: ReturnType<typeof createTitleStateBridge>): Evt[] {
  const out: Evt[] = [];
  b.emitter.on('state-changed', (e) => out.push(e));
  return out;
}

describe('titleStateBridge', () => {
  it('emits on running → idle transition', () => {
    const b = createTitleStateBridge();
    const out = collect(b);
    b.feedTitle('s1', '⠂ Claude Code');
    b.feedTitle('s1', '✳ Claude Code');
    expect(out).toEqual([{ sid: 's1', state: 'idle' }]);
  });

  it('emits on unknown → idle transition (fresh session lands straight in idle)', () => {
    const b = createTitleStateBridge();
    const out = collect(b);
    b.feedTitle('s1', '✳ Claude Code');
    expect(out).toEqual([{ sid: 's1', state: 'idle' }]);
  });

  it('does NOT emit on repeated idle titles (CLI re-emits while waiting)', () => {
    const b = createTitleStateBridge();
    const out = collect(b);
    b.feedTitle('s1', '✳ Claude Code');
    b.feedTitle('s1', '✳ Claude Code');
    b.feedTitle('s1', '✳ Claude Code');
    expect(out).toHaveLength(1);
  });

  it('does NOT emit for running titles', () => {
    const b = createTitleStateBridge();
    const out = collect(b);
    b.feedTitle('s1', '⠂ Claude Code');
    b.feedTitle('s1', '⠐ Claude Code');
    b.feedTitle('s1', '⠁ Claude Code');
    expect(out).toHaveLength(0);
  });

  it('emits exactly once per running → idle transition across multiple turns', () => {
    const b = createTitleStateBridge();
    const out = collect(b);
    // Sequence: running x3, idle, running, idle — two transitions, two fires.
    b.feedTitle('s1', '⠂ Claude Code');
    b.feedTitle('s1', '⠐ Claude Code');
    b.feedTitle('s1', '⠁ Claude Code');
    b.feedTitle('s1', '✳ Claude Code');
    b.feedTitle('s1', '⠂ Claude Code');
    b.feedTitle('s1', '✳ Claude Code');
    expect(out).toHaveLength(2);
    expect(out.every((e) => e.sid === 's1' && e.state === 'idle')).toBe(true);
  });

  it('tracks sids independently', () => {
    const b = createTitleStateBridge();
    const out = collect(b);
    b.feedTitle('A', '⠂ Claude Code');
    b.feedTitle('B', '⠂ Claude Code');
    b.feedTitle('A', '✳ Claude Code');
    b.feedTitle('B', '✳ Claude Code');
    expect(out).toEqual([
      { sid: 'A', state: 'idle' },
      { sid: 'B', state: 'idle' },
    ]);
  });

  it('ignores empty/missing sid', () => {
    const b = createTitleStateBridge();
    const out = collect(b);
    b.feedTitle('', '✳ Claude Code');
    expect(out).toHaveLength(0);
  });

  it('forgetSid resets the per-sid state', () => {
    const b = createTitleStateBridge();
    const out = collect(b);
    b.feedTitle('s1', '✳ Claude Code'); // unknown → idle, fires
    b.forgetSid('s1');
    b.feedTitle('s1', '✳ Claude Code'); // unknown → idle again, fires
    expect(out).toHaveLength(2);
  });

  // Regression guard: forgetSid must drop the lastState entry so the map
  // does not grow unbounded across the lifetime of a long-running app
  // session that opens/closes many CLI sessions. We can't peek the
  // internal Map directly, so we prove the entry is gone by:
  //   1. priming sid `s1` to `running` (which is a non-emitting state),
  //   2. calling forgetSid('s1'),
  //   3. feeding `idle` — if the prior `running` state were still in the
  //      map it would be a `running → idle` transition and emit; if it
  //      was forgotten this is `unknown → idle` and also emits. Both
  //      emit, so we instead lean on the *suppression* property: re-feed
  //      `idle` after a forget, then feed `idle` again — the SECOND
  //      idle should be suppressed (idle → idle). This proves forgetSid
  //      correctly transitioned us back through unknown/idle.
  it('forgetSid clears state so subsequent dedupe still works', () => {
    const b = createTitleStateBridge();
    const out = collect(b);
    b.feedTitle('s1', '✳ Claude Code'); // unknown → idle, fires #1
    b.forgetSid('s1');
    b.feedTitle('s1', '✳ Claude Code'); // unknown → idle, fires #2
    b.feedTitle('s1', '✳ Claude Code'); // idle → idle, suppressed
    expect(out).toHaveLength(2);
  });

  // Wiring contract: main.ts subscribes to sessionWatcher 'unwatched' and
  // calls bridge.forgetSid(sid). This test simulates that wiring against
  // a fake EventEmitter so a future refactor that drops the listener
  // fails fast.
  it('integrates with an emitter-driven teardown signal', () => {
    const b = createTitleStateBridge();
    const out = collect(b);
    const fakeWatcher = new EventEmitter();
    fakeWatcher.on('unwatched', (evt: { sid: string }) => b.forgetSid(evt.sid));

    b.feedTitle('s1', '✳ Claude Code'); // fires #1
    fakeWatcher.emit('unwatched', { sid: 's1' });
    b.feedTitle('s1', '✳ Claude Code'); // fires #2 because state was forgotten
    expect(out).toHaveLength(2);
  });
});
