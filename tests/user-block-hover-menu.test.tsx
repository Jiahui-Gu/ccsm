// Component tests for the user-message hover menu (Edit / Retry / Copy /
// Rewind from here). The menu is the surfaced equivalent of upstream's
// per-user-message popup (webview/index.js → Oo1) but uses the verbs CCSM
// users actually asked for — see UserBlock.tsx for the rationale.
//
// Tests render <UserBlock /> against the real Zustand store and stub
// `window.ccsm` + `navigator.clipboard` to capture side effects. The four
// click tests are the spec the worker prompt called out; rewind has its own
// truncation assertion since it's the only action that mutates other blocks.
import React from 'react';
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import { UserBlock } from '../src/components/chat/blocks/UserBlock';
import { useStore } from '../src/stores/store';

const initial = useStore.getState();

function freshStoreWithSession(sessionId: string, blocks: Array<Parameters<typeof useStore.getState>[0] extends void ? never : never> | unknown[] = []) {
  useStore.setState(
    {
      ...initial,
      sessions: [
        {
          id: sessionId,
          name: sessionId,
          state: 'idle',
          cwd: '~',
          model: 'claude',
          groupId: 'g-default',
          agentType: 'claude-code'
        }
      ],
      groups: [{ id: 'g-default', name: 'Sessions', collapsed: false, kind: 'normal' }],
      activeId: sessionId,
      messagesBySession: { [sessionId]: blocks as never },
      startedSessions: { [sessionId]: true },
      runningSessions: {},
      messageQueues: {},
      focusInputNonce: 0,
      composerInjectNonce: 0,
      composerInjectText: ''
    },
    true
  );
}

function stubCCSM(overrides: Partial<Record<string, unknown>> = {}) {
  const api = {
    agentSend: vi.fn().mockResolvedValue(true),
    agentSendContent: vi.fn().mockResolvedValue(true),
    agentInterrupt: vi.fn().mockResolvedValue(undefined),
    agentClose: vi.fn().mockResolvedValue(true),
    ...overrides
  };
  (globalThis as unknown as { window: Window & { ccsm?: unknown } }).window.ccsm = api;
  return api;
}

function setClipboard() {
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
    writable: true
  });
  return writeText;
}

