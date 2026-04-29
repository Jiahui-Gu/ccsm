import { describe, it, expect } from 'vitest';
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
});
