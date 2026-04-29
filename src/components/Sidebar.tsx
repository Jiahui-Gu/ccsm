import React, { useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import {
  ChevronRight,
  Download,
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
import { useStore } from '../stores/store';
import { cn } from '../lib/cn';
import { IconButton } from './ui/IconButton';
import { Button } from './ui/Button';
import { AgentIcon } from './AgentIcon';
import { CwdPopover } from './CwdPopover';
import { DragRegion } from './WindowControls';
import { useTranslation } from '../i18n/useTranslation';
import {
  DURATION_RAW,
  EASING,
} from '../lib/motion';
import type { Session } from '../types';
import { GroupRow } from './sidebar/GroupRow';
import { NewSessionButton } from './sidebar/NewSessionButton';
import { parseHeaderDroppable } from './sidebar/dnd';

// Session order inside a group is user-controlled (drag to reorder) — not
// derived from state. The array order handed down from the store is the
// source of truth; don't re-sort it here.

export type SidebarProps = {
  /** Create a new session in-place. The store seeds `cwd` from the user's
   *  home directory (the always-true default per the new spec); the user
   *  repicks via the StatusBar cwd chip. No modal involved — see
   *  App.tsx::newSession. */
  onCreateSession?: () => void;
  onOpenSettings?: () => void;
  onOpenPalette?: () => void;
  onOpenImport?: () => void;
  activeSessionId: string;
  focusedGroupId: string | null;
  onSelectSession: (id: string) => void;
  onFocusGroup: (id: string) => void;
  sessions: Session[];
  onMoveSession: (sessionId: string, targetGroupId: string, beforeSessionId: string | null) => void;
};

export function Sidebar({ onCreateSession, onOpenSettings, onOpenPalette, onOpenImport, activeSessionId, focusedGroupId, onSelectSession, onFocusGroup, sessions, onMoveSession }: SidebarProps) {
  const { t } = useTranslation();
  const groups = useStore((s) => s.groups);
  const createGroup = useStore((s) => s.createGroup);
  const collapsed = useStore((s) => s.sidebarCollapsed);
  const sidebarWidth = useStore((s) => s.sidebarWidth);
  const toggleSidebar = useStore((s) => s.toggleSidebar);
  // Perf: hoist the normal/archive partition to the parent so SessionRow
  // (which needs `normalGroups` for its move-to-group menu) doesn't recompute
  // it per row per render. `useMemo` keeps the array reference stable across
  // re-renders triggered by unrelated store mutations.
  const normal = useMemo(() => groups.filter((g) => g.kind === 'normal'), [groups]);
  const archived = useMemo(() => groups.filter((g) => g.kind === 'archive'), [groups]);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  // J2: track the most recently created group so its <GroupRow> mounts in
  // inline-rename mode. Cleared after the next render cycle so toggling rename
  // off (or remounting) doesn't accidentally re-trigger it.
  const [justCreatedGroupId, setJustCreatedGroupId] = useState<string | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));
  const draggingSession = draggingId ? sessions.find((s) => s.id === draggingId) ?? null : null;

  // Cwd picker for the top "+ New session" cluster. The per-group chevron
  // was removed (#605) — only the top picker remains, so a plain boolean
  // suffices here.
  const [topCwdPickerOpen, setTopCwdPickerOpen] = useState(false);

  // Anchor ref for the top New Session chevron — passed into both the
  // <NewSessionButton> (which forwards to the IconButton) and the top-level
  // <CwdPopover> instance for fixed-position anchoring.
  const topChevronRef = useRef<HTMLButtonElement>(null);

  // Wire the top picker through createSession({ cwd }). The renderer's
  // `onCreateSession` prop only knows the LRU-default flow; for the chevron
  // path we go straight to the store so we can pass an explicit cwd.
  const createSession = useStore((s) => s.createSession);

  function handleNewGroup() {
    const id = createGroup();
    setJustCreatedGroupId(id);
    // Focus the new group so a subsequent "New session" lands inside it.
    onFocusGroup(id);
  }

  // Clear the auto-rename flag once the GroupRow has had its mount effect.
  useEffect(() => {
    if (!justCreatedGroupId) return;
    // Defer one frame so the row mounts in renaming=true; then clear so a
    // re-render (caused by another store update) doesn't toggle it back on.
    const h = window.setTimeout(() => setJustCreatedGroupId(null), 0);
    return () => window.clearTimeout(h);
  }, [justCreatedGroupId]);

  function handleDragStart(e: DragStartEvent) {
    setDraggingId(String(e.active.id));
  }

  function handleDragEnd(e: DragEndEvent) {
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
    if (normal.some((g) => g.id === overId)) {
      // Same archive guard: SortableContext for archived groups isn't
      // rendered today, but defend anyway in case the archive list grows
      // empty-drop targets later.
      const target = groups.find((g) => g.id === overId);
      if (!target || target.kind !== 'normal') return;
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
      // Collapsed → 48px rail. Expanded → user-resizable px width persisted in
      // the store (see SidebarResizer + store.sidebarWidth). framer-motion
      // tweens the change so collapse/expand stays smooth.
      animate={{ width: collapsed ? 48 : sidebarWidth }}
      transition={{ duration: DURATION_RAW.ms220, ease: EASING.standard }}
      className="relative flex flex-col shrink-0 bg-bg-sidebar/80 backdrop-blur-xl sidebar-edge overflow-hidden h-full"
    >
      {/* Top drag strip — Windows-only build, so we only need a thin
          drag-to-move band (8px) to preserve OS window-drag affordance.
          The right pane keeps its 32px band because it must host
          WindowControls (min/max/close buttons). The slight misalignment
          is intentional: dogfood flagged the 32px gap above "new session"
          as visually empty. */}
      <DragRegion className="shrink-0 w-full" style={{ height: window.ccsm?.window.platform === 'darwin' ? 40 : 8 }} />
      {collapsed ? (
        <div className={`flex flex-col items-center w-full h-full gap-2 ${window.ccsm?.window.platform === 'darwin' ? 'py-1' : 'py-3'}`}>
          <IconButton
            variant="raised"
            size="md"
            onClick={toggleSidebar}
            tooltip={t('sidebar.expandSidebarTooltip')}
            tooltipSide="right"
            aria-label={t('sidebar.expandSidebarAria')}
            className="h-8 w-8"
          >
            <ChevronRight size={14} className="stroke-[1.5]" />
          </IconButton>
          <IconButton
            variant="raised"
            size="md"
            onClick={() => onCreateSession?.()}
            tooltip={t('sidebar.newSessionTooltip')}
            tooltipSide="right"
            aria-label={t('sidebar.newSessionAria')}
            className="h-8 w-8"
          >
            <Plus size={14} className="stroke-[1.75]" />
          </IconButton>
          <IconButton
            variant="raised"
            size="md"
            onClick={onOpenPalette}
            tooltip={t('sidebar.searchTooltip')}
            tooltipSide="right"
            aria-label={t('sidebar.searchAriaShort')}
            className="h-8 w-8"
          >
            <Search size={14} className="stroke-[1.5]" />
          </IconButton>
          <div className="flex-1" />
          <IconButton
            variant="raised"
            size="md"
            onClick={onOpenImport}
            tooltip={t('sidebar.importTooltip')}
            tooltipSide="right"
            aria-label={t('sidebar.importAriaShort')}
            className="h-8 w-8"
          >
            <Download size={14} className="stroke-[1.5]" />
          </IconButton>
          <IconButton
            variant="raised"
            size="md"
            onClick={onOpenSettings}
            tooltip={t('sidebar.settingsTooltip')}
            tooltipSide="right"
            aria-label={t('sidebar.settingsAria')}
            className="h-8 w-8"
          >
            <Settings size={14} className="stroke-[1.5]" />
          </IconButton>
        </div>
      ) : (
      <div className="flex flex-col w-full h-full">
          {/* Top: action zone — Search + New Session in one row.
              CodePilot-spec: h-8, bg-white/[0.06] semi-transparent on the
              sidebar's translucent surface, white/[0.08] hairline border,
              hover bumps to white/[0.12]. The sidebar bg is already
              bg-bg-sidebar/80 + backdrop-blur, so the buttons read as
              "frosted glass on frosted glass" without ever transparent-ing
              to the desktop. */}
          {/* #606: bumped pt-1 → pt-4 to give the New Session + Search row
              more breathing room from the window-top drag strip. The previous
              pt-1 was tuned for symmetry with the Settings block at the
              bottom; that symmetry is intentionally broken here per user
              feedback (top edge felt cramped). Total top gap is now
              8px (DragRegion) + 16px (pt-4) = 24px. */}
          <div data-testid="sidebar-newsession-row" className="px-3 pt-4 pb-3 flex items-center gap-2">
            <NewSessionButton
              onCreateSession={onCreateSession}
              cwdPopoverOpen={topCwdPickerOpen}
              onCwdPopoverOpenChange={setTopCwdPickerOpen}
              chevronRef={topChevronRef}
            />
            <IconButton
              variant="raised"
              size="md"
              onClick={onOpenPalette}
              aria-label={t('sidebar.searchAriaShort')}
              className="h-8 w-8 shrink-0"
            >
              <Search size={14} className="stroke-[1.5]" />
            </IconButton>
          </div>
          <CwdPopover
            open={topCwdPickerOpen}
            onOpenChange={setTopCwdPickerOpen}
            anchorRef={topChevronRef}
            onPick={(picked) => {
              createSession({ cwd: picked });
              setTopCwdPickerOpen(false);
            }}
            onBrowse={async () => {
              // Close the popover synchronously so a slow OS dialog doesn't
              // leave a dangling Recent list under the modal. The popover's
              // own click-outside handler would catch the dialog click on
              // some platforms anyway, but explicit > implicit.
              setTopCwdPickerOpen(false);
              const picked = await window.ccsm?.pickCwd?.();
              if (typeof picked === 'string' && picked.length > 0) {
                createSession({ cwd: picked });
              }
            }}
          />

          {/* Middle: work zone — Groups (flex-grow, scrollable) on top,
              Archived Groups pinned to a fixed-height block above Settings.
              Both lists scroll internally. */}
          {/* Divider sits flush with NewSession row bottom; the row's pb-3 (12px) IS the gap to this divider — symmetric with the 12px window-top→NewSession-top gap. */}
          <div data-testid="sidebar-divider-groups" className="border-t border-border-subtle" />
          <div data-testid="sidebar-groups-label" className="px-3 pt-3 pb-1 flex items-center justify-between shrink-0">
            <span className="text-label-section">
              {t('sidebar.groups')}
            </span>
            <span className="sidebar-rail-cell shrink-0">
              <IconButton
                size="xs"
                variant="ghost"
                tooltip={t('sidebar.newGroup')}
                tooltipSide="top"
                aria-label={t('sidebar.newGroup')}
                onClick={() => handleNewGroup()}
              >
                <Plus size={12} className="stroke-[1.75]" />
              </IconButton>
            </span>
          </div>
          <nav className="flex-1 min-h-0 overflow-y-auto px-1.5 py-1">
            {normal.length === 0 ? (
              <div className="px-2 py-1.5 text-meta text-fg-tertiary">
                {t('sidebar.groupsEmptyHint')}
              </div>
            ) : null}
            {normal.map((g) => (
              <GroupRow
                key={g.id}
                group={g}
                sessions={sessions.filter((s) => s.groupId === g.id)}
                activeSessionId={activeSessionId}
                focused={focusedGroupId === g.id}
                anyGroupFocused={focusedGroupId !== null}
                autoRename={justCreatedGroupId === g.id}
                onSelectSession={onSelectSession}
                onFocus={() => onFocusGroup(g.id)}
                normalGroups={normal}
              />
            ))}
          </nav>

          {/* Archived Groups — pinned bottom block. Header is clickable to
              fold/unfold; folded by default so it stays out of the way. */}
          <div data-testid="sidebar-divider-archived" className="border-t border-border-subtle shrink-0" />
          <button
            type="button"
            onClick={() => setArchiveOpen((o) => !o)}
            aria-expanded={archiveOpen}
            className={cn(
              'flex w-full items-center gap-1.5 px-3 py-2 outline-none shrink-0',
              'text-label-faint transition-colors duration-150',
              'hover:[&]:text-fg-tertiary'
            )}
          >
            <motion.span
              initial={false}
              animate={{ rotate: archiveOpen ? 90 : 0 }}
              transition={{ duration: DURATION_RAW.ms200, ease: EASING.enter }}
              className="inline-flex shrink-0 text-fg-faint"
            >
              <ChevronRight size={12} className="stroke-[1.75]" />
            </motion.span>
            <span>{t('sidebar.archivedGroups')}</span>
            <span className="ml-1 text-mono-sm leading-[14px] font-normal text-fg-faint tabular-nums">
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
                  normalGroups={normal}
                />
              ))}
            </nav>
          )}

          {/* Settings — its own zone at the bottom. Mirrors the top zone's
              two-button rhythm (flex-1 text Button + fixed-width IconButton)
              so the sidebar's top and bottom action rows feel symmetrical.
              pb-3 (12px) — matches the InputBar wrapper's pb-3, which puts
              the textarea wrapper's bottom edge 12px above the window bottom.
              The Settings/Import button bottoms align to that same Y.
              The 8px DragRegion above + pt-1 (4px) on the top wrapper give
              12px from sidebar.top to New Session.top — symmetric with this
              12px from sidebar.bottom to Settings.bottom. UX audit Group A. */}
          {/* pt-[17px] (12 + 5) lifts the bottom block 5px so the divider
              above the collapsed Archived row sits at the same Y as the
              InputBar wrapper top edge — visual cross-pane alignment. */}
          <div className="px-3 pt-[17px] pb-3 border-t border-border-subtle flex items-center gap-2">
            <Button
              variant="raised"
              size="md"
              onClick={onOpenSettings}
              className="flex-1 h-8 text-chrome gap-1.5"
            >
              <Settings size={14} className="stroke-[1.5]" />
              <span>{t('common.settings')}</span>
            </Button>
            <IconButton
              variant="raised"
              size="md"
              onClick={onOpenImport}
              tooltip={t('sidebar.importTooltip')}
              tooltipSide="top"
              aria-label={t('sidebar.importAriaShort')}
              className="h-8 w-8 shrink-0"
            >
              <Download size={14} className="stroke-[1.5]" />
            </IconButton>
          </div>
        </div>
      )}
    </motion.aside>
    <DragOverlay dropAnimation={{ duration: 150, easing: 'cubic-bezier(0.32,0.72,0,1)' }}>
      {draggingSession ? (
        <div
          className={cn(
            'flex items-center gap-2.5 h-9 pl-3 pr-2 rounded-sm text-chrome',
            'bg-bg-active text-fg-primary font-medium',
            'shadow-[var(--shadow-drag-overlay)]',
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
