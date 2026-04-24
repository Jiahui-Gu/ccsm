import { describe, it, expect } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import { parseHead, deriveRecentCwds, deriveTopModel, isSidechainFrame, isCCSMTempCwd } from '../electron/import-scanner';

const j = (o: unknown) => JSON.stringify(o);

describe('parseHead', () => {
  it('returns null for empty input', () => {
    expect(parseHead([])).toBeNull();
  });

  it('returns null when no recognizable fields appear', () => {
    expect(parseHead([j({ type: 'file-history-snapshot' })])).toBeNull();
  });

  it('prefers ai-title over first user text', () => {
    const head = parseHead([
      j({ type: 'user', cwd: '/p', message: { content: [{ type: 'text', text: 'hello' }] } }),
      j({ type: 'ai-title', aiTitle: 'A nice title' })
    ]);
    expect(head).toEqual({ cwd: '/p', title: 'A nice title', model: null });
  });

  it('falls back to first user text when no ai-title', () => {
    const head = parseHead([
      j({ type: 'queue-operation' }),
      j({ type: 'user', cwd: '/p', message: { content: [{ type: 'text', text: 'do the thing' }] } })
    ]);
    expect(head).toEqual({ cwd: '/p', title: 'do the thing', model: null });
  });

  it('skips slash-command wrapped user text', () => {
    const head = parseHead([
      j({
        type: 'user',
        cwd: '/p',
        message: { content: [{ type: 'text', text: '<command-name>/stats</command-name>' }] }
      }),
      j({
        type: 'user',
        message: { content: [{ type: 'text', text: 'real prompt' }] }
      })
    ]);
    expect(head?.title).toBe('real prompt');
  });

  it('truncates long user text to 80 chars', () => {
    const long = 'a'.repeat(200);
    const head = parseHead([
      j({ type: 'user', cwd: '/p', message: { content: [{ type: 'text', text: long }] } })
    ]);
    expect(head?.title.length).toBe(80);
    expect(head?.title.endsWith('…')).toBe(true);
  });

  it('handles string content', () => {
    const head = parseHead([
      j({ type: 'user', cwd: '/p', message: { content: 'plain string' } })
    ]);
    expect(head?.title).toBe('plain string');
  });

  it('uses ~ as cwd when none seen', () => {
    const head = parseHead([j({ type: 'ai-title', aiTitle: 'X' })]);
    expect(head).toEqual({ cwd: '~', title: 'X', model: null });
  });

  it('falls back to (untitled) only when ai-title and user-text are absent but cwd present', () => {
    const head = parseHead([j({ type: 'queue-operation', cwd: '/p' })]);
    expect(head).toEqual({ cwd: '/p', title: '(untitled session)', model: null });
  });

  it('ignores malformed json lines', () => {
    const head = parseHead(['not json', j({ type: 'ai-title', aiTitle: 'OK' })]);
    expect(head?.title).toBe('OK');
  });

  it('returns null when the first frame has parentUuid set (sub-agent transcript)', () => {
    // CLI marks Task-tool sub-agent transcripts with parentUuid on the first
    // frame. These should be filtered out so they don't pollute the import
    // picker — resuming one out of context produces nonsense.
    const head = parseHead([
      j({
        type: 'user',
        cwd: '/p',
        parentUuid: 'parent-abc-123',
        message: { content: [{ type: 'text', text: 'sub-agent prompt' }] }
      }),
      j({ type: 'ai-title', aiTitle: 'leaks if not filtered' })
    ]);
    expect(head).toBeNull();
  });

  it('returns null when the first frame has isSidechain: true', () => {
    const head = parseHead([
      j({
        type: 'user',
        cwd: '/p',
        isSidechain: true,
        message: { content: [{ type: 'text', text: 'sidechain' }] }
      })
    ]);
    expect(head).toBeNull();
  });

  it('does NOT filter when only later frames carry parentUuid', () => {
    // Defensive: only the FIRST frame is inspected. A normal session might
    // legitimately reference parent uuids in later frames (e.g. when it
    // itself spawns sub-agents) and we don't want to drop those.
    const head = parseHead([
      j({
        type: 'user',
        cwd: '/p',
        parentUuid: null,
        message: { content: [{ type: 'text', text: 'top-level prompt' }] }
      }),
      j({ type: 'user', parentUuid: 'sub-1', message: { content: 'nested' } }),
      j({ type: 'ai-title', aiTitle: 'real session' })
    ]);
    expect(head?.title).toBe('real session');
  });
});

describe('isSidechainFrame', () => {
  it('returns true on isSidechain: true', () => {
    expect(isSidechainFrame({ isSidechain: true })).toBe(true);
  });
  it('returns true on a non-empty parentUuid string', () => {
    expect(isSidechainFrame({ parentUuid: 'abc' })).toBe(true);
  });
  it('returns false on parentUuid: null', () => {
    expect(isSidechainFrame({ parentUuid: null })).toBe(false);
  });
  it('returns false on empty parentUuid', () => {
    expect(isSidechainFrame({ parentUuid: '' })).toBe(false);
  });
  it('returns false on a missing parentUuid field', () => {
    expect(isSidechainFrame({ type: 'user' })).toBe(false);
  });
  it('returns false on non-objects', () => {
    expect(isSidechainFrame(null)).toBe(false);
    expect(isSidechainFrame('str')).toBe(false);
    expect(isSidechainFrame(42)).toBe(false);
  });
});

