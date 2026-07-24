import { describe, expect, it } from 'vitest';

import {
  buildSessionNavigatorModel,
  SESSION_NAVIGATOR_MESSAGE_VERSION,
} from '../../../src/shared/sessionNavigator';

describe('buildSessionNavigatorModel', () => {
  it('preserves group/session order and filters to normal groups with live PTYs', () => {
    const model = buildSessionNavigatorModel(
      {
        groups: [
          { id: 'g2', name: 'Second', collapsed: true, kind: 'normal' },
          { id: 'archive', name: 'Archive', collapsed: false, kind: 'archive' },
          { id: 'g1', name: 'First', collapsed: false, kind: 'normal' },
        ],
        sessions: [
          { id: 's2', name: 'Two', cwd: '/two', groupId: 'g2', state: 'waiting' },
          { id: 'dead', name: 'Dead', cwd: '/dead', groupId: 'g2', state: 'idle' },
          { id: 's1', name: 'One', cwd: '/one', groupId: 'g1', state: 'idle' },
        ],
        activeId: 's1',
      },
      new Set(['s1', 's2']),
    );

    expect(model).toEqual({
      groups: [
        {
          id: 'g2',
          name: 'Second',
          order: 0,
          collapsed: true,
          sessions: [{ id: 's2', name: 'Two', cwd: '/two', state: 'waiting', order: 0 }],
        },
        {
          id: 'g1',
          name: 'First',
          order: 2,
          collapsed: false,
          sessions: [{ id: 's1', name: 'One', cwd: '/one', state: 'active', order: 2 }],
        },
      ],
      activeSessionId: 's1',
    });
    expect(SESSION_NAVIGATOR_MESSAGE_VERSION).toBe(1);
  });

  it('drops malformed metadata and clears a non-live active id', () => {
    expect(
      buildSessionNavigatorModel(
        {
          groups: [{ id: 'g', name: 'Group', collapsed: false, kind: 'normal' }],
          sessions: [
            { id: 's', name: '', cwd: '/ok', groupId: 'g', state: 'idle' },
            { id: 'gone', name: 'Gone', cwd: '/gone', groupId: 'g', state: 'waiting' },
          ],
          activeId: 'gone',
        },
        new Set(['s']),
      ),
    ).toEqual({
      groups: [
        {
          id: 'g',
          name: 'Group',
          order: 0,
          collapsed: false,
          sessions: [{ id: 's', name: 's', cwd: '/ok', state: 'idle', order: 0 }],
        },
      ],
      activeSessionId: null,
    });
  });
});
