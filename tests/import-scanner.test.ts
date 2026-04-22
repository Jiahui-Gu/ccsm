import { describe, it, expect } from 'vitest';
import { parseHead, deriveRecentCwds } from '../electron/import-scanner';

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
    expect(head).toEqual({ cwd: '/p', title: 'A nice title' });
  });

  it('falls back to first user text when no ai-title', () => {
    const head = parseHead([
      j({ type: 'queue-operation' }),
      j({ type: 'user', cwd: '/p', message: { content: [{ type: 'text', text: 'do the thing' }] } })
    ]);
    expect(head).toEqual({ cwd: '/p', title: 'do the thing' });
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
    expect(head).toEqual({ cwd: '~', title: 'X' });
  });

  it('falls back to (untitled) only when ai-title and user-text are absent but cwd present', () => {
    const head = parseHead([j({ type: 'queue-operation', cwd: '/p' })]);
    expect(head).toEqual({ cwd: '/p', title: '(untitled session)' });
  });

  it('ignores malformed json lines', () => {
    const head = parseHead(['not json', j({ type: 'ai-title', aiTitle: 'OK' })]);
    expect(head?.title).toBe('OK');
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
