// Temporary session-navigation drawer (mobile composer/terminal-sync plan,
// Task 5; approved spec "Phone input model" and plan lines 726-935).
// Wraps the shared touch-density `SessionNavigator` as an accessible,
// temporary overlay at all breakpoints.
//
// Final user override (supersedes the plan's older focus-trap/restoration
// text): this drawer has NO programmatic focus trap and NO focus
// restoration to the menu button. It stays accessible purely through
// role/aria attributes plus Escape (a document keydown listener, not a
// focus interception), a backdrop pointer action, an explicit close
// control, and session selection — and it never calls `focus()` or
// `blur()` on anything, anywhere.

import { useEffect, useMemo, useState } from 'react';

import { SessionNavigator } from '../../shared/sessionNavigator/SessionNavigator';
import type { SessionNavigatorModel } from '../../shared/sessionNavigator/types';

export type SessionDrawerProps = {
  open: boolean;
  model: SessionNavigatorModel;
  selectedSessionId: string | null;
  onClose: () => void;
  onSelectSession: (sessionId: string) => void;
};

export function SessionDrawer({
  open,
  model,
  selectedSessionId,
  onClose,
  onSelectSession,
}: SessionDrawerProps) {
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<string>>(() => new Set());

  // Reflect the phone's own selection, not a stale desktop `activeSessionId`
  // that may have been set by an unrelated tab switch on another client.
  const effectiveModel = useMemo<SessionNavigatorModel>(
    () => ({ ...model, activeSessionId: selectedSessionId }),
    [model, selectedSessionId],
  );

  useEffect(() => {
    if (!open) return undefined;
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  function handleToggleGroup(id: string): void {
    setCollapsedGroups((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  if (!open) return null;

  return (
    <div className="session-drawer">
      <div className="session-drawer__backdrop" onClick={onClose} />
      <div
        className="session-drawer__panel"
        role="dialog"
        aria-modal="true"
        aria-label="Sessions"
        id="phone-session-drawer"
      >
        <div className="session-drawer__header">
          <button type="button" className="session-drawer__close" onClick={onClose}>
            Close
          </button>
        </div>
        <SessionNavigator
          model={effectiveModel}
          collapsedGroups={collapsedGroups}
          onToggleGroup={handleToggleGroup}
          onSelectSession={onSelectSession}
          density="touch"
        />
      </div>
    </div>
  );
}
