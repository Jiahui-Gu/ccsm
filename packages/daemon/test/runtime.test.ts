// Runtime unit tests — focused on the pure helpers in runtime.mts.
//
// Task #53 (R-19): lock both branches of `resolvePtyEntry` so prod behavior
// (env unset → `claude` REPL with `--session-id` / `--resume`) cannot regress
// and the smoke override (env set → bare program, no args) cannot accidentally
// gain claude-only flags.

import { describe, expect, it } from 'vitest';
import { resolvePtyEntry } from '../src/runtime.mjs';

describe('resolvePtyEntry (Task #53 / R-19)', () => {
  describe('env unset → prod claude path', () => {
    it('Windows create → claude.cmd --session-id <sid>', () => {
      expect(resolvePtyEntry(undefined, 'create', 'sid-A', true)).toEqual({
        cmd: 'claude.cmd',
        args: ['--session-id', 'sid-A'],
      });
    });

    it('Windows resume → claude.cmd --resume <sid>', () => {
      expect(resolvePtyEntry(undefined, 'resume', 'sid-B', true)).toEqual({
        cmd: 'claude.cmd',
        args: ['--resume', 'sid-B'],
      });
    });

    it('POSIX create → claude --session-id <sid>', () => {
      expect(resolvePtyEntry(undefined, 'create', 'sid-C', false)).toEqual({
        cmd: 'claude',
        args: ['--session-id', 'sid-C'],
      });
    });

    it('POSIX resume → claude --resume <sid>', () => {
      expect(resolvePtyEntry(undefined, 'resume', 'sid-D', false)).toEqual({
        cmd: 'claude',
        args: ['--resume', 'sid-D'],
      });
    });

    it('empty string treated as unset (still claude path)', () => {
      expect(resolvePtyEntry('', 'create', 'sid-E', true)).toEqual({
        cmd: 'claude.cmd',
        args: ['--session-id', 'sid-E'],
      });
    });
  });

  describe('env set → smoke override path', () => {
    it('cmd.exe override on Windows create → empty argv (no --session-id)', () => {
      expect(resolvePtyEntry('cmd.exe', 'create', 'sid-F', true)).toEqual({
        cmd: 'cmd.exe',
        args: [],
      });
    });

    it('cmd.exe override on Windows resume → empty argv (no --resume)', () => {
      expect(resolvePtyEntry('cmd.exe', 'resume', 'sid-G', true)).toEqual({
        cmd: 'cmd.exe',
        args: [],
      });
    });

    it('/bin/sh override on POSIX create → empty argv', () => {
      expect(resolvePtyEntry('/bin/sh', 'create', 'sid-H', false)).toEqual({
        cmd: '/bin/sh',
        args: [],
      });
    });

    it('override wins regardless of platform', () => {
      // smoke fixture sets cmd.exe on win32 / /bin/sh elsewhere; the resolver
      // itself does not second-guess the choice — it just passes through.
      expect(resolvePtyEntry('cmd.exe', 'resume', 'sid-I', false)).toEqual({
        cmd: 'cmd.exe',
        args: [],
      });
    });
  });
});
