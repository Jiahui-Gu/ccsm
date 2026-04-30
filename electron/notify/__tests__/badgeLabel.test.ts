import { describe, it, expect } from 'vitest';
import { badgeLabel } from '../badgeLabel';

// Pure decider: input -> output, no side effects. The display rule is
// load-bearing for the tray badge UX (Task #722 Phase A spec):
//   * n <= 0      -> ''
//   * 1 <= n <= 9 -> '<n>'
//   * n >= 10     -> '9+'
describe('badgeLabel', () => {
  it('returns empty string for zero or negative counts', () => {
    expect(badgeLabel(0)).toBe('');
    expect(badgeLabel(-1)).toBe('');
    expect(badgeLabel(-100)).toBe('');
  });

  it('returns the bare number 1..9', () => {
    for (let i = 1; i <= 9; i++) {
      expect(badgeLabel(i)).toBe(String(i));
    }
  });

  it("collapses 10+ to '9+'", () => {
    expect(badgeLabel(10)).toBe('9+');
    expect(badgeLabel(99)).toBe('9+');
    expect(badgeLabel(1_000_000)).toBe('9+');
  });
});
