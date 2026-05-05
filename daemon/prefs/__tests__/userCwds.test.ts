import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as os from 'os';

const stateStore = new Map<string, string>();
let throwOnLoad = false;
let throwOnSave = false;

vi.mock('../../db', () => ({
  loadState: (key: string) => {
    if (throwOnLoad) throw new Error('boom-load');
    return stateStore.has(key) ? stateStore.get(key)! : null;
  },
  saveState: (key: string, value: string) => {
    if (throwOnSave) throw new Error('boom-save');
    stateStore.set(key, value);
  },
}));

import {
  normalizeCwd,
  pushLRU,
  withHomeFallback,
  getUserCwds,
  pushUserCwd,
  USER_CWDS_KEY,
  USER_CWDS_MAX,
} from '../userCwds';

beforeEach(() => {
  stateStore.clear();
  throwOnLoad = false;
  throwOnSave = false;
});

// ─────────────────────── pure helpers ────────────────────────────────────

describe('normalizeCwd', () => {
  it('strips a single trailing slash', () => {
    expect(normalizeCwd('/home/user/')).toBe('/home/user');
  });
  it('strips a single trailing backslash', () => {
    expect(normalizeCwd('C:\\Users\\me\\')).toBe('C:\\Users\\me');
  });
  it('strips multiple trailing separators (mixed)', () => {
    expect(normalizeCwd('C:\\Users\\me\\\\//')).toBe('C:\\Users\\me');
  });
  it('leaves a path without trailing separators alone', () => {
    expect(normalizeCwd('/home/user')).toBe('/home/user');
  });
  it('preserves Windows drive-letter casing', () => {
    expect(normalizeCwd('C:\\Foo\\Bar')).toBe('C:\\Foo\\Bar');
  });
  it('does not expand a relative path (no resolve)', () => {
    expect(normalizeCwd('relative/path/')).toBe('relative/path');
  });
  it('returns empty string for empty input', () => {
    expect(normalizeCwd('')).toBe('');
  });
});

describe('pushLRU', () => {
  it('inserts a new item at the head of an empty list', () => {
    expect(pushLRU([], 'a')).toEqual(['a']);
  });
  it('inserts a new item at the head of a populated list', () => {
    expect(pushLRU(['b', 'c'], 'a')).toEqual(['a', 'b', 'c']);
  });
  it('moves an existing item to the head (LRU dedupe)', () => {
    expect(pushLRU(['a', 'b', 'c'], 'b')).toEqual(['b', 'a', 'c']);
  });
  it('dedupes case-insensitively', () => {
    expect(pushLRU(['/Foo', '/bar'], '/FOO')).toEqual(['/FOO', '/bar']);
  });
  it('caps the list at the default max=20', () => {
    const list = Array.from({ length: 20 }, (_, i) => `p${i}`);
    const out = pushLRU(list, 'new');
    expect(out).toHaveLength(20);
    expect(out[0]).toBe('new');
    expect(out[19]).toBe('p18'); // p19 dropped from tail
  });
  it('caps the list at a custom max', () => {
    expect(pushLRU(['a', 'b', 'c'], 'd', 2)).toEqual(['d', 'a']);
  });
  it('does not mutate the input list', () => {
    const input = ['a', 'b'];
    pushLRU(input, 'c');
    expect(input).toEqual(['a', 'b']);
  });
  it('returns a copy when item is empty (no mutation)', () => {
    const input = ['a', 'b'];
    const out = pushLRU(input, '');
    expect(out).toEqual(['a', 'b']);
    expect(out).not.toBe(input);
  });
});

