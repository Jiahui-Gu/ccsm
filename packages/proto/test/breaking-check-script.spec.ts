// packages/proto/test/breaking-check-script.spec.ts
//
// Unit tests for scripts/breaking-check.mjs ref-selection logic. We do
// NOT exec `buf breaking` here — that's covered by the CI step itself.
// Here we exercise the pure helpers that decide which baseline ref to
// compare against per ch11 §4 / ch15 §3 #1, #2, #19, #20:
//
//   1. BUF_BREAKING_AGAINST env override wins.
//   2. Otherwise, highest v0.3.* git tag wins (post-tag mode).
//   3. Otherwise, merge-base against origin/$GITHUB_BASE_REF wins
//      (pre-tag mode).
//   4. Otherwise, merge-base against origin/working, then origin/main.
//   5. If none resolves, the resolver returns ref:null (caller exits 1).
//
// The git accessor is injected so we can simulate each state without
// touching the real repo. buildAgainstArg is also covered.

import { describe, expect, it } from 'vitest';

import {
  buildAgainstArg,
  pickMergeBase,
  pickV03Tag,
  resolveAgainst,
} from '../scripts/breaking-check.mjs';

/**
 * Build a fake git() that responds to a fixed table of arg-arrays. Any
 * unmatched call returns null (mirrors the real script's "git failed"
 * convention). The keys are JSON-stringified arg arrays for stable
 * lookup across Windows/Unix.
 */
function fakeGit(table: Record<string, string | null>) {
  return (args: readonly string[]) => {
    const key = JSON.stringify(args);
    return key in table ? table[key] : null;
  };
}

describe('breaking-check ref selection', () => {
  describe('pickV03Tag', () => {
    it('returns highest v0.3.* tag when present', () => {
      const git = fakeGit({
        [JSON.stringify(['tag', '--list', 'v0.3.*', '--sort=-v:refname'])]:
          'v0.3.1\nv0.3.0\nv0.3.0-rc.1',
      });
      expect(pickV03Tag(git)).toBe('v0.3.1');
    });

    it('returns null when no v0.3 tag exists', () => {
      const git = fakeGit({
        [JSON.stringify(['tag', '--list', 'v0.3.*', '--sort=-v:refname'])]: '',
      });
      expect(pickV03Tag(git)).toBeNull();
    });

    it('returns null when git itself fails', () => {
      const git = fakeGit({});
      expect(pickV03Tag(git)).toBeNull();
    });

    it('trims whitespace lines defensively', () => {
      const git = fakeGit({
        [JSON.stringify(['tag', '--list', 'v0.3.*', '--sort=-v:refname'])]:
          '  v0.3.2  \n\nv0.3.1\n',
      });
      expect(pickV03Tag(git)).toBe('v0.3.2');
    });
  });

  describe('pickMergeBase', () => {
    it('uses origin/$GITHUB_BASE_REF when set and reachable', () => {
      const git = fakeGit({
        [JSON.stringify(['rev-parse', '--verify', '--quiet', 'origin/working'])]:
          'abc123',
        [JSON.stringify(['merge-base', 'HEAD', 'origin/working'])]: 'mergebase-sha',
      });
      const env = { GITHUB_BASE_REF: 'working' };
      expect(pickMergeBase(env, git)).toBe('mergebase-sha');
    });

    it('falls back to origin/working when GITHUB_BASE_REF unset', () => {
      const git = fakeGit({
        [JSON.stringify(['rev-parse', '--verify', '--quiet', 'origin/working'])]:
          'abc123',
        [JSON.stringify(['merge-base', 'HEAD', 'origin/working'])]: 'wb-sha',
      });
      expect(pickMergeBase({}, git)).toBe('wb-sha');
    });

    it('falls back to origin/main when working unreachable', () => {
      const git = fakeGit({
        [JSON.stringify(['rev-parse', '--verify', '--quiet', 'origin/main'])]:
          'abc123',
        [JSON.stringify(['merge-base', 'HEAD', 'origin/main'])]: 'main-sha',
      });
      expect(pickMergeBase({}, git)).toBe('main-sha');
    });

    it('returns null when nothing resolves', () => {
      expect(pickMergeBase({}, fakeGit({}))).toBeNull();
    });

    it('skips rev-parse-failing candidates and tries the next', () => {
      // GITHUB_BASE_REF points at a branch the runner did not fetch.
      const git = fakeGit({
        // origin/feature missing → rev-parse returns null
        [JSON.stringify(['rev-parse', '--verify', '--quiet', 'origin/working'])]:
          'abc123',
        [JSON.stringify(['merge-base', 'HEAD', 'origin/working'])]: 'wb-sha',
      });
      const env = { GITHUB_BASE_REF: 'feature' };
      expect(pickMergeBase(env, git)).toBe('wb-sha');
    });
  });

  describe('resolveAgainst', () => {
    it('honours BUF_BREAKING_AGAINST override above tags and merge-base', () => {
      const git = fakeGit({
        [JSON.stringify(['tag', '--list', 'v0.3.*', '--sort=-v:refname'])]: 'v0.3.0',
      });
      expect(resolveAgainst({ BUF_BREAKING_AGAINST: 'pinned-sha' }, git)).toEqual({
        ref: 'pinned-sha',
        source: 'env',
      });
    });

    it('prefers v0.3 tag over merge-base when no override', () => {
      const git = fakeGit({
        [JSON.stringify(['tag', '--list', 'v0.3.*', '--sort=-v:refname'])]: 'v0.3.0',
        [JSON.stringify(['rev-parse', '--verify', '--quiet', 'origin/working'])]:
          'abc123',
        [JSON.stringify(['merge-base', 'HEAD', 'origin/working'])]: 'wb-sha',
      });
      expect(resolveAgainst({}, git)).toEqual({ ref: 'v0.3.0', source: 'v0.3-tag' });
    });

    it('falls back to merge-base when no v0.3 tag', () => {
      const git = fakeGit({
        [JSON.stringify(['tag', '--list', 'v0.3.*', '--sort=-v:refname'])]: '',
        [JSON.stringify(['rev-parse', '--verify', '--quiet', 'origin/working'])]:
          'abc123',
        [JSON.stringify(['merge-base', 'HEAD', 'origin/working'])]: 'wb-sha',
      });
      expect(resolveAgainst({}, git)).toEqual({ ref: 'wb-sha', source: 'merge-base' });
    });

    it('returns ref:null when nothing works', () => {
      expect(resolveAgainst({}, fakeGit({}))).toEqual({ ref: null, source: 'none' });
    });
  });

  describe('buildAgainstArg', () => {
    it('emits the .git#ref=...,subdir=packages/proto form', () => {
      expect(buildAgainstArg('deadbeef')).toBe(
        '.git#ref=deadbeef,subdir=packages/proto',
      );
    });

    it('handles tag refs without quoting', () => {
      expect(buildAgainstArg('v0.3.0')).toBe('.git#ref=v0.3.0,subdir=packages/proto');
    });
  });
});
