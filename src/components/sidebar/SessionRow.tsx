import React, { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useStore } from '../../stores/store';
import { cn } from '../../lib/cn';
import { AgentIcon } from '../AgentIcon';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger
} from '../ui/ContextMenu';
import { InlineRename } from '../ui/InlineRename';
import { useToast } from '../ui/Toast';
import { useTranslation } from '../../i18n/useTranslation';
import {
  MOTION_SESSION_SWITCH_DURATION,
  MOTION_STANDARD_EASING,
} from '../../lib/motion';
import type { Group, Session } from '../../types';

export function SessionRow({
  session,
  active,
  selected,
  onSelect,
  normalGroups
}: {
  session: Session;
  active: boolean;
  selected: boolean;
  onSelect: () => void;
  normalGroups: Group[];
}) {
  const { t } = useTranslation();
  const [renaming, setRenaming] = useState(false);
  // Transient flash from the notify pipeline (#689). ORed into AgentIcon's
  // halo trigger via the `flashing` prop so Rule 2 short-task pulses appear
  // even when `state === 'idle'`.
  const flashing = useStore((s) => s.flashStates[session.id] === true);
  // Per-session pty disconnect classification — populated by the app-boot
  // unconditional `pty:exit` listener (App.tsx). We surface the red dot
  // ONLY for `crashed` (signal or non-zero exit) — `clean` exits are
  // user-intentional (typed `/exit`) and shouldn't grab attention. The
  // dot clears when the user retries (TerminalPane → `_clearPtyExit`).
  const crashed = useStore(
    (s) => s.disconnectedSessions[session.id]?.kind === 'crashed'
  );
  // Perf: receive `normalGroups` as a prop computed once in the parent
  // <Sidebar>, rather than calling `s.groups.filter(...)` per row per render.
  const groups = normalGroups;
  const renameSession = useStore((s) => s.renameSession);
  const deleteSession = useStore((s) => s.deleteSession);
  const restoreSession = useStore((s) => s.restoreSession);
  const moveSession = useStore((s) => s.moveSession);
  const createGroup = useStore((s) => s.createGroup);
  const toast = useToast();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: session.id,
    data: { type: 'session', groupId: session.groupId }
  });
  const liRef = useRef<HTMLLIElement | null>(null);
  // Compose dnd-kit's ref with our own so we can call scrollIntoView when the
  // active session changes from off-screen → selected (J17).
  const composedRef = (node: HTMLLIElement | null) => {
    liRef.current = node;
    setNodeRef(node);
  };
  // J17: when this row becomes the active selection (e.g. via palette,
  // notification click, programmatic select), bring it into the sidebar
  // viewport. `block: 'nearest'` avoids snapping when the row is already
  // visible. Skip during drag so we don't fight the dnd transform.
  useEffect(() => {
    if (!selected || isDragging) return;
    const el = liRef.current;
    if (!el) return;
    el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [selected, isDragging]);
  const style: React.CSSProperties = {
    transform: isDragging ? undefined : CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0 : 1
  };
  // J4: session delete is a soft-delete with undo toast. We removed the
  // ConfirmDialog gate — destructive intent is already obvious from the
  // menu label, and the toast lets the user reverse a misclick within ~5s.
  const performDelete = () => {
    const snap = deleteSession(session.id);
    if (snap) {
      toast.push({
        kind: 'info',
        title: t('sidebar.sessionDeletedToast', { name: snap.session.name }),
        action: { label: t('common.undo'), onClick: () => restoreSession(snap) }
      });
    }
  };
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <li
          ref={composedRef}
          style={style}
          {...attributes}
          // Skip dnd-kit pointer listeners and remove tabIndex while the
          // inline-rename input is mounted. Two reasons:
          //   1. Drag-during-rename has no useful semantics.
          //   2. The listeners `preventDefault()` on mousedown, which
          //      combined with `tabIndex=0` lets the LI win the focus
          //      race against the just-mounted input — defeats Fix A1's
          //      onCloseAutoFocus guard if Radix dispatches a synthetic
          //      mouse event during close. Belt-and-suspenders for the
          //      session focus race the user reported.
          {...(renaming ? {} : listeners)}
          role="option"
          aria-selected={selected}
          tabIndex={renaming ? -1 : selected ? 0 : -1}
          data-session-id={session.id}
          onClick={onSelect}
          onContextMenu={() => {
            // J4b: right-click selects the row first, matching standard GUI
            // behavior where the context menu acts on "this row" — and the
            // user expects "this row" to be visually highlighted.
            onSelect();
          }}
          onKeyDown={(e) => {
            // Only handle keys when the <li> itself is the focused element.
            // Without this guard, typing a space in the inline-rename <input>
            // bubbles up here and gets preventDefault()-ed → spaces silently
            // disappear from the new name. Same risk for Enter, which we want
            // the input to commit on.
            if (e.target !== e.currentTarget) return;
            // F2 enters rename mode on the focused row — matches Finder /
            // VS Code explorer / Windows Explorer convention.
            if (e.key === 'F2' && !renaming) {
              e.preventDefault();
              setRenaming(true);
              return;
            }
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onSelect();
            }
          }}
          title={
            session.cwdMissing
              ? t('sidebar.cwdMissingTooltip', { cwd: session.cwd })
              : undefined
          }
          className={cn(
            'group/sess relative flex items-center gap-2.5 pl-3 pr-2 rounded-sm cursor-pointer text-chrome h-9',
            // Keep duration/easing in sync with the selection ring below and
            // with the right-pane content crossfade in ChatStream so clicking
            // a session reads as ONE coordinated motion across panes. See
            // src/lib/motion.ts (MOTION_SESSION_SWITCH_DURATION / EASING).
            'transition-[background-color,color,box-shadow] duration-[180ms]',
            '[transition-timing-function:cubic-bezier(0.32,0.72,0,1)]',
            'outline-none focus-ring',
            selected
              ? 'bg-bg-active text-fg-primary'
              : 'text-fg-secondary hover:bg-bg-hover hover:text-fg-primary',
            active && 'font-medium text-fg-primary',
            session.cwdMissing && 'opacity-55'
          )}
        >
          {selected && (
            <motion.span
              aria-hidden
              initial={{ scaleY: 0, opacity: 0, x: -2 }}
              animate={{ scaleY: 1, opacity: 1, x: 0 }}
              transition={{
                duration: MOTION_SESSION_SWITCH_DURATION,
                ease: MOTION_STANDARD_EASING
              }}
              style={{ originY: 0.5 }}
              className="absolute left-0 top-0 bottom-0 w-[3px] bg-accent rounded-r-sm"
            />
          )}
          <AgentIcon agentType={session.agentType} state={session.state} flashing={flashing} size="sm" />
          <span className="flex-1 min-w-0 leading-tight block">
            {renaming ? (
              <InlineRename
                value={session.name}
                onCommit={(next) => {
                  // renameSession is now async (optimistic update + SDK
                  // writeback); we don't await — local name updates
                  // synchronously and the JSONL writeback runs in the
                  // background. Errors are logged, not toasted.
                  void renameSession(session.id, next);
                  setRenaming(false);
                }}
                onCancel={() => setRenaming(false)}
                inputClassName="text-chrome"
              />
            ) : (
              <>
                <span
                  className="truncate block"
                  title={session.name}
                  onDoubleClick={(e) => {
                    // Double-click the label to enter rename mode — matches
                    // Finder / VS Code explorer convention. Stop propagation
                    // so the row's onClick doesn't fire a redundant select.
                    e.stopPropagation();
                    setRenaming(true);
                  }}
                >{session.name}</span>
              </>
            )}
          </span>
          {active && (
            <span className="sidebar-rail-cell sidebar-rail-cell--nested shrink-0">
              <span
                aria-label={t('sidebar.openInChat')}
                className="shrink-0 inline-block w-1.5 h-1.5 rounded-full bg-accent"
              />
            </span>
          )}
          {crashed && (
            // Crash indicator — sits to the right of the existing
            // state pip (separate rail cell so it doesn't displace
            // the live-state dot when both apply, e.g. a previously-
            // running session that just died). Reuses the canonical
            // `bg-state-error` token (no new red shade introduced).
            <span
              className="sidebar-rail-cell sidebar-rail-cell--nested shrink-0"
              data-session-crashed
              title={t('sidebar.sessionCrashed')}
            >
              <span
                aria-label={t('sidebar.sessionCrashed')}
                className="shrink-0 inline-block w-1.5 h-1.5 rounded-full bg-state-error"
              />
            </span>
          )}
        </li>
      </ContextMenuTrigger>
      <ContextMenuContent
        // Prevent Radix from restoring focus to the LI trigger after the
        // menu closes. Without this, Radix's `onCloseAutoFocus` calls
        // .focus() on the LI AFTER our InlineRename mount effect, and
        // because the LI carries dnd-kit `{...listeners}` plus
        // `tabIndex={selected ? 0 : -1}` it wins the focus race against
        // the just-mounted input. The user then types and nothing happens
        // because keys land on the (focused) LI, not the input. PR #527
        // fixed the auto-cancel side of this race; this preventDefault
        // closes the focus-stealing side.
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        <ContextMenuItem onSelect={() => setRenaming(true)}>{t('common.rename')}</ContextMenuItem>
        {(() => {
          // Exclude the session's current group from the destination list so
          // users can only move TO another group (#612). The submenu is
          // ALWAYS rendered so users can still create a new group via the
          // "New group..." escape hatch even when no other group exists (#629).
          const otherGroups = groups.filter((g) => g.id !== session.groupId);
          return (
            <ContextMenuSub>
              <ContextMenuSubTrigger data-testid="move-to-group-trigger">{t('sidebar.moveToGroup')}</ContextMenuSubTrigger>
              <ContextMenuSubContent data-testid="move-to-group-content">
                {otherGroups.map((g) => (
                  <ContextMenuItem
                    key={g.id}
                    data-move-to-group-item
                    data-group-id={g.id}
                    onSelect={() => moveSession(session.id, g.id, null)}
                  >
                    {g.name}
                  </ContextMenuItem>
                ))}
                {otherGroups.length > 0 && <ContextMenuSeparator />}
                <ContextMenuItem
                  onSelect={() => {
                    const id = createGroup();
                    moveSession(session.id, id, null);
                  }}
                >
                  {t('sidebar.newGroupEllipsis')}
                </ContextMenuItem>
              </ContextMenuSubContent>
            </ContextMenuSub>
          );
        })()}
        <ContextMenuSeparator />
        <ContextMenuItem danger onSelect={performDelete}>
          {t('common.delete')}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
