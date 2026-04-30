import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { ChevronRight } from 'lucide-react';
import { cn } from '../../lib/cn';
import { useTranslation } from '../../i18n/useTranslation';
import { DURATION_RAW, EASING } from '../../lib/motion';
import type { Group, Session } from '../../types';
import { GroupRow } from './GroupRow';

// Archived groups block — pinned to the bottom of the expanded sidebar above
// the Settings cluster. Owns its own fold/unfold state because it's the only
// caller; folded by default per #553 (keeps archived groups out of the way).
//
// J14: archived groups are a "viewer" surface — DnD onto archived headers is
// rejected upstream in useSidebarDnd. The archived rows here intentionally
// don't render their own SortableContext (no empty-drop targets either).
export function ArchivedSection({
  archivedGroups,
  normalGroups,
  sessions,
  activeSessionId,
  focusedGroupId,
  onSelectSession,
  onFocusGroup
}: {
  archivedGroups: Group[];
  normalGroups: Group[];
  sessions: Session[];
  activeSessionId: string;
  focusedGroupId: string | null;
  onSelectSession: (id: string) => void;
  onFocusGroup: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [archiveOpen, setArchiveOpen] = useState(false);
  return (
    <>
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
          {archivedGroups.length}
        </span>
      </button>
      {archiveOpen && (
        <nav className="h-40 shrink-0 overflow-y-auto px-1.5 py-1">
          {archivedGroups.map((g) => (
            <GroupRow
              key={g.id}
              group={g}
              sessions={sessions.filter((s) => s.groupId === g.id)}
              activeSessionId={activeSessionId}
              focused={focusedGroupId === g.id}
              anyGroupFocused={focusedGroupId !== null}
              onSelectSession={onSelectSession}
              onFocus={() => onFocusGroup(g.id)}
              normalGroups={normalGroups}
            />
          ))}
        </nav>
      )}
    </>
  );
}
