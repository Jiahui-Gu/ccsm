import { describe, expect, it, vi } from 'vitest';

// The CI test job intentionally skips downloading Electron's binary.
// navigationSource imports db.ts for its default dependency, so isolate that
// package boundary while exercising the injected pure dependencies below.
vi.mock('electron', () => ({}));

import { readRemoteNavigationModel } from '../navigationSource';

describe('readRemoteNavigationModel', () => {
  it('reads only live PTY metadata from the persisted main snapshot', () => {
    const model = readRemoteNavigationModel({
      loadState: () =>
        JSON.stringify({
          version: 1,
          activeId: 's1',
          groups: [{ id: 'g1', name: 'Work', collapsed: false, kind: 'normal' }],
          sessions: [
            { id: 's1', name: 'Live', cwd: '/work', groupId: 'g1', state: 'idle' },
            { id: 's2', name: 'Closed', cwd: '/secret', groupId: 'g1', state: 'waiting' },
          ],
        }),
      listPtySessions: () => [{ sid: 's1', cwd: '/work', cols: 80, rows: 24 }],
    });

    expect(model.groups[0]?.sessions.map((session) => session.id)).toEqual(['s1']);
    expect(model.activeSessionId).toBe('s1');
    expect(JSON.stringify(model)).not.toContain('/secret');
  });

  it.each([null, '', '{', '[]', '{"version":2}'])(
    'returns an empty model for malformed persisted state %j',
    (raw) => {
      expect(
        readRemoteNavigationModel({
          loadState: () => raw,
          listPtySessions: () => [{ sid: 's1', cwd: '/work', cols: 80, rows: 24 }],
        }),
      ).toEqual({ groups: [], activeSessionId: null });
    },
  );

  it('returns an empty model when persisted metadata cannot be read', () => {
    expect(
      readRemoteNavigationModel({
        loadState: () => {
          throw new Error('db unavailable');
        },
        listPtySessions: () => [{ sid: 's1', cwd: '/work', cols: 80, rows: 24 }],
      }),
    ).toEqual({ groups: [], activeSessionId: null });
  });

  it('returns an empty model when groups or sessions are structurally malformed', () => {
    expect(
      readRemoteNavigationModel({
        loadState: () => JSON.stringify({ version: 1, activeId: 's1', groups: {}, sessions: [] }),
        listPtySessions: () => [{ sid: 's1', cwd: '/work', cols: 80, rows: 24 }],
      }),
    ).toEqual({ groups: [], activeSessionId: null });
    expect(
      readRemoteNavigationModel({
        loadState: () => JSON.stringify({ version: 1, activeId: 's1', groups: [], sessions: {} }),
        listPtySessions: () => [{ sid: 's1', cwd: '/work', cols: 80, rows: 24 }],
      }),
    ).toEqual({ groups: [], activeSessionId: null });
  });
});
