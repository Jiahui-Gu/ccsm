import { describe, it, expect } from 'vitest';
import { cwdToProjectKey } from '../projectKey.js';

describe('cwdToProjectKey', () => {
  it.each([
    // [input, expected]
    ['C:\\Users\\jiahuigu', 'C--Users-jiahuigu'],
    [
      'C:\\Users\\jiahuigu\\ccsm-worktrees\\pool-7',
      'C--Users-jiahuigu-ccsm-worktrees-pool-7',
    ],
    ['/home/user/project', '-home-user-project'],
    ['/Users/jiahui/code/ccsm', '-Users-jiahui-code-ccsm'],
    // colon-only (drive letter) replaced
    ['C:', 'C-'],
    // backslash-only
    ['\\foo\\bar', '-foo-bar'],
    // forward-slash-only
    ['/foo/bar', '-foo-bar'],
    // mixed separators
    ['C:/mixed\\path', 'C--mixed-path'],
    // no separators — passthrough
    ['plainname', 'plainname'],
    // empty string — empty result, not crash
    ['', ''],
  ])('%s → %s', (input, expected) => {
    expect(cwdToProjectKey(input)).toBe(expected);
  });

  it('non-string input returns empty string (defensive)', () => {
    // @ts-expect-error — runtime defensive branch (undefined)
    expect(cwdToProjectKey(undefined)).toBe('');
    // @ts-expect-error — runtime defensive branch (null)
    expect(cwdToProjectKey(null)).toBe('');
    // @ts-expect-error — runtime defensive branch (number)
    expect(cwdToProjectKey(123)).toBe('');
  });

  it('does not collapse consecutive separators (CLI convention)', () => {
    // CLI convention is 1:1 char replacement; "C:\" → 3 chars → "C--"
    expect(cwdToProjectKey('C:\\')).toBe('C--');
    expect(cwdToProjectKey('//')).toBe('--');
  });
});
