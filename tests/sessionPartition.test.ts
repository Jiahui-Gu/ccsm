import { describe, it, expect } from 'vitest';
import type { Session } from '../src/types';
import {
  partitionSessionsForBackfill,
  BACKFILL_DEFAULT_NAMES,
} from '../src/stores/lib/sessionPartition';

function makeSession(overrides: Partial<Session>): Session {
  return {
    id: 's',
    name: 'New session',
    state: 'idle',
    cwd: 'C:/work/proj',
    model: '',
    groupId: 'g',
    agentType: 'claude-code',
    ...overrides,
  };
}

describe('partitionSessionsForBackfill', () => {
  it('returns an empty map for empty input', () => {
    expect(partitionSessionsForBackfill([]).size).toBe(0);
  });

  it('keeps every default-named session and groups them by encoded cwd', () => {
    const sessions: Session[] = [
      makeSession({ id: 'a', cwd: 'C:/work/proj' }),
      makeSession({ id: 'b', cwd: 'C:/work/proj' }),
      makeSession({ id: 'c', name: '新会话', cwd: 'D:/other' }),
    ];
    const out = partitionSessionsForBackfill(sessions);
    expect(out.size).toBe(2);
    expect(out.get('C--work-proj')).toEqual(['a', 'b']);
    expect(out.get('D--other')).toEqual(['c']);
  });

  it('drops sessions whose name is not a default placeholder', () => {
    const sessions: Session[] = [
      makeSession({ id: 'a', name: 'My renamed session' }),
      makeSession({ id: 'b', name: 'Another' }),
    ];
    expect(partitionSessionsForBackfill(sessions).size).toBe(0);
  });

  it('drops sessions with empty or non-string cwd', () => {
    const sessions: Session[] = [
      makeSession({ id: 'a', cwd: '' }),
      makeSession({ id: 'b', cwd: undefined as unknown as string }),
    ];
    expect(partitionSessionsForBackfill(sessions).size).toBe(0);
  });

  it('encodes backslashes, forward slashes, and colons to dashes', () => {
    const sessions: Session[] = [
      makeSession({ id: 'a', cwd: 'C:\\Users\\me\\proj' }),
    ];
    const out = partitionSessionsForBackfill(sessions);
    expect(Array.from(out.keys())).toEqual(['C--Users-me-proj']);
  });

  it('mixes default and non-default sessions correctly', () => {
    const sessions: Session[] = [
      makeSession({ id: 'a', name: 'New session', cwd: '/x' }),
      makeSession({ id: 'b', name: 'Renamed', cwd: '/x' }),
      makeSession({ id: 'c', name: '新会话', cwd: '/x' }),
    ];
    const out = partitionSessionsForBackfill(sessions);
    expect(out.get('-x')).toEqual(['a', 'c']);
  });

  it('exposes the default-name set used for filtering', () => {
    expect(BACKFILL_DEFAULT_NAMES.has('New session')).toBe(true);
    expect(BACKFILL_DEFAULT_NAMES.has('新会话')).toBe(true);
    expect(BACKFILL_DEFAULT_NAMES.has('something else')).toBe(false);
  });
});
