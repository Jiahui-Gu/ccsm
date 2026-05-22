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
//
// Perf: receives a `getSessionsForGroup` lookup from <Sidebar> rather than a
// flat `sessions` array we'd have to .filter() per row. The parent bucket is
// built once per `sessions` ref change, so each archived GroupRow's
// `sessions` prop ref stays stable when its own bucket didn't change —
// preserving React.memo on GroupRow / SessionRow.
function ArchivedSectionImpl({
  archivedGroups,
  normalGroups,
  getSessionsForGroup,
  activeSessionId,
  focusedGroupId,
  onSelectSession,
  onFocusGroup
}: {
  archivedGroups: Group[];
  normalGroups: Group[];
  getSessionsForGroup: (groupId: string) => Session[];
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
              sessions={getSessionsForGroup(g.id)}
              activeSessionId={activeSessionId}
              focused={focusedGroupId === g.id}
              anyGroupFocused={focusedGroupId !== null}
              onSelectSession={onSelectSession}
              onFocusGroup={onFocusGroup}
              normalGroups={normalGroups}
            />
          ))}
        </nav>
      )}
    </>
  );
}

// Memoize for symmetry with GroupRow / SessionRow so a Sidebar re-render
// driven by an unrelated store mutation (e.g. a session state toggle on a
// non-archived row) doesn't re-render the archived block. All props are
// ref-stable upstream: `archivedGroups` / `normalGroups` come from
// useMemo'd partitions of `groups`, `getSessionsForGroup` is useCallback'd,
// `activeSessionId` / `focusedGroupId` are primitives, and
// `onSelectSession` / `onFocusGroup` are direct Zustand action refs passed
// through App.tsx unchanged. See PR #1269.
export const ArchivedSection = React.memo(ArchivedSectionImpl);
