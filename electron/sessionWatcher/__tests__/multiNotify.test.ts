// Reproduction + regression test for #631:
// "multi-segment turn fires the OS notification twice".
//
// Real-prod transcript (line 27088-27093 of a typical turn) sequence:
//   1. user prompt
//   2. assistant {stop_reason: end_turn}  (text-only first segment)
//   3. ~6.5s gap (past notify bridge's 5s DEDUPE_WINDOW_MS)
//   4. assistant {stop_reason: tool_use}  (CLI continuing on its own)
//   5. user tool_result
//   6. assistant {stop_reason: end_turn}  (final segment)
//
// Pre-fix: the watcher emits state-changed=idle twice (after frame 2 and
// frame 6); the bridge's 5s DEDUPE_WINDOW_MS is too short to swallow the
// second one, so the user gets two OS toasts for one user-initiated turn.
//
// Post-fix: an "armed" gate driven by the watcher (which detects new
// user(text) frames in JSONL and emits 'user-prompt') ensures only the
// final idle of a user-initiated turn fires.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// `installNotifyBridge` imports Electron Notification — stub so the test
// environment doesn't pull the native module.
vi.mock('electron', () => ({
  Notification: class FakeNotification {
    static isSupported(): boolean { return true; }
    on(): this { return this; }
    show(): void { /* never called — tests inject notifyImpl */ }
  },
}));

// Stub out the SDK title bridge so the watcher's maybeEmitTitle is a no-op
// (we only care about state-changed + user-prompt + notify here).
vi.mock('../../sessionTitles', () => ({
  getSessionTitle: async () => ({ summary: null }),
  flushPendingRename: async () => undefined,
}));

import { __createForTest, type SessionWatcher } from '../index';
import { installNotifyBridge, type NotifyPayload } from '../../notify';

interface AssistantOpts {
  stopReason: 'end_turn' | 'stop_sequence' | 'tool_use';
  toolUseIds?: string[];
  text?: string;
}

function assistantFrame(opts: AssistantOpts): Record<string, unknown> {
  const content: Array<Record<string, unknown>> = [];
  if (opts.text) content.push({ type: 'text', text: opts.text });
  for (const id of opts.toolUseIds ?? []) {
    content.push({ type: 'tool_use', id, name: 'Bash', input: {} });
  }
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content,
      stop_reason: opts.stopReason,
      stop_sequence: null,
    },
  };
}

function userTextFrame(text: string): Record<string, unknown> {
  return {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
  };
}

function userToolResultFrame(toolUseId: string): Record<string, unknown> {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'ok' }],
    },
  };
}

function appendFrame(jsonlPath: string, frame: Record<string, unknown>): void {
  fs.appendFileSync(jsonlPath, JSON.stringify(frame) + '\n');
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

async function waitForCondition(
  pred: () => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return;
    await sleep(25);
  }
  throw new Error(`waitForCondition timed out after ${timeoutMs}ms`);
}

