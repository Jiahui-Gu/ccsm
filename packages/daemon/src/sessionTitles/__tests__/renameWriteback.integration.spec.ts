// Integration test against the real `@anthropic-ai/claude-agent-sdk`.
//
// Reproduces the sidebar-rename writeback bug (eval #647 / task #650): the
// renderer hands `renameSessionTitle` a `dir` that does not realpath-encode
// to the project-key directory under which the session JSONL actually lives
// (common on Windows when the cwd was renamed/moved/case-shifted between
// session creation and the rename). The SDK's `eB` writer iterates only the
// dir candidates that already exist on disk and throws
// `Session <sid> not found in project directory for <dir>` when none match.
// The bridge classifies that throw as `sdk_threw`, which the store silently
// swallows — JSONL never gets the `custom-title` frame.
//
// This test exercises the real fs path: a real project-key directory and a
// real `<sid>.jsonl` fixture, with the bridge calling the actual SDK (no
// `__setSdkForTests`). It must FAIL on origin/working and PASS once the fix
// (canonicalize-or-omit `dir` before calling SDK) is in place.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  renameSessionTitle,
  __resetForTests,
  __setSdkForTests,
} from '../index.js';

// SDK projectKey encoder (mirrors `_1` in sdk.mjs:285668): replace every
// non-alphanumeric with `-`. We use it here ONLY to construct the canonical
// fixture directory; production code in this repo must NOT depend on the
// SDK's internal encoder beyond what the bridge does.
function encodeProjectKey(absPath: string): string {
  return absPath.replace(/[^a-zA-Z0-9]/g, '-');
}

let originalConfigDir: string | undefined;
let tmpRoot = '';
let projectsDir = '';

beforeEach(async () => {
  __resetForTests();
  // Inject the REAL SDK exports. The bridge's production loader uses
  // `new Function('return import(spec)')` to dodge tsc's CJS rewrite, but
  // that shim is rejected under vitest/Vite ("dynamic import callback was
  // not specified"). Importing the SDK normally here works because vitest
  // is itself ESM-aware. The bridge's `__setSdkForTests` seam exists for
  // exactly this reason — the SDK module instance is real, only the loader
  // is bypassed.
  const realSdk = await import('@anthropic-ai/claude-agent-sdk');
  __setSdkForTests({
    getSessionInfo: realSdk.getSessionInfo,
    renameSession: realSdk.renameSession,
    listSessions: realSdk.listSessions,
  });
  // Isolate ~/.claude/projects/ to a tmp tree so we never touch the user's
  // real session store. SDK reads CLAUDE_CONFIG_DIR (see sdk.mjs y4 / 163796)
  // exactly once per process and memoizes via `f6`. We import the bridge
  // (and therefore the SDK module) BEFORE this hook runs, so the memoized
  // value already captured the env var. To make the test deterministic we
  // set the env var early (top of file would be too late: imports already
  // ran) — but since the bridge uses a `new Function` shim that re-imports
  // the SDK module, the SDK will respect the current env var on its own
  // first call inside this file. To be safe across re-runs we set it here.
  originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'ccsm-rename-it-'));
  process.env.CLAUDE_CONFIG_DIR = tmpRoot;
  projectsDir = path.join(tmpRoot, 'projects');
  await fsp.mkdir(projectsDir, { recursive: true });
});

afterEach(async () => {
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
  if (tmpRoot) {
    await fsp.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }
});

describe('renameSessionTitle real-fs writeback', () => {
  it(
    'writes a custom-title frame to the JSONL even when the caller passes a dir that does not encode to the on-disk project key',
    async () => {
      const sid = randomUUID();
      // Fixture: the JSONL lives under a project key derived from
      // `realProjectCwd`. The renderer will hand us `staleCwd` (different
      // path → different encoded key). Pre-fix this drives `Y6` to return
      // [], `eB` throws, and the bridge returns `sdk_threw`.
      const realProjectCwd = path.join(tmpRoot, 'project-real');
      const staleCwd = path.join(tmpRoot, 'project-renamed');
      await fsp.mkdir(realProjectCwd, { recursive: true });
      // Note: we deliberately do NOT create staleCwd on disk. `p4` (sdk
      // realpath helper) catches the ENOENT and falls back to NFC-normalizing
      // the input, so the encoded key still differs from the real one.

      const projectKey = encodeProjectKey(realProjectCwd);
      const projectDirOnDisk = path.join(projectsDir, projectKey);
      await fsp.mkdir(projectDirOnDisk, { recursive: true });
      const jsonlPath = path.join(projectDirOnDisk, `${sid}.jsonl`);
      // Minimal seed line so SDK's append guard (`size === 0` short-circuit
      // in `pz`) does not skip the file.
      await fsp.writeFile(
        jsonlPath,
        JSON.stringify({
          type: 'user',
          sessionId: sid,
          timestamp: new Date().toISOString(),
          message: { role: 'user', content: 'seed' },
          cwd: realProjectCwd,
        }) + '\n',
        'utf8'
      );

      const newTitle = 'sidebar-rename-target';
      const result = await renameSessionTitle(sid, newTitle, staleCwd);

      // Read back and assert the SDK actually appended a custom-title frame.
      const after = await fsp.readFile(jsonlPath, 'utf8');
      const hasCustomTitle = after
        .split(/\r?\n/)
        .filter(Boolean)
        .some((line) => {
          try {
            const obj = JSON.parse(line);
            return (
              obj &&
              obj.type === 'custom-title' &&
              obj.customTitle === newTitle &&
              obj.sessionId === sid
            );
          } catch {
            return false;
          }
        });

      expect(
        result.ok,
        result.ok
          ? 'expected ok'
          : `bridge returned reason=${result.reason} message=${result.message ?? ''}`
      ).toBe(true);
      expect(hasCustomTitle, `JSONL contents:\n${after}`).toBe(true);
    },
    15000
  );
});
