import React, { useState } from 'react';
import { motion } from 'framer-motion';
import {
  ChevronRight,
  Plus,
  Search,
  Settings
} from 'lucide-react';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent
} from '@dnd-kit/core';
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useStore } from '../stores/store';
import { cn } from '../lib/cn';
import { IconButton } from './ui/IconButton';
import { Button } from './ui/Button';
import { AgentIcon } from './AgentIcon';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger
} from './ui/ContextMenu';
import { InlineRename } from './ui/InlineRename';
import { ConfirmDialog } from './ui/ConfirmDialog';
import type { Group, Session } from '../types';

// Session order inside a group is user-controlled (drag to reorder) — not
// derived from state. The array order handed down from the store is the
// source of truth; don't re-sort it here.

function GroupRow({
  group,
  sessions,
  activeSessionId,
  focused,
  anyGroupFocused,
  onSelectSession,
  onFocus
}: {
  group: Group;
  sessions: Session[];
  activeSessionId: string;
  focused: boolean;
  anyGroupFocused: boolean;
  onSelectSession: (id: string) => void;
  onFocus: () => void;
}) {
  const sessionIds = sessions.map((s) => s.id);
  const hasWaiting = sessions.some((s) => s.state === 'waiting');
  const setGroupCollapsed = useStore((s) => s.setGroupCollapsed);
  const renameGroup = useStore((s) => s.renameGroup);
  const deleteGroup = useStore((s) => s.deleteGroup);
  const archiveGroup = useStore((s) => s.archiveGroup);
  const unarchiveGroup = useStore((s) => s.unarchiveGroup);
  const collapsed = group.collapsed;
  const [renaming, setRenaming] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const isSpecial = group.kind !== 'normal';
  const menuDisabled = group.kind === 'deleted';
  return (
    <div className="mb-2">
      <ContextMenu>
        <ContextMenuTrigger asChild disabled={menuDisabled}>
          <div
            className={cn(
              'group/row relative flex items-center h-7 px-2 rounded-sm transition-colors duration-120 ease-out',
              focused
                ? 'bg-bg-active shadow-[inset_0_1px_0_0_oklch(1_0_0_/_0.05)]'
                : 'hover:bg-bg-hover'
            )}
          >
            {focused && (
              <motion.span
                aria-hidden
                initial={{ scaleY: 0, opacity: 0, x: -2 }}
                animate={{ scaleY: 1, opacity: 1, x: 0 }}
                transition={{ duration: 0.22, ease: [0.32, 0.72, 0, 1] }}
                style={{ originY: 0.5 }}
                className="absolute left-0 top-0 bottom-0 w-[3px] bg-accent rounded-r-sm"
              />
            )}
            <button
              onClick={() => {
                onFocus();
                if (!renaming) setGroupCollapsed(group.id, !collapsed);
              }}
              className="flex flex-1 min-w-0 items-center gap-1.5 text-left text-fg-secondary outline-none rounded-sm focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-border-strong"
              aria-expanded={!collapsed}
            >
              <motion.span
                initial={false}
                animate={{ rotate: collapsed ? 0 : 90 }}
                transition={{ duration: 0.2, ease: [0, 0, 0.2, 1] }}
                className="inline-flex shrink-0"
              >
                <ChevronRight size={12} className="stroke-[1.75] text-fg-tertiary" />
              </motion.span>
              {renaming ? (
                <InlineRename
                  value={group.name}
                  onCommit={(next) => {
                    renameGroup(group.id, next);
                    setRenaming(false);
                  }}
                  onCancel={() => setRenaming(false)}
                  inputClassName="text-sm font-semibold text-fg-primary"
                />
              ) : (
                <>
                  <span className="truncate text-sm font-semibold text-fg-secondary">{group.name}</span>
                  {hasWaiting && (
                    <span
                      aria-label="Waiting for response"
                      className="ml-1.5 shrink-0 inline-block w-1.5 h-1.5 rounded-full bg-state-error"
                    />
                  )}
                  {!isSpecial && sessions.length > 0 && (
                    <span className="ml-1 text-label-meta">{sessions.length}</span>
                  )}
                </>
              )}
            </button>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem
            onSelect={() =>
              group.kind === 'archive' ? unarchiveGroup(group.id) : archiveGroup(group.id)
            }
          >
            {group.kind === 'archive' ? 'Unarchive group' : 'Archive group'}
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => setRenaming(true)}>Rename</ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem danger onSelect={() => setConfirmDelete(true)}>
            Delete group…
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {!collapsed && (
        <SortableContext items={sessionIds} strategy={verticalListSortingStrategy} id={group.id}>
          <ul
            className="mt-px"
            data-group-id={group.id}
            role="listbox"
          aria-label={group.name}
          onKeyDown={(e) => {
            const key = e.key;
            if (key !== 'ArrowDown' && key !== 'ArrowUp' && key !== 'Home' && key !== 'End') return;
            const list = e.currentTarget;
            const items = Array.from(
              list.querySelectorAll<HTMLLIElement>('li[role="option"]')
            );
            if (items.length === 0) return;
            const current = document.activeElement as HTMLElement | null;
            const idx = current ? items.indexOf(current as HTMLLIElement) : -1;
            let next = idx;
            if (key === 'ArrowDown') next = idx < 0 ? 0 : Math.min(idx + 1, items.length - 1);
            else if (key === 'ArrowUp') next = idx < 0 ? items.length - 1 : Math.max(idx - 1, 0);
            else if (key === 'Home') next = 0;
            else if (key === 'End') next = items.length - 1;
            if (next !== idx && items[next]) {
              e.preventDefault();
              items[next].focus();
            }
          }}
        >
          {sessions.map((s) => (
            <SessionRow
              key={s.id}
              session={s}
              active={s.id === activeSessionId}
              selected={!anyGroupFocused && s.id === activeSessionId}
              onSelect={() => onSelectSession(s.id)}
            />
          ))}
          </ul>
        </SortableContext>
      )}
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete "${group.name}"?`}
        description={
          sessions.length > 0
            ? `This group contains ${sessions.length} session${sessions.length === 1 ? '' : 's'}. They will be deleted with the group.`
            : 'This group is empty.'
        }
        confirmLabel="Delete group"
        destructive
        onConfirm={() => deleteGroup(group.id)}
      />
    </div>
  );
}

function SessionRow({ session, active, selected, onSelect }: { session: Session; active: boolean; selected: boolean; onSelect: () => void }) {
  const [renaming, setRenaming] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const groups = useStore((s) => s.groups).filter((g) => g.kind === 'normal');
  const renameSession = useStore((s) => s.renameSession);
  const deleteSession = useStore((s) => s.deleteSession);
  const moveSession = useStore((s) => s.moveSession);
  const createGroup = useStore((s) => s.createGroup);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: session.id,
    data: { type: 'session', groupId: session.groupId }
  });
  const style: React.CSSProperties = {
    transform: isDragging ? undefined : CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0 : 1
  };
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <li
          ref={setNodeRef}
          style={style}
          {...attributes}
          {...listeners}
          role="option"
          aria-selected={selected}
          tabIndex={selected ? 0 : -1}
          data-session-id={session.id}
          onClick={onSelect}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onSelect();
            }
          }}
          className={cn(
            'group/sess relative flex items-center gap-2.5 h-9 pl-3 pr-2 rounded-sm cursor-pointer text-base',
            'transition-[background-color,color,box-shadow] duration-150',
            '[transition-timing-function:cubic-bezier(0.32,0.72,0,1)]',
            'outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent',
            selected
              ? 'bg-bg-active text-fg-primary shadow-[inset_0_1px_0_0_oklch(1_0_0_/_0.05)]'
              : 'text-fg-secondary hover:bg-bg-hover hover:text-fg-primary',
            active && 'font-medium text-fg-primary'
          )}
        >
          {selected && (
            <motion.span
              aria-hidden
              initial={{ scaleY: 0, opacity: 0, x: -2 }}
              animate={{ scaleY: 1, opacity: 1, x: 0 }}
              transition={{ duration: 0.22, ease: [0.32, 0.72, 0, 1] }}
              style={{ originY: 0.5 }}
              className="absolute left-0 top-0 bottom-0 w-[3px] bg-accent rounded-r-sm"
            />
          )}
          <AgentIcon agentType={session.agentType} state={session.state} size="sm" />
          <span className="flex-1 min-w-0 leading-tight">
            {renaming ? (
              <InlineRename
                value={session.name}
                onCommit={(next) => {
                  renameSession(session.id, next);
                  setRenaming(false);
                }}
                onCancel={() => setRenaming(false)}
                inputClassName="text-base"
              />
            ) : (
              <span className="truncate block">{session.name}</span>
            )}
          </span>
          {active && (
            <span
              aria-label="Open in chat"
              className="shrink-0 inline-block w-1.5 h-1.5 rounded-full bg-accent"
            />
          )}
          <ConfirmDialog
            open={confirmDelete}
            onOpenChange={setConfirmDelete}
            title={`Delete "${session.name}"?`}
            description="The session and its conversation history will be removed."
            confirmLabel="Delete"
            destructive
            onConfirm={() => deleteSession(session.id)}
          />
        </li>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => setRenaming(true)}>Rename</ContextMenuItem>
        <ContextMenuSub>
          <ContextMenuSubTrigger>Move to group</ContextMenuSubTrigger>
          <ContextMenuSubContent>
            {groups.map((g) => (
              <ContextMenuItem
                key={g.id}
                disabled={g.id === session.groupId}
                onSelect={() => moveSession(session.id, g.id, null)}
              >
                {g.name}
              </ContextMenuItem>
            ))}
            <ContextMenuSeparator />
            <ContextMenuItem
              onSelect={() => {
                const id = createGroup();
                moveSession(session.id, id, null);
              }}
            >
              New group…
            </ContextMenuItem>
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuSeparator />
        <ContextMenuItem danger onSelect={() => setConfirmDelete(true)}>
          Delete
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

export type SidebarProps = {
  onCreateSession?: (cwd: string | null) => void;
  onOpenSettings?: () => void;
  onOpenPalette?: () => void;
  activeSessionId: string;
  focusedGroupId: string | null;
  onSelectSession: (id: string) => void;
  onFocusGroup: (id: string) => void;
  sessions: Session[];
  onMoveSession: (sessionId: string, targetGroupId: string, beforeSessionId: string | null) => void;
};

function NewSessionButton({ onCreateSession }: { onCreateSession?: (cwd: string | null) => void }) {
  return (
    <Button
      variant="raised"
      size="md"
      onClick={() => onCreateSession?.(null)}
      className="flex-1 h-8 text-xs gap-1.5"
    >
      <Plus size={14} className="stroke-[1.75]" />
      <span>New Session</span>
    </Button>
  );
}

export function Sidebar({ onCreateSession, onOpenSettings, onOpenPalette, activeSessionId, focusedGroupId, onSelectSession, onFocusGroup, sessions, onMoveSession }: SidebarProps) {
  const groups = useStore((s) => s.groups);
  const createGroup = useStore((s) => s.createGroup);
  const normal = groups.filter((g) => g.kind === 'normal');
  const archived = groups.filter((g) => g.kind === 'archive');
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));
  const draggingSession = draggingId ? sessions.find((s) => s.id === draggingId) ?? null : null;

  function handleDragStart(e: DragStartEvent) {
    setDraggingId(String(e.active.id));
  }

  function handleDragEnd(e: DragEndEvent) {
    setDraggingId(null);
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const activeId = String(active.id);
    const overId = String(over.id);
    // over.id is either a session id (drop on row) or a group id (drop on empty ul via SortableContext id)
    const overSession = sessions.find((s) => s.id === overId);
    if (overSession) {
      onMoveSession(activeId, overSession.groupId, overSession.id);
    } else {
      // dropped on empty group container — append
      onMoveSession(activeId, overId, null);
    }
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={() => setDraggingId(null)}
    >
    <motion.aside
      initial={false}
      className="relative flex flex-col w-64 bg-bg-sidebar/80 backdrop-blur-xl sidebar-edge overflow-hidden"
    >
      <div className="flex flex-col w-64 h-full">
          {/* Top: action zone — Search + New Session in one row.
              CodePilot-spec: h-8, bg-white/[0.06] semi-transparent on the
              sidebar's translucent surface, white/[0.08] hairline border,
              hover bumps to white/[0.12]. The sidebar bg is already
              bg-bg-sidebar/80 + backdrop-blur, so the buttons read as
              "frosted glass on frosted glass" without ever transparent-ing
              to the desktop. */}
          <div className="px-3 pt-3 pb-2 flex items-center gap-2">
            <NewSessionButton onCreateSession={onCreateSession} />
            <IconButton
              variant="raised"
              size="md"
              onClick={onOpenPalette}
              aria-label="Search"
              className="h-8 w-8 shrink-0"
            >
              <Search size={14} className="stroke-[1.5]" />
            </IconButton>
          </div>

          {/* Middle: work zone — Groups (flex-grow, scrollable) on top,
              Archived Groups pinned to a fixed-height block above Settings.
              Both lists scroll internally. */}
          <div className="mt-2 border-t border-border-subtle" />
          <div className="px-3 pt-3 pb-1 flex items-center justify-between shrink-0">
            <span className="text-label-section">
              Groups
            </span>
            <IconButton
              size="xs"
              variant="ghost"
              tooltip="New group"
              tooltipSide="top"
              aria-label="New group"
              onClick={() => createGroup()}
            >
              <Plus size={12} className="stroke-[1.75]" />
            </IconButton>
          </div>
          <nav className="flex-1 min-h-0 overflow-y-auto px-1.5 py-1">
            {normal.map((g) => (
              <GroupRow
                key={g.id}
                group={g}
                sessions={sessions.filter((s) => s.groupId === g.id)}
                activeSessionId={activeSessionId}
                focused={focusedGroupId === g.id}
                anyGroupFocused={focusedGroupId !== null}
                onSelectSession={onSelectSession}
                onFocus={() => onFocusGroup(g.id)}
              />
            ))}
          </nav>

          {/* Archived Groups — pinned bottom block. Header is clickable to
              fold/unfold; folded by default so it stays out of the way. */}
          <div className="border-t border-border-subtle shrink-0" />
          <button
            type="button"
            onClick={() => setArchiveOpen((o) => !o)}
            aria-expanded={archiveOpen}
            className={cn(
              'flex w-full items-center gap-1.5 px-3 py-2 outline-none shrink-0',
              'text-label-faint transition-colors duration-150',
              'hover:[&]:text-[oklch(0.60_0_0)]'
            )}
          >
            <motion.span
              initial={false}
              animate={{ rotate: archiveOpen ? 90 : 0 }}
              transition={{ duration: 0.2, ease: [0, 0, 0.2, 1] }}
              className="inline-flex shrink-0 text-[oklch(0.46_0_0)]"
            >
              <ChevronRight size={12} className="stroke-[1.75]" />
            </motion.span>
            <span>Archived Groups</span>
            <span className="ml-1 text-[11px] leading-[14px] font-normal text-[oklch(0.46_0_0)] tabular-nums">
              {archived.length}
            </span>
          </button>
          {archiveOpen && (
            <nav className="h-40 shrink-0 overflow-y-auto px-1.5 py-1">
              {archived.map((g) => (
                <GroupRow
                  key={g.id}
                  group={g}
                  sessions={sessions.filter((s) => s.groupId === g.id)}
                  activeSessionId={activeSessionId}
                  focused={focusedGroupId === g.id}
                  anyGroupFocused={focusedGroupId !== null}
                  onSelectSession={onSelectSession}
                  onFocus={() => onFocusGroup(g.id)}
                />
              ))}
            </nav>
          )}

          {/* Settings — its own zone at the bottom. */}
          <div className="px-3 pt-2 pb-3 border-t border-border-subtle">
            <Button
              variant="raised"
              size="md"
              onClick={onOpenSettings}
              className="w-full h-8 text-xs gap-1.5"
            >
              <Settings size={13} className="stroke-[1.5]" />
              <span>Settings</span>
            </Button>
          </div>
        </div>
    </motion.aside>
    <DragOverlay dropAnimation={{ duration: 150, easing: 'cubic-bezier(0.32,0.72,0,1)' }}>
      {draggingSession ? (
        <div
          className={cn(
            'flex items-center gap-2.5 h-9 pl-3 pr-2 rounded-sm text-base',
            'bg-bg-active text-fg-primary font-medium',
            'shadow-[0_12px_32px_-8px_rgba(0,0,0,0.5),0_0_0_1px_oklch(1_0_0_/_0.08)]',
            'w-60'
          )}
        >
          <AgentIcon agentType={draggingSession.agentType} state={draggingSession.state} size="sm" />
          <span className="truncate">{draggingSession.name}</span>
        </div>
      ) : null}
    </DragOverlay>
    </DndContext>
  );
}
