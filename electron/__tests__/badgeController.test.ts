import { describe, it, expect, vi } from 'vitest';
import { decideBadgeClear, BadgeController } from '../badgeController';
import type { BadgeManager } from '../notify/badge';

describe('decideBadgeClear', () => {
  // 4 truth combinations of (focused, activeSid present, hasBadge):
  // only the all-true case clears.
  it('clears when focused + activeSid + hasBadge', () => {
    expect(decideBadgeClear({ focused: true, activeSid: 'sid-1', hasBadge: true })).toBe(true);
  });
  it('does not clear when not focused', () => {
    expect(decideBadgeClear({ focused: false, activeSid: 'sid-1', hasBadge: true })).toBe(false);
  });
  it('does not clear when activeSid is null', () => {
    expect(decideBadgeClear({ focused: true, activeSid: null, hasBadge: true })).toBe(false);
  });
  it('does not clear when activeSid is empty string', () => {
    expect(decideBadgeClear({ focused: true, activeSid: '', hasBadge: true })).toBe(false);
  });
  it('does not clear when hasBadge is false (no manager wired)', () => {
    expect(decideBadgeClear({ focused: true, activeSid: 'sid-1', hasBadge: false })).toBe(false);
  });
  it('does not clear when nothing is true', () => {
    expect(decideBadgeClear({ focused: false, activeSid: null, hasBadge: false })).toBe(false);
  });
});

describe('BadgeController.onFocusChange', () => {
  function makeMgr() {
    return {
      clearSid: vi.fn<(sid: string) => void>(),
    } as unknown as BadgeManager & { clearSid: ReturnType<typeof vi.fn> };
  }

  it('calls clearSid with the active sid when focused + sid present + manager wired', () => {
    const mgr = makeMgr();
    const ctrl = new BadgeController(() => mgr);
    ctrl.onFocusChange({ focused: true, activeSid: 'sid-A' });
    expect(mgr.clearSid).toHaveBeenCalledTimes(1);
    expect(mgr.clearSid).toHaveBeenCalledWith('sid-A');
  });

  it('does NOT call clearSid when not focused', () => {
    const mgr = makeMgr();
    const ctrl = new BadgeController(() => mgr);
    ctrl.onFocusChange({ focused: false, activeSid: 'sid-A' });
    expect(mgr.clearSid).not.toHaveBeenCalled();
  });

  it('does NOT call clearSid when activeSid is null', () => {
    const mgr = makeMgr();
    const ctrl = new BadgeController(() => mgr);
    ctrl.onFocusChange({ focused: true, activeSid: null });
    expect(mgr.clearSid).not.toHaveBeenCalled();
  });

  it('does NOT throw when manager getter returns null', () => {
    const ctrl = new BadgeController(() => null);
    expect(() => ctrl.onFocusChange({ focused: true, activeSid: 'sid-A' })).not.toThrow();
  });

  it('re-resolves the manager on every call (late-bound)', () => {
    let mgr: ReturnType<typeof makeMgr> | null = null;
    const ctrl = new BadgeController(() => mgr);
    // First call: no manager — no-op.
    ctrl.onFocusChange({ focused: true, activeSid: 'sid-A' });
    // Wire up later.
    mgr = makeMgr();
    ctrl.onFocusChange({ focused: true, activeSid: 'sid-B' });
    expect(mgr.clearSid).toHaveBeenCalledTimes(1);
    expect(mgr.clearSid).toHaveBeenCalledWith('sid-B');
  });
});
