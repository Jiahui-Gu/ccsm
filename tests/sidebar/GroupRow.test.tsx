import React from 'react';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { DndContext } from '@dnd-kit/core';
import { GroupRow } from '../../src/components/sidebar/GroupRow';
import { useStore } from '../../src/stores/store';
import { ToastProvider } from '../../src/components/ui/Toast';
import type { Group, Session } from '../../src/types';

// Snapshot smoke test for GroupRow extraction (Task #723 Phase A).
// Confirms the row renders: header + chevron + label + count badge, and
// the SortableContext-wrapped <ul> when expanded.
describe('<GroupRow /> (extracted)', () => {
  beforeEach(() => {
    useStore.setState({ flashStates: {}, disconnectedSessions: {} });
    if (!(Element.prototype as { scrollIntoView?: unknown }).scrollIntoView) {
      (Element.prototype as { scrollIntoView: () => void }).scrollIntoView = () => {};
    }
  });
  afterEach(() => cleanup());

  function renderGroupRow(group: Group, sessions: Session[]) {
    return render(
      <ToastProvider>
        <DndContext>
          <GroupRow
            group={group}
            sessions={sessions}
            activeSessionId={sessions[0]?.id ?? ''}
            focused={false}
            anyGroupFocused={false}
            onSelectSession={() => {}}
            onFocusGroup={() => {}}
            normalGroups={[group]}
          />
        </DndContext>
      </ToastProvider>
    );
  }

  it('renders the group label and the session count badge when expanded', () => {
    const group: Group = {
      id: 'g1',
      name: 'Inbox',
      collapsed: false,
      kind: 'normal',
    };
    const sessions: Session[] = [
      {
        id: 's1',
        name: 'Hello',
        state: 'idle',
        cwd: '/tmp',
        model: 'claude-sonnet-4',
        groupId: 'g1',
        agentType: 'claude-code',
      },
    ];
    const { getByText, getByRole, container } = renderGroupRow(group, sessions);

    expect(getByText('Inbox')).toBeInTheDocument();
    // Count badge ("1") is rendered when not special and sessions.length > 0.
    expect(getByText('1')).toBeInTheDocument();
    // The header button advertises expanded state.
    expect(getByRole('button', { name: /Inbox/ }).getAttribute('aria-expanded')).toBe('true');
    // The session list is mounted (collapsed=false).
    expect(container.querySelector('ul[role="listbox"]')).toBeTruthy();
  });

  it('hides the session list when collapsed', () => {
    const group: Group = {
      id: 'g1',
      name: 'Archived stuff',
      collapsed: true,
      kind: 'normal',
    };
    const { container, getByRole } = renderGroupRow(group, []);
    expect(container.querySelector('ul[role="listbox"]')).toBeFalsy();
    expect(getByRole('button', { name: /Archived stuff/ }).getAttribute('aria-expanded')).toBe('false');
  });

  // Task 4 (mobile-remote-shared-ui plan) — GroupRow's header body (chevron
  // + label + count) now composes the shared SessionGroupHeader presentation
  // via SessionGroupHeaderBody, while GroupRow keeps ownership of the
  // droppable header, focus/rename/menu behavior, and the button itself.
  it('exposes aria-expanded on the header button when expanded (shared presentation)', () => {
    const group: Group = { id: 'g1', name: 'Group A', collapsed: false, kind: 'normal' };
    const sessions: Session[] = [
      {
        id: 's1',
        name: 'Session A',
        state: 'idle',
        cwd: '/tmp',
        model: 'claude-sonnet-4',
        groupId: 'g1',
        agentType: 'claude-code',
      },
    ];
    const { getByRole } = renderGroupRow(group, sessions);
    expect(getByRole('button', { name: /Group A/ })).toHaveAttribute('aria-expanded', 'true');
  });
});