beforeEach(() => {
  cleanup();
  (globalThis as unknown as { window: Window & { ccsm?: unknown } }).window.ccsm = undefined;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('<UserBlock /> hover menu', () => {
  it('renders all four action buttons (Edit / Retry / Copy / Rewind)', () => {
    freshStoreWithSession('s1');
    stubCCSM();
    render(<UserBlock id="u1" text="hello" sessionId="s1" />);
    // The buttons are always in the DOM — opacity-0 by default, opacity-100
    // on group-hover. We don't assert visibility because jsdom doesn't apply
    // tailwind's group-hover; the probe covers the visual side.
    expect(screen.getByRole('button', { name: /edit and resend/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^retry$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /copy message/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /truncate from here/i })).toBeInTheDocument();
  });

  it('Copy: writes the message text to the clipboard and flips to "Copied"', async () => {
    freshStoreWithSession('s1');
    stubCCSM();
    const writeText = setClipboard();
    render(<UserBlock id="u1" text="please refactor this" sessionId="s1" />);
    const btn = screen.getByRole('button', { name: /copy message/i });
    await act(async () => {
      fireEvent.click(btn);
    });
    expect(writeText).toHaveBeenCalledWith('please refactor this');
    // Tooltip + aria-label flip together via the `copied` state.
    expect(screen.getByRole('button', { name: /^copied$/i })).toHaveAttribute('data-copied', 'true');
  });

  it('Edit: bumps composerInjectNonce and stages the original text in the store', () => {
    freshStoreWithSession('s1');
    stubCCSM();
    const before = useStore.getState().composerInjectNonce;
    render(<UserBlock id="u1" text="my original prompt" sessionId="s1" />);
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: /edit and resend/i }));
    });
    const after = useStore.getState();
    expect(after.composerInjectNonce).toBe(before + 1);
    expect(after.composerInjectText).toBe('my original prompt');
  });

  it('Retry: appends a new user echo block and dispatches agentSend with the same text', async () => {
    const blocks = [{ kind: 'user' as const, id: 'u1', text: 'do the thing' }];
    freshStoreWithSession('s1', blocks);
    const api = stubCCSM();
    render(<UserBlock id="u1" text="do the thing" sessionId="s1" />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^retry$/i }));
    });
    expect(api.agentSend).toHaveBeenCalledWith('s1', 'do the thing');
    const after = useStore.getState().messagesBySession['s1'] ?? [];
    // Original block is preserved (Retry is non-destructive); the echo is the
    // SECOND user block now.
    const userBlocks = after.filter((b) => b.kind === 'user');
    expect(userBlocks).toHaveLength(2);
    expect(userBlocks[1].text).toBe('do the thing');
    expect(useStore.getState().runningSessions['s1']).toBe(true);
  });

  it('Truncate from here: truncates the conversation to before this block, pins resumeSessionId to the on-disk session id, calls agentClose', () => {
    const blocks = [
      { kind: 'assistant' as const, id: 'a0', text: 'previous reply' },
      { kind: 'user' as const, id: 'u1', text: 'this one' },
      { kind: 'assistant' as const, id: 'a1', text: 'reply to u1' },
      { kind: 'tool' as const, id: 't1', name: 'Read', brief: 'foo', expanded: false }
    ];
    freshStoreWithSession('s1', blocks);
    // Pin a resumeSessionId so we can verify it stays pinned (not dropped).
    // Bug #288 fix: post-truncate `agentStart` MUST go through the `--resume`
    // CLI path, not `--session-id` — otherwise the bundled CLI rejects the
    // respawn with "Session ID is already in use." (exit 1) because the
    // JSONL from the prior conversation still exists on disk. The store
    // therefore pins `resumeSessionId` to the on-disk session id (= existing
    // resumeSessionId, or the ccsm session id if this is the first turn's
    // worth of JSONL).
    useStore.setState((s) => ({
      sessions: s.sessions.map((x) =>
        x.id === 's1' ? { ...x, resumeSessionId: 'old-claude-uuid' } : x
      )
    }));
    const api = stubCCSM();
    render(<UserBlock id="u1" text="this one" sessionId="s1" />);
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: /truncate from here/i }));
    });
    const after = useStore.getState();
    expect(after.messagesBySession['s1']).toHaveLength(1);
    expect(after.messagesBySession['s1'][0].id).toBe('a0');
    const sess = after.sessions.find((x) => x.id === 's1');
    // resumeSessionId stays pinned to whatever was already on disk so the
    // next agentStart re-uses it via `--resume` instead of fighting the CLI
    // for the same `--session-id`.
    expect(sess?.resumeSessionId).toBe('old-claude-uuid');
    expect(after.startedSessions['s1']).toBeFalsy();
    expect(api.agentClose).toHaveBeenCalledWith('s1');
  });

  it('Truncate from here on a fresh (no-resume) session: pins resumeSessionId to the ccsm session id', () => {
    // First-turn case: the session has no `resumeSessionId` yet because the
    // CLI hasn't issued one — its JSONL on disk is keyed by the ccsm id
    // itself (see `sidOnDisk = session.resumeSessionId || session.id` in
    // store.ts loadMessages). After truncate the next agentStart still has
    // to use `--resume <ccsm-id>` to avoid the "Session ID is already in
    // use." rejection. So the store seeds resumeSessionId with the ccsm id.
    const blocks = [
      { kind: 'user' as const, id: 'u-first', text: 'opener' },
      { kind: 'assistant' as const, id: 'a-first', text: 'reply' },
      { kind: 'user' as const, id: 'u-second', text: 'follow-up' }
    ];
    freshStoreWithSession('s1', blocks);
    // Confirm there's no resumeSessionId baseline.
    expect(useStore.getState().sessions.find((x) => x.id === 's1')?.resumeSessionId).toBeUndefined();
    stubCCSM();
    render(<UserBlock id="u-second" text="follow-up" sessionId="s1" />);
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: /truncate from here/i }));
    });
    const sess = useStore.getState().sessions.find((x) => x.id === 's1');
    expect(sess?.resumeSessionId).toBe('s1');
  });

  // Reviewer Fix #2: truncation only mutated `messagesBySession` in memory.
  // After a ccsm restart, `loadMessages` re-projected the JSONL and brought
  // the truncated turns back, silently undoing the user's action. We now
  // persist a `{ blockId }` marker via `truncationSet` and re-apply it in
  // `loadMessages` after the JSONL projection. This case stubs the IPC pair
  // and asserts the cut survives a fresh hydrate.
  it('Truncate from here persists across reload: loadMessages re-applies the marker', async () => {
    const sessionId = 's1';
    const cwd = '/tmp/proj';
    // Pretend we already had this session (so loadMessages can find cwd).
    useStore.setState(
      {
        ...initial,
        sessions: [
          {
            id: sessionId,
            name: sessionId,
            state: 'idle',
            cwd,
            model: 'claude',
            groupId: 'g-default',
            agentType: 'claude-code'
          }
        ],
        groups: [{ id: 'g-default', name: 'Sessions', collapsed: false, kind: 'normal' }],
        activeId: sessionId,
        messagesBySession: {}
      },
      true
    );
    // Three user frames in the JSONL — `framesToBlocks` will project these
    // to `u-<uuid>` ids that match the marker.
    const frames = [
      { type: 'user', uuid: 'one', message: { content: 'first' } },
      { type: 'user', uuid: 'two', message: { content: 'second' } },
      { type: 'user', uuid: 'three', message: { content: 'third' } }
    ];
    const api = stubCCSM({
      loadHistory: vi.fn().mockResolvedValue({ ok: true, frames }),
      // Marker says: cut at the SECOND user message, so only the first
      // should remain.
      truncationGet: vi.fn().mockResolvedValue({ blockId: 'u-two', truncatedAt: 1 }),
      truncationSet: vi.fn().mockResolvedValue({ ok: true })
    });
    await act(async () => {
      await useStore.getState().loadMessages(sessionId);
    });
    const blocks = useStore.getState().messagesBySession[sessionId] ?? [];
    const userBlocks = blocks.filter((b) => b.kind === 'user');
    expect(api.loadHistory).toHaveBeenCalled();
    expect(api.truncationGet).toHaveBeenCalledWith(sessionId);
    // Only the first user message survives. The second/third are cut.
    expect(userBlocks.map((b) => b.text)).toEqual(['first']);
  });
});
