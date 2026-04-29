import React, { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { ChevronRight } from 'lucide-react';
import {
  useDroppable
} from '@dnd-kit/core';
import {
  SortableContext,
  verticalListSortingStrategy
} from '@dnd-kit/sortable';
import { useStore } from '../../stores/store';
import { cn } from '../../lib/cn';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '../ui/ContextMenu';
import { InlineRename } from '../ui/InlineRename';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { useToast } from '../ui/Toast';
import { useTranslation } from '../../i18n/useTranslation';
import {
  DURATION_RAW,
  EASING,
} from '../../lib/motion';
import type { Group, Session } from '../../types';
import { headerDroppableId } from './dnd';
import { SessionRow } from './SessionRow';

export function GroupRow({
  group,
  sessions,
  activeSessionId,
  focused,
  anyGroupFocused,
  autoRename,
  onSelectSession,
  onFocus,
  normalGroups
}: {
  group: Group;
  sessions: Session[];
  activeSessionId: string;
  focused: boolean;
  anyGroupFocused: boolean;
  /** When true, the GroupRow mounts in inline-rename mode with the input
   *  pre-focused — used right after `createGroup()` so the user can name the
   *  group without an extra click. Cleared by the parent once consumed. */
  autoRename?: boolean;
  onSelectSession: (id: string) => void;
  onFocus: () => void;
  /** Pre-filtered list of normal (non-archive) groups, hoisted to the parent
   *  Sidebar so we don't recompute per SessionRow per render. */
  normalGroups: Group[];
}) {
  const { t } = useTranslation();
  const sessionIds = sessions.map((s) => s.id);
  const hasWaiting = sessions.some((s) => s.state === 'waiting');
  const setGroupCollapsed = useStore((s) => s.setGroupCollapsed);
  const renameGroup = useStore((s) => s.renameGroup);
  const deleteGroup = useStore((s) => s.deleteGroup);
  const restoreGroup = useStore((s) => s.restoreGroup);
  const archiveGroup = useStore((s) => s.archiveGroup);
  const unarchiveGroup = useStore((s) => s.unarchiveGroup);
  const toast = useToast();
  const collapsed = group.collapsed;
  const [renaming, setRenaming] = useState(!!autoRename);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const isSpecial = group.kind !== 'normal';
  // Previously gated against a `kind: 'deleted'` enum value that no code path
  // ever produced. Now that the enum is normal | archive only, no group is
  // ever menu-disabled (archived groups still allow rename / unarchive).
  const menuDisabled = false;
  const { isOver, setNodeRef: setHeaderDropRef } = useDroppable({
    id: headerDroppableId(group.id),
    data: { type: 'group-header', groupId: group.id }
  });
  // Hover-to-expand: if a session is dragged over a collapsed group's header
  // for 400ms, open it so the user can drop further into its list. Cancel if
  // they leave before the timer fires.
  const expandTimerRef = useRef<number | null>(null);
  useEffect(() => {
    if (!isOver || !collapsed) {
      if (expandTimerRef.current !== null) {
        window.clearTimeout(expandTimerRef.current);
        expandTimerRef.current = null;
      }
      return;
    }
    expandTimerRef.current = window.setTimeout(() => {
      setGroupCollapsed(group.id, false);
      expandTimerRef.current = null;
    }, 400);
    return () => {
      if (expandTimerRef.current !== null) {
        window.clearTimeout(expandTimerRef.current);
        expandTimerRef.current = null;
      }
    };
  }, [isOver, collapsed, group.id, setGroupCollapsed]);
  return (
    <div className="mb-2">
      <ContextMenu>
        <ContextMenuTrigger asChild disabled={menuDisabled}>
          <div
            ref={setHeaderDropRef}
            data-group-header-id={group.id}
            className={cn(
              'group/row relative flex items-center h-7 px-2 rounded-sm transition-colors duration-120 ease-out',
              focused
                ? 'bg-bg-active'
                : 'hover:bg-bg-hover',
              isOver && 'ring-1 ring-inset ring-accent bg-bg-active'
            )}
          >
            {focused && (
              <motion.span
                aria-hidden
                initial={{ scaleY: 0, opacity: 0, x: -2 }}
                animate={{ scaleY: 1, opacity: 1, x: 0 }}
                transition={{ duration: DURATION_RAW.ms220, ease: EASING.standard }}
                style={{ originY: 0.5 }}
                className="absolute left-0 top-0 bottom-0 w-[3px] bg-accent rounded-r-sm"
              />
            )}
            <button
              onClick={() => {
                onFocus();
                if (!renaming) setGroupCollapsed(group.id, !collapsed);
              }}
              onKeyDown={(e) => {
                // F2 enters rename mode — matches the SessionRow F2 handler
                // and Finder / VS Code explorer convention. Special groups
                // (archive) have no rename action in their menu, so don't
                // permit F2 either to keep behavior consistent with the
                // visible affordances. (`isSpecial` is checked via the same
                // `kind !== 'normal'` rule used for the menu disable gate.)
                if (e.key === 'F2' && !renaming && !isSpecial) {
                  e.preventDefault();
                  setRenaming(true);
                }
              }}
              className="flex flex-1 min-w-0 items-center gap-1.5 text-left text-fg-secondary outline-none rounded-sm focus-ring"
              aria-expanded={!collapsed}
            >
              <motion.span
                initial={false}
                animate={{ rotate: collapsed ? 0 : 90 }}
                transition={{ duration: DURATION_RAW.ms200, ease: EASING.enter }}
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
                  inputClassName="text-chrome font-semibold text-fg-primary"
                />
              ) : (
                <>
                  <span
                    className="truncate text-chrome font-semibold text-fg-secondary"
                    onDoubleClick={(e) => {
                      // Double-click the label to enter rename mode — matches
                      // the SessionRow handler. Stop propagation so the
                      // wrapping <button>'s onClick doesn't toggle collapsed
                      // on the same gesture. Skip for special (archive)
                      // groups since they have no rename action.
                      if (isSpecial) return;
                      e.stopPropagation();
                      setRenaming(true);
                    }}
                  >{group.nameKey ? t(group.nameKey) : group.name}</span>
                  {hasWaiting && (
                    <span
                      aria-label={t('sidebar.waitingForResponse')}
                      className="ml-1.5 shrink-0 inline-block w-1.5 h-1.5 rounded-full bg-state-waiting"
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
        <ContextMenuContent
          // Prevent Radix from restoring focus to the trigger after the
          // menu closes. When `Rename` is selected, Radix would otherwise
          // .focus() the trigger element AFTER our InlineRename mount
          // effect, racing the input's focus. Group rows happen to win
          // that race today (no dnd-kit listeners on the trigger), but
          // belt-and-suspenders here keeps parity with SessionRow and
          // hardens against future regressions.
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          <ContextMenuItem onSelect={() => setRenaming(true)}>{t('common.rename')}</ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            onSelect={() =>
              group.kind === 'archive' ? unarchiveGroup(group.id) : archiveGroup(group.id)
            }
          >
            {group.kind === 'archive' ? t('sidebar.unarchiveGroup') : t('sidebar.archiveGroup')}
          </ContextMenuItem>
          <ContextMenuItem danger onSelect={() => setConfirmDelete(true)}>
            {t('sidebar.deleteGroupEllipsis')}
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
            // Don't hijack arrows while the inline-rename input is focused —
            // the user is editing text and expects ←/→ to move the caret,
            // ↑/↓ to be no-ops (browsers don't move caret vertically in a
            // single-line input but also don't navigate the listbox). Same
            // guard pattern lives on the SessionRow's own onKeyDown.
            if ((e.target as HTMLElement).tagName === 'INPUT') return;
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
              normalGroups={normalGroups}
            />
          ))}
          </ul>
        </SortableContext>
      )}
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={t('sidebar.deleteGroupConfirmTitle', { name: group.name })}
        description={
          sessions.length > 0
            ? t('sidebar.deleteGroupNonEmptyKept', { count: sessions.length })
            : t('sidebar.deleteGroupEmpty')
        }
        confirmLabel={t('sidebar.deleteGroup')}
        cancelLabel={t('common.cancel')}
        destructive
        onConfirm={() => {
          const snap = deleteGroup(group.id);
          if (snap) {
            toast.push({
              kind: 'info',
              title: t('sidebar.groupDeletedToast', { name: snap.group.name }),
              action: { label: t('common.undo'), onClick: () => restoreGroup(snap) }
            });
          }
        }}
      />
    </div>
  );
}
