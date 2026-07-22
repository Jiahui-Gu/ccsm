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
  // Per-group disclosure overrides the phone user has explicitly toggled.
  // Only holds an entry once a group has actually been clicked; every other
  // group defers to its own persisted `group.collapsed` flag. This is the
  // single source of truth this drawer owns — `SessionNavigator`'s
  // `collapsedGroups` set is a *complete* effective set derived below, not
  // a diff, so a persisted `collapsed: true` group can be explicitly
  // re-expanded by one click without any size-based sentinel guessing
  // whether the set "means" anything.
  const [overrides, setOverrides] = useState<ReadonlyMap<string, boolean>>(() => new Map());

  // Reconcile stale overrides when a group disappears from the model (e.g.
  // deleted, or filtered out because it has no live sessions), so a group id
  // reused later never inherits a stranger's override. This only ever
  // *removes* entries for ids that are no longer present — an ordinary
  // polling refresh that resends the same group ids (even as a brand-new
  // `model` object) leaves every existing override untouched.
  useEffect(() => {
    const liveIds = new Set(model.groups.map((group) => group.id));
    setOverrides((current) => {
      let changed = false;
      const next = new Map(current);
      for (const id of current.keys()) {
        if (!liveIds.has(id)) {
          next.delete(id);
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [model]);

  // The complete, authoritative collapsed-id set handed to `SessionNavigator`:
  // a group's own override if it has one, else its persisted `collapsed` flag.
  const collapsedGroups = useMemo<ReadonlySet<string>>(() => {
    const result = new Set<string>();
    for (const group of model.groups) {
      const collapsed = overrides.has(group.id) ? overrides.get(group.id)! : group.collapsed;
      if (collapsed) result.add(group.id);
    }
    return result;
  }, [model, overrides]);

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
    setOverrides((current) => {
      const group = model.groups.find((candidate) => candidate.id === id);
      const currentlyCollapsed = current.has(id) ? current.get(id)! : group?.collapsed ?? false;
      const next = new Map(current);
      next.set(id, !currentlyCollapsed);
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
