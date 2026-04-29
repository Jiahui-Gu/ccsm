import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { DragEndEvent, DragStartEvent } from '@dnd-kit/core';
import { useSidebarDnd } from '../../src/components/sidebar/useSidebarDnd';
import { headerDroppableId } from '../../src/components/sidebar/dnd';
import type { Group, Session } from '../../src/types';

// useSidebarDnd: pure routing logic for sidebar DnD. Covers the four drop
// targets routed by handleDragEnd plus the J14 archive guard.
//   1. drop on a normal-group header  → onMoveSession(active, headerGroup, null)
//   2. drop on an archived-group header → REJECTED (no callback)
//   3. drop on another session         → onMoveSession(active, overSession.group, overSession.id)
//   4. drop on an empty SortableContext keyed by group id → append to that group
//   5. cancel / no overlap → no callback, draggingSession cleared

const sessionDefaults = {
  state: 'idle' as const,
  cwd: '~',
  model: 'claude-opus-4',
  agentType: 'claude-code' as const
};

const grpNormal = (id: string): Group => ({ id, name: id, collapsed: false, kind: 'normal' });
const grpArchive = (id: string): Group => ({ id, name: id, collapsed: false, kind: 'archive' });
const sess = (id: string, groupId: string): Session => ({ id, name: id, groupId, ...sessionDefaults });

function makeArgs(overrides?: Partial<Parameters<typeof useSidebarDnd>[0]>) {
  const groups: Group[] = [grpNormal('g1'), grpNormal('g2'), grpArchive('garc')];
  const sessions: Session[] = [sess('s1', 'g1'), sess('s2', 'g1'), sess('s3', 'g2')];
  const onMoveSession = vi.fn();
  return {
    args: {
      groups,
      normalGroups: groups.filter((g) => g.kind === 'normal'),
      sessions,
      onMoveSession,
      ...overrides
    },
    onMoveSession
  };
}

const dragEnd = (activeId: string, overId: string | null): DragEndEvent =>
  ({ active: { id: activeId }, over: overId ? { id: overId } : null } as unknown as DragEndEvent);

describe('useSidebarDnd', () => {
  it('routes drop on normal group header to append', () => {
    const { args, onMoveSession } = makeArgs();
    const { result } = renderHook(() => useSidebarDnd(args));
    act(() => result.current.onDragEnd(dragEnd('s1', headerDroppableId('g2'))));
    expect(onMoveSession).toHaveBeenCalledWith('s1', 'g2', null);
  });

  it('rejects drop on archived group header (J14)', () => {
    const { args, onMoveSession } = makeArgs();
    const { result } = renderHook(() => useSidebarDnd(args));
    act(() => result.current.onDragEnd(dragEnd('s1', headerDroppableId('garc'))));
    expect(onMoveSession).not.toHaveBeenCalled();
  });

  it('routes drop on another session to insert-before', () => {
    const { args, onMoveSession } = makeArgs();
    const { result } = renderHook(() => useSidebarDnd(args));
    act(() => result.current.onDragEnd(dragEnd('s1', 's3')));
    expect(onMoveSession).toHaveBeenCalledWith('s1', 'g2', 's3');
  });

  it('routes drop on empty SortableContext keyed by normal group id to append', () => {
    const { args, onMoveSession } = makeArgs();
    const { result } = renderHook(() => useSidebarDnd(args));
    act(() => result.current.onDragEnd(dragEnd('s1', 'g2')));
    expect(onMoveSession).toHaveBeenCalledWith('s1', 'g2', null);
  });

  it('rejects drop on empty SortableContext keyed by archived group id', () => {
    const { args, onMoveSession } = makeArgs({
      // Force archive id into normalGroups list to test downstream guard.
      normalGroups: [grpNormal('g1'), grpNormal('g2'), grpArchive('garc') as Group]
    });
    const { result } = renderHook(() => useSidebarDnd(args));
    act(() => result.current.onDragEnd(dragEnd('s1', 'garc')));
    expect(onMoveSession).not.toHaveBeenCalled();
  });

  it('no-ops when over is null', () => {
    const { args, onMoveSession } = makeArgs();
    const { result } = renderHook(() => useSidebarDnd(args));
    act(() => result.current.onDragEnd(dragEnd('s1', null)));
    expect(onMoveSession).not.toHaveBeenCalled();
  });

  it('no-ops when active === over', () => {
    const { args, onMoveSession } = makeArgs();
    const { result } = renderHook(() => useSidebarDnd(args));
    act(() => result.current.onDragEnd(dragEnd('s1', 's1')));
    expect(onMoveSession).not.toHaveBeenCalled();
  });

  it('tracks draggingSession across start/cancel', () => {
    const { args } = makeArgs();
    const { result } = renderHook(() => useSidebarDnd(args));
    expect(result.current.draggingSession).toBeNull();
    act(() => result.current.onDragStart({ active: { id: 's1' } } as unknown as DragStartEvent));
    expect(result.current.draggingSession?.id).toBe('s1');
    act(() => result.current.onDragCancel());
    expect(result.current.draggingSession).toBeNull();
  });

  it('clears draggingSession on drag-end', () => {
    const { args } = makeArgs();
    const { result } = renderHook(() => useSidebarDnd(args));
    act(() => result.current.onDragStart({ active: { id: 's1' } } as unknown as DragStartEvent));
    expect(result.current.draggingSession?.id).toBe('s1');
    act(() => result.current.onDragEnd(dragEnd('s1', headerDroppableId('g2'))));
    expect(result.current.draggingSession).toBeNull();
  });
});