describe('isCCSMTempCwd', () => {
  it('matches a Windows AppData/Local/Temp cwd with agentory- prefix', () => {
    expect(
      isCCSMTempCwd('C:\\Users\\x\\AppData\\Local\\Temp\\agentory-bugl-bash-proj')
    ).toBe(true);
  });
  it('matches a /tmp cwd with agentory- prefix (POSIX)', () => {
    expect(isCCSMTempCwd('/tmp/agentory-A2N1-changeCwd-proj-1234')).toBe(true);
  });
  it('matches a macOS /var/folders cwd', () => {
    expect(
      isCCSMTempCwd('/var/folders/xy/abc/T/agentory-probe-foo-9999')
    ).toBe(true);
  });
  it('matches the real os.tmpdir() prefix on this platform', () => {
    const cwd = path.join(os.tmpdir(), 'agentory-test-suite-fixture');
    expect(isCCSMTempCwd(cwd)).toBe(true);
  });
  it('does NOT match a user-named directory that contains "agentory" mid-segment', () => {
    expect(isCCSMTempCwd('C:\\Users\\me\\my-agentory-project')).toBe(false);
    expect(isCCSMTempCwd('/home/me/projects/agentory-next')).toBe(false);
  });
  it('does NOT match a non-temp cwd even if it has the agentory- prefix', () => {
    // The agent worktrees live under projects/, NOT temp — they ARE
    // legitimate places the user might have done real CLI work.
    expect(
      isCCSMTempCwd('C:\\Users\\me\\projects\\agentory-next\\.claude\\worktrees\\agent-deadbeef')
    ).toBe(false);
  });
  it('returns false on empty / non-string input', () => {
    expect(isCCSMTempCwd('')).toBe(false);
    // @ts-expect-error — runtime guard
    expect(isCCSMTempCwd(null)).toBe(false);
  });
});

describe('deriveRecentCwds', () => {
  it('returns [] for empty input', () => {
    expect(deriveRecentCwds([])).toEqual([]);
  });

  it('orders by mtime descending', () => {
    expect(
      deriveRecentCwds([
        { cwd: '/a', mtime: 100 },
        { cwd: '/b', mtime: 300 },
        { cwd: '/c', mtime: 200 },
      ])
    ).toEqual(['/b', '/c', '/a']);
  });

  it('dedupes repeated cwds, keeping the most-recent occurrence', () => {
    expect(
      deriveRecentCwds([
        { cwd: '/a', mtime: 100 },
        { cwd: '/a', mtime: 500 },
        { cwd: '/b', mtime: 300 },
      ])
    ).toEqual(['/a', '/b']);
  });

  it('drops the placeholder ~ entry the scanner emits when cwd is unknown', () => {
    expect(
      deriveRecentCwds([
        { cwd: '~', mtime: 500 },
        { cwd: '/real', mtime: 400 },
      ])
    ).toEqual(['/real']);
  });

  it('drops empty cwd strings defensively', () => {
    expect(
      deriveRecentCwds([
        { cwd: '', mtime: 500 },
        { cwd: '/real', mtime: 400 },
      ])
    ).toEqual(['/real']);
  });

  it('caps at the requested max', () => {
    const sessions = Array.from({ length: 25 }, (_, i) => ({
      cwd: `/p${i}`,
      mtime: 1000 - i,
    }));
    const cwds = deriveRecentCwds(sessions, 10);
    expect(cwds).toHaveLength(10);
    // mtime descending → /p0 is newest
    expect(cwds[0]).toBe('/p0');
    expect(cwds[9]).toBe('/p9');
  });

  it('defaults max to 10', () => {
    const sessions = Array.from({ length: 15 }, (_, i) => ({
      cwd: `/p${i}`,
      mtime: 1000 - i,
    }));
    expect(deriveRecentCwds(sessions)).toHaveLength(10);
  });
});

describe('parseHead model extraction', () => {
  it('extracts model from message.model on assistant frames', () => {
    const head = parseHead([
      j({ type: 'user', cwd: '/p', message: { role: 'user', content: 'hello' } }),
      j({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'hi' }],
          model: 'claude-haiku-4.5',
        },
      }),
    ]);
    expect(head?.model).toBe('claude-haiku-4.5');
  });

  it('also accepts top-level model field', () => {
    const head = parseHead([
      j({ type: 'user', cwd: '/p', message: { content: 'hi' } }),
      j({ type: 'system', model: 'claude-sonnet-4.5' }),
    ]);
    expect(head?.model).toBe('claude-sonnet-4.5');
  });
});

describe('deriveTopModel', () => {
  it('returns null on empty input', () => {
    expect(deriveTopModel([])).toBeNull();
  });

  it('returns null when no entry has a model', () => {
    expect(
      deriveTopModel([
        { model: null, mtime: 1 },
        { model: null, mtime: 2 },
      ])
    ).toBeNull();
  });

  it('returns the most-frequent model', () => {
    expect(
      deriveTopModel([
        { model: 'claude-sonnet-4.5', mtime: 100 },
        { model: 'claude-haiku-4.5', mtime: 90 },
        { model: 'claude-haiku-4.5', mtime: 80 },
        { model: 'claude-haiku-4.5', mtime: 70 },
        { model: 'claude-sonnet-4.5', mtime: 60 },
      ])
    ).toBe('claude-haiku-4.5');
  });

  it('breaks ties by most-recent occurrence', () => {
    expect(
      deriveTopModel([
        { model: 'claude-sonnet-4.5', mtime: 200 },
        { model: 'claude-haiku-4.5', mtime: 100 },
        { model: 'claude-sonnet-4.5', mtime: 50 },
        { model: 'claude-haiku-4.5', mtime: 10 },
      ])
    ).toBe('claude-sonnet-4.5');
  });

  it('honours the max window — older entries past the cap are ignored', () => {
    const sessions = [
      { model: 'recent-model', mtime: 500 },
      ...Array.from({ length: 60 }, (_, i) => ({
        model: 'old-model',
        mtime: 100 - i,
      })),
    ];
    expect(deriveTopModel(sessions, 1)).toBe('recent-model');
  });
});
