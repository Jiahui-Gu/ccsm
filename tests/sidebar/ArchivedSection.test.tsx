// RTL coverage for <ArchivedSection /> — the bottom-of-sidebar block that
// folds away the user's archived groups. The component owns its own
// open/closed state (folded by default per #553), so the toggle is a pure
// React-state interaction we can drive entirely through fireEvent.
//
// Asserted: archived count badge, folded-by-default, click-to-expand, the
// chevron's aria-expanded mirror, that GroupRow children only mount when
// open, and that sessions are filtered to their owning archived group.
import React from 'react';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { DndContext } from '@dnd-kit/core';
import { ArchivedSection } from '../../src/components/sidebar/ArchivedSection';
import { ToastProvider } from '../../src/components/ui/Toast';
import { useStore } from '../../src/stores/store';
import type { Group, Session } from '../../src/types';

function renderArchived(props: {
  archivedGroups: Group[];
  normalGroups?: Group[];
  sessions?: Session[];
}) {
  return render(
    <ToastProvider>
      <DndContext>
        <ArchivedSection
          archivedGroups={props.archivedGroups}
          normalGroups={props.normalGroups ?? []}
          sessions={props.sessions ?? []}
          activeSessionId=""
          focusedGroupId={null}
          onSelectSession={() => {}}
          onFocusGroup={() => {}}
        />
      </DndContext>
    </ToastProvider>
  );
}

describe('<ArchivedSection />', () => {
  beforeEach(() => {
    useStore.setState({ flashStates: {}, disconnectedSessions: {} });
    if (!(Element.prototype as { scrollIntoView?: unknown }).scrollIntoView) {
      (Element.prototype as { scrollIntoView: () => void }).scrollIntoView =
        () => {};
    }
  });
  afterEach(() => cleanup());

  const g: Group = { id: 'a1', name: 'Archived A', collapsed: false, kind: 'normal' };
  const g2: Group = { id: 'a2', name: 'Archived B', collapsed: false, kind: 'normal' };

  it('renders header with translated label and the archived group count', () => {
    const { getByText, getByRole } = renderArchived({ archivedGroups: [g, g2] });
    expect(getByText(/archived groups/i)).toBeInTheDocument();
    // The numeric count appears next to the label.
    expect(getByText('2')).toBeInTheDocument();
    // Folded by default per #553.
    expect(getByRole('button', { name: /archived groups/i }).getAttribute('aria-expanded')).toBe('false');
  });

  it('keeps the archived group rows hidden while folded', () => {
    const { container, queryByText } = renderArchived({
      archivedGroups: [g],
    });
    // No <nav> for the list when folded.
    expect(container.querySelector('nav')).toBeNull();
    expect(queryByText('Archived A')).toBeNull();
  });

  it('expands on click and renders one GroupRow per archived group', () => {
    const sess: Session[] = [
      {
        id: 's1',
        name: 'In Archived A',
        state: 'idle',
        cwd: '/tmp',
        model: 'claude-sonnet-4',
        groupId: 'a1',
        agentType: 'claude-code',
      },
      {
        id: 's2',
        name: 'Outside',
        state: 'idle',
        cwd: '/tmp',
        model: 'claude-sonnet-4',
        groupId: 'other',
        agentType: 'claude-code',
      },
    ];
    const { getByRole, getByText, queryByText, container } = renderArchived({
      archivedGroups: [g, g2],
      sessions: sess,
    });

    const toggle = getByRole('button', { name: /archived groups/i });
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');

    // The list <nav> is mounted now.
    expect(container.querySelector('nav')).not.toBeNull();
    // Both archived groups render as GroupRows.
    expect(getByText('Archived A')).toBeInTheDocument();
    expect(getByText('Archived B')).toBeInTheDocument();
    // The session belonging to a1 reaches it; the unrelated one is filtered out.
    expect(getByText('In Archived A')).toBeInTheDocument();
    expect(queryByText('Outside')).toBeNull();
  });

  it('toggles back to folded on a second click', () => {
    const { getByRole, container } = renderArchived({ archivedGroups: [g] });
    const toggle = getByRole('button', { name: /archived groups/i });
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('nav')).not.toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('nav')).toBeNull();
  });

  it('renders the divider above the section', () => {
    const { getByTestId } = renderArchived({ archivedGroups: [] });
    expect(getByTestId('sidebar-divider-archived')).toBeInTheDocument();
  });

  it('shows zero count and stays foldable when the user has no archived groups', () => {
    const { getByText, getByRole } = renderArchived({ archivedGroups: [] });
    expect(getByText('0')).toBeInTheDocument();
    // Toggle still works; expanded state simply produces an empty nav.
    const toggle = getByRole('button', { name: /archived groups/i });
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
  });
});
