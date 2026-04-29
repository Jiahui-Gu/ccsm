import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useCwdRecentList } from '../../../src/components/cwd/useCwdRecentList';

const SAMPLE = [
  '/home/alice/projects/agentory',
  '/home/alice/projects/agentory-next',
  '/home/alice/work/cli-tools',
  '/tmp/scratch-pad',
];

function setup(open = true) {
  const commit = vi.fn();
  const loadRecent = vi.fn(async () => SAMPLE);
  const result = renderHook(({ openVal }) =>
    useCwdRecentList(openVal, loadRecent, commit), {
    initialProps: { openVal: open },
  });
  return { ...result, commit, loadRecent };
}

describe('useCwdRecentList', () => {
  it('loads recent entries when open flips true', async () => {
    const { result, loadRecent } = setup(true);
    await waitFor(() => {
      expect(loadRecent).toHaveBeenCalled();
      expect(result.current.filtered).toEqual(SAMPLE);
    });
  });

  it('filters entries by case-insensitive substring of query', async () => {
    const { result } = setup(true);
    await waitFor(() => expect(result.current.filtered.length).toBe(SAMPLE.length));
    act(() => result.current.setQuery('CLI'));
    await waitFor(() => {
      expect(result.current.filtered).toHaveLength(1);
      expect(result.current.filtered[0]).toMatch(/cli-tools/);
    });
  });

  it('ArrowDown / ArrowUp move active row, clamped to bounds', async () => {
    const { result } = setup(true);
    await waitFor(() => expect(result.current.filtered.length).toBe(SAMPLE.length));
    expect(result.current.active).toBe(0);

    const down = (preventDefault = () => {}) =>
      ({ key: 'ArrowDown', preventDefault } as unknown as React.KeyboardEvent<HTMLInputElement>);
    const up = (preventDefault = () => {}) =>
      ({ key: 'ArrowUp', preventDefault } as unknown as React.KeyboardEvent<HTMLInputElement>);

    act(() => result.current.onListKeyDown(down()));
    expect(result.current.active).toBe(1);
    act(() => result.current.onListKeyDown(down()));
    act(() => result.current.onListKeyDown(down()));
    act(() => result.current.onListKeyDown(down()));
    // Clamped at last index (SAMPLE.length - 1 = 3).
    expect(result.current.active).toBe(SAMPLE.length - 1);

    act(() => result.current.onListKeyDown(up()));
    expect(result.current.active).toBe(SAMPLE.length - 2);
    // Clamp at 0 going up.
    act(() => result.current.onListKeyDown(up()));
    act(() => result.current.onListKeyDown(up()));
    act(() => result.current.onListKeyDown(up()));
    expect(result.current.active).toBe(0);
  });

  it('Enter commits the highlighted entry', async () => {
    const { result, commit } = setup(true);
    await waitFor(() => expect(result.current.filtered.length).toBe(SAMPLE.length));
    const down = () => ({ key: 'ArrowDown', preventDefault: () => {} } as unknown as React.KeyboardEvent<HTMLInputElement>);
    const enter = () => ({ key: 'Enter', preventDefault: () => {} } as unknown as React.KeyboardEvent<HTMLInputElement>);
    act(() => result.current.onListKeyDown(down()));
    act(() => result.current.onListKeyDown(enter()));
    expect(commit).toHaveBeenCalledWith(SAMPLE[1]);
  });

  it('Enter on empty filtered list with non-empty query commits the raw query', async () => {
    const { result, commit } = setup(true);
    await waitFor(() => expect(result.current.filtered.length).toBe(SAMPLE.length));
    act(() => result.current.setQuery('zzz-no-match-zzz'));
    await waitFor(() => expect(result.current.filtered).toHaveLength(0));
    const enter = () => ({ key: 'Enter', preventDefault: () => {} } as unknown as React.KeyboardEvent<HTMLInputElement>);
    act(() => result.current.onListKeyDown(enter()));
    expect(commit).toHaveBeenCalledWith('zzz-no-match-zzz');
  });

  it('clamps active row when filtered shrinks below current active', async () => {
    const { result } = setup(true);
    await waitFor(() => expect(result.current.filtered.length).toBe(SAMPLE.length));
    act(() => result.current.setActive(3));
    expect(result.current.active).toBe(3);
    act(() => result.current.setQuery('cli'));
    await waitFor(() => expect(result.current.filtered).toHaveLength(1));
    await waitFor(() => expect(result.current.active).toBe(0));
  });
});
