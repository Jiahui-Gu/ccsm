import { useState } from 'react';
import {
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent
} from '@dnd-kit/core';
import type { Group, Session } from '../../types';
import { parseHeaderDroppable } from './dnd';

// Sidebar DnD orchestration: sensors + active-id tracking + drag-end routing.
// Lives outside <Sidebar> so the parent stays a thin compose layer (Task #735
// Phase B). The hook owns three concerns that all serve the single purpose of
// "which session goes where on drop":
//   1. Sensor wiring (PointerSensor with 8px activation distance — keeps
//      regular clicks on session rows from being swallowed by drag).
//   2. The currently-dragged id, so <DragOverlay> can render a preview card.
//   3. The drop-target → onMoveSession routing rules (J14: archived headers
//      reject live-session drops; same guard for empty SortableContexts).
export type SidebarDndDeps = {
  groups: Group[];
  normalGroups: Group[];
  sessions: Session[];
  onMoveSession: (sessionId: string, targetGroupId: string, beforeSessionId: string | null) => void;
};

export type SidebarDndApi = {
  sensors: ReturnType<typeof useSensors>;
  draggingSession: Session | null;
  onDragStart: (e: DragStartEvent) => void;
  onDragEnd: (e: DragEndEvent) => void;
  onDragCancel: () => void;
};

export function useSidebarDnd({ groups, normalGroups, sessions, onMoveSession }: SidebarDndDeps): SidebarDndApi {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));
  const draggingSession = draggingId ? sessions.find((s) => s.id === draggingId) ?? null : null;

  function onDragStart(e: DragStartEvent) {
    setDraggingId(String(e.active.id));
  }

  function onDragEnd(e: DragEndEvent) {
    setDraggingId(null);
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const activeId = String(active.id);
    const overId = String(over.id);
    const headerGroupId = parseHeaderDroppable(overId);
    if (headerGroupId) {
      // J14: reject drops onto archived (or otherwise non-normal) group
      // headers. The archive panel is a "viewer" surface — live sessions
      // stay in their source group when the user accidentally hovers there.
      const headerGroup = groups.find((g) => g.id === headerGroupId);
      if (!headerGroup || headerGroup.kind !== 'normal') return;
      // Dropped on a group header → append to that group.
      onMoveSession(activeId, headerGroupId, null);
      return;
    }
    const overSession = sessions.find((s) => s.id === overId);
    if (overSession) {
      onMoveSession(activeId, overSession.groupId, overSession.id);
      return;
    }
    // Dropped on an empty SortableContext keyed by group id.
    if (normalGroups.some((g) => g.id === overId)) {
      // Same archive guard: SortableContext for archived groups isn't
      // rendered today, but defend anyway in case the archive list grows
      // empty-drop targets later.
      const target = groups.find((g) => g.id === overId);
      if (!target || target.kind !== 'normal') return;
      onMoveSession(activeId, overId, null);
    }
  }

  function onDragCancel() {
    setDraggingId(null);
  }

  return { sensors, draggingSession, onDragStart, onDragEnd, onDragCancel };
}