describe('withHomeFallback', () => {
  it('returns [home] when list is empty', () => {
    expect(withHomeFallback([], '/home/u')).toEqual(['/home/u']);
  });
  it('appends home at tail when not present', () => {
    expect(withHomeFallback(['/a', '/b'], '/home/u')).toEqual(['/a', '/b', '/home/u']);
  });
  it('does not append home when already present (case-sensitive match)', () => {
    expect(withHomeFallback(['/a', '/home/u'], '/home/u')).toEqual(['/a', '/home/u']);
  });
  it('does not append home when already present (case-insensitive match)', () => {
    expect(withHomeFallback(['/a', '/Home/U'], '/home/u')).toEqual(['/a', '/Home/U']);
  });
  it('does not bump home to head when present in the middle', () => {
    expect(withHomeFallback(['/a', '/home/u', '/b'], '/home/u')).toEqual(['/a', '/home/u', '/b']);
  });
  it('does not mutate the input list', () => {
    const input = ['/a'];
    withHomeFallback(input, '/home/u');
    expect(input).toEqual(['/a']);
  });
});

// ─────────────────────── I/O wrappers ────────────────────────────────────

describe('getUserCwds', () => {
  it('returns [home] on a fresh DB', () => {
    expect(getUserCwds()).toEqual([os.homedir()]);
  });
  it('returns the stored list with home appended when missing', () => {
    stateStore.set(USER_CWDS_KEY, JSON.stringify(['/a', '/b']));
    const out = getUserCwds();
    expect(out).toEqual(['/a', '/b', os.homedir()]);
  });
  it('does not duplicate home when already in the stored list', () => {
    stateStore.set(USER_CWDS_KEY, JSON.stringify(['/a', os.homedir(), '/b']));
    expect(getUserCwds()).toEqual(['/a', os.homedir(), '/b']);
  });
  it('returns [home] when the stored JSON is malformed', () => {
    stateStore.set(USER_CWDS_KEY, 'not-json{');
    expect(getUserCwds()).toEqual([os.homedir()]);
  });
  it('returns [home] when the stored JSON is not an array', () => {
    stateStore.set(USER_CWDS_KEY, JSON.stringify({ not: 'array' }));
    expect(getUserCwds()).toEqual([os.homedir()]);
  });
  it('filters non-string entries from the stored list', () => {
    stateStore.set(USER_CWDS_KEY, JSON.stringify(['/a', 42, null, '/b']));
    const out = getUserCwds();
    expect(out).toEqual(['/a', '/b', os.homedir()]);
  });
  it('returns [home] when loadState throws', () => {
    throwOnLoad = true;
    expect(getUserCwds()).toEqual([os.homedir()]);
  });
});

describe('pushUserCwd', () => {
  it('inserts a new entry at the LRU head and persists it', () => {
    const out = pushUserCwd('/proj/a');
    expect(out).toEqual(['/proj/a']);
    expect(JSON.parse(stateStore.get(USER_CWDS_KEY)!)).toEqual(['/proj/a']);
  });
  it('normalizes trailing separators on push', () => {
    pushUserCwd('/proj/a/');
    expect(JSON.parse(stateStore.get(USER_CWDS_KEY)!)).toEqual(['/proj/a']);
  });
  it('moves an existing entry to the head (case-insensitive dedupe)', () => {
    stateStore.set(USER_CWDS_KEY, JSON.stringify(['/Proj/A', '/proj/b']));
    const out = pushUserCwd('/PROJ/A');
    expect(out).toEqual(['/PROJ/A', '/proj/b']);
  });
  it('caps the persisted list at USER_CWDS_MAX (20)', () => {
    const seed = Array.from({ length: USER_CWDS_MAX }, (_, i) => `/p${i}`);
    stateStore.set(USER_CWDS_KEY, JSON.stringify(seed));
    const out = pushUserCwd('/new');
    expect(out).toHaveLength(USER_CWDS_MAX);
    expect(out[0]).toBe('/new');
    // Last element of original (`/p19`) was dropped.
    expect(out).not.toContain('/p19');
  });
  it('returns the existing list unchanged for an empty/whitespace input (no write)', () => {
    stateStore.set(USER_CWDS_KEY, JSON.stringify(['/keep']));
    const out = pushUserCwd('');
    expect(out).toEqual(['/keep']);
    // Stored value untouched (still the original JSON we set).
    expect(JSON.parse(stateStore.get(USER_CWDS_KEY)!)).toEqual(['/keep']);
  });
  it('survives a saveState throw without crashing', () => {
    throwOnSave = true;
    expect(() => pushUserCwd('/proj/a')).not.toThrow();
  });
});