describe('notify gate — multi-segment turn fires once (#631)', () => {
  let tmpRoot: string;
  let jsonlPath: string;
  let watcher: SessionWatcher;
  let dispose: () => void;
  let notifyLog: NotifyPayload[];

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-multinotify-test-'));
    const projectDir = path.join(tmpRoot, 'project');
    fs.mkdirSync(projectDir, { recursive: true });
    jsonlPath = path.join(projectDir, 'sess.jsonl');
    fs.writeFileSync(jsonlPath, '');
    watcher = __createForTest();
    notifyLog = [];
    dispose = installNotifyBridge({
      // Watcher's EventEmitter base class is what the bridge subscribes to.
      sessionWatcher: watcher,
      getMainWindow: () => null,
      isMutedFn: () => false,
      notifyImpl: {
        show(payload, _onClick) {
          notifyLog.push(payload);
        },
      },
    });
  });

  afterEach(() => {
    try { dispose?.(); } catch { /* */ }
    try { watcher.closeAll(); } catch { /* */ }
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* */ }
  });

  it('fires exactly 1 notification for a multi-segment turn', async () => {
    const sid = 'sid-multi-1';
    // Frame 1: user prompt — must be on disk BEFORE startWatching so
    // the watcher's first read sees it as the existing baseline.
    appendFrame(jsonlPath, userTextFrame('do thing'));

    watcher.startWatching(sid, jsonlPath);
    // Initial classification (running — only user, no assistant yet).
    await waitForCondition(() => watcher.getLastEmittedForTest(sid) === 'running');

    // Now simulate the user prompt landing AFTER initial classification —
    // for the (first) prompt above we pre-seeded, but this is the realistic
    // case the bridge needs to arm on. We re-write the file with the prompt
    // already there, then append assistant. To simulate the user prompt
    // arriving live, we reset and rebuild.
    //
    // Simpler: pre-seed nothing. Let the user prompt itself be the first
    // frame the watcher sees as a NEW append.
    // Reset the file + re-classify:
    fs.writeFileSync(jsonlPath, '');
    await sleep(100);

    // Live append — frame 1: user prompt.
    appendFrame(jsonlPath, userTextFrame('do thing'));
    // Wait long enough for fs.watch debounce + classify.
    await sleep(200);

    // Frame 2: assistant end_turn (first segment, text only).
    appendFrame(jsonlPath, assistantFrame({ stopReason: 'end_turn', text: 'first segment' }));
    await waitForCondition(() => watcher.getLastEmittedForTest(sid) === 'idle', 3000);

    // Wait past the notify bridge's 5s DEDUPE_WINDOW_MS so a second idle
    // would not be suppressed by dedupe alone — the arm gate is what must
    // suppress it.
    await sleep(6500);

    // Frame 4: assistant emits tool_use (no user prompt in between → not a
    // user-initiated turn).
    appendFrame(jsonlPath, assistantFrame({ stopReason: 'tool_use', toolUseIds: ['t1'] }));
    await waitForCondition(() => watcher.getLastEmittedForTest(sid) === 'running', 3000);

    // Frame 5: tool_result.
    appendFrame(jsonlPath, userToolResultFrame('t1'));
    await sleep(200);

    // Frame 6: final end_turn.
    appendFrame(jsonlPath, assistantFrame({ stopReason: 'end_turn', text: 'final' }));
    await waitForCondition(() => watcher.getLastEmittedForTest(sid) === 'idle', 3000);

    // Settle.
    await sleep(500);

    // CONTRACT: only 1 notification for this whole multi-segment turn.
    // Pre-fix this is 2 (one after frame 2, one after frame 6). Post-fix
    // it is 1 (the final idle, since arm was set when the user prompt
    // appeared and consumed by the first idle; the second idle is not
    // user-initiated so it must NOT fire).
    //
    // Per the locked contract in #633: case #2 = 1 notify on final idle.
    // The first segment's idle is part of the same user-initiated turn
    // (the CLI is doing multi-segment continuation), so the user only
    // expects ONE ping when the whole reply is done.
    expect(notifyLog.length, `expected 1 notify, got ${notifyLog.length}: ${JSON.stringify(notifyLog)}`).toBe(1);
    expect(notifyLog[0].sid).toBe(sid);
    expect(notifyLog[0].state).toBe('idle');
  }, 30_000);

  it('does NOT emit user-prompt for frames already on disk at startWatching (resume / case #5)', async () => {
    const sid = 'sid-resume';
    const userPromptLog: Array<{ sid: string }> = [];
    watcher.on('user-prompt', (evt: { sid: string }) => {
      userPromptLog.push(evt);
    });

    // Pre-seed JSONL with a complete prior turn — user prompt + assistant idle.
    fs.writeFileSync(
      jsonlPath,
      [
        JSON.stringify(userTextFrame('previous question')),
        JSON.stringify(assistantFrame({ stopReason: 'end_turn', text: 'previous answer' })),
      ].join('\n') + '\n',
    );

    watcher.startWatching(sid, jsonlPath);
    // Wait for initial classification to complete.
    await waitForCondition(() => watcher.getLastEmittedForTest(sid) === 'idle', 3000);
    await sleep(500);

    // Resume case: 0 user-prompt emissions, 0 notifications.
    expect(userPromptLog.length, `expected 0 user-prompt on resume, got ${userPromptLog.length}`).toBe(0);
    expect(notifyLog.length, `expected 0 notify on resume, got ${notifyLog.length}`).toBe(0);
  }, 15_000);

  it('emits user-prompt when a NEW user(text) frame appears (case #1)', async () => {
    const sid = 'sid-fresh';
    const userPromptLog: Array<{ sid: string }> = [];
    watcher.on('user-prompt', (evt: { sid: string }) => {
      userPromptLog.push(evt);
    });

    // Empty file initially.
    watcher.startWatching(sid, jsonlPath);
    await waitForCondition(() => watcher.getLastEmittedForTest(sid) === 'running');

    // User prompt arrives live.
    appendFrame(jsonlPath, userTextFrame('hi there'));
    await sleep(300);

    expect(userPromptLog.length).toBeGreaterThanOrEqual(1);
    expect(userPromptLog[0].sid).toBe(sid);
  }, 15_000);

  it('does NOT emit user-prompt for mid-turn tool_result (no preceding RA)', async () => {
    const sid = 'sid-tool-mid';
    const userPromptLog: Array<{ sid: string }> = [];
    watcher.on('user-prompt', (evt: { sid: string }) => {
      userPromptLog.push(evt);
    });

    // Pre-seed: user prompt + assistant tool_use (waiting for tool_result).
    fs.writeFileSync(
      jsonlPath,
      [
        JSON.stringify(userTextFrame('do thing')),
        JSON.stringify(assistantFrame({ stopReason: 'tool_use', toolUseIds: ['t1'] })),
      ].join('\n') + '\n',
    );
    watcher.startWatching(sid, jsonlPath);
    await waitForCondition(() => watcher.getLastEmittedForTest(sid) === 'running');
    await sleep(200);
    const baseline = userPromptLog.length;

    // tool_result lands — should NOT emit user-prompt because lastEmitted
    // was 'running' (not 'requires_action').
    appendFrame(jsonlPath, userToolResultFrame('t1'));
    await sleep(300);

    expect(userPromptLog.length, `expected 0 new user-prompt for mid-turn tool_result, got ${userPromptLog.length - baseline}`).toBe(baseline);
  }, 15_000);

  it('DOES emit user-prompt for tool_result after requires_action (case #4 re-arm)', async () => {
    const sid = 'sid-perm-answer';
    const userPromptLog: Array<{ sid: string }> = [];
    watcher.on('user-prompt', (evt: { sid: string }) => {
      userPromptLog.push(evt);
    });

    // Pre-seed: user prompt + assistant tool_use + permission-mode prompt.
    fs.writeFileSync(
      jsonlPath,
      [
        JSON.stringify(userTextFrame('do dangerous thing')),
        JSON.stringify(assistantFrame({ stopReason: 'tool_use', toolUseIds: ['t1'] })),
        JSON.stringify({ type: 'permission-mode', mode: 'plan' }),
      ].join('\n') + '\n',
    );
    watcher.startWatching(sid, jsonlPath);
    await waitForCondition(() => watcher.getLastEmittedForTest(sid) === 'requires_action');
    await sleep(200);
    const baseline = userPromptLog.length;

    // User answers → CLI writes tool_result. Since lastEmitted was
    // requires_action, this MUST emit user-prompt to re-arm.
    appendFrame(jsonlPath, userToolResultFrame('t1'));
    await sleep(300);

    expect(userPromptLog.length - baseline, `expected >=1 user-prompt for tool_result-after-RA`).toBeGreaterThanOrEqual(1);
  }, 15_000);
});
