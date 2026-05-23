import React from 'react';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { DndContext } from '@dnd-kit/core';
import { SortableContext } from '@dnd-kit/sortable';
import { SessionRow } from '../../src/components/sidebar/SessionRow';
import { useStore } from '../../src/stores/store';
import { ToastProvider } from '../../src/components/ui/Toast';
import type { Group, Session } from '../../src/types';

// Covers the regrouped right-click menu: three sections separated by two
// dividers — (1) Rename + Copy session, (2) Move to group + Archive/Unarchive,
// (3) Reload session + Delete. Pure structural assertion: handlers and i18n
// keys are unchanged, so this test only guards that the JSX reorder did not
// drop any item, dropped any item into the wrong section, or lost a
// separator. Both the not-archived and already-archived branches of the
// Archive/Unarchive conditional are exercised.
describe('<SessionRow /> context menu structure', () => {
  beforeEach(() => {
    useStore.setState({ flashStates: {}, disconnectedSessions: {} });
    if (!(Element.prototype as { scrollIntoView?: unknown }).scrollIntoView) {
      (Element.prototype as { scrollIntoView: () => void }).scrollIntoView = () => {};
    }
    // Radix' Portal uses hasPointerCapture / setPointerCapture which jsdom
    // does not implement. Stub no-ops so opening the menu doesn't throw.
    const proto = Element.prototype as unknown as {
      hasPointerCapture?: () => boolean;
      setPointerCapture?: () => void;
      releasePointerCapture?: () => void;
    };
    if (!proto.hasPointerCapture) proto.hasPointerCapture = () => false;
    if (!proto.setPointerCapture) proto.setPointerCapture = () => {};
    if (!proto.releasePointerCapture) proto.releasePointerCapture = () => {};
  });
  afterEach(() => cleanup());

  function renderRow(session: Session) {
    const group: Group = {
      id: session.groupId,
      name: 'g',
      collapsed: false,
      kind: 'normal',
    };
    return render(
      <ToastProvider>
        <DndContext>
          <SortableContext items={[session.id]} id={session.groupId}>
            <ul>
              <SessionRow
                session={session}
                active={false}
                selected={false}
                onSelectSession={() => {}}
                normalGroups={[group]}
              />
            </ul>
          </SortableContext>
        </DndContext>
      </ToastProvider>
    );
  }

  function openMenu(getByRole: (role: string) => HTMLElement) {
    const li = getByRole('option');
    fireEvent.contextMenu(li);
  }

  // Returns the in-order list of menu children, distinguishing items
  // (role=menuitem | menuitemcheckbox | menuitemradio) and separators
  // (role=separator). The submenu trigger has role=menuitem in Radix.
  function readMenuStructure(): Array<{ kind: 'item' | 'separator'; text: string }> {
    const content = document.querySelector('[role="menu"]');
    if (!content) throw new Error('menu not open');
    const out: Array<{ kind: 'item' | 'separator'; text: string }> = [];
    for (const child of Array.from(content.children)) {
      const role = child.getAttribute('role');
      if (role === 'separator') {
        out.push({ kind: 'separator', text: '' });
      } else if (role && role.startsWith('menuitem')) {
        out.push({ kind: 'item', text: (child.textContent ?? '').trim() });
      }
    }
    return out;
  }

  const baseSession: Session = {
    id: 's1',
    name: 'My session',
    state: 'idle',
    cwd: '/tmp',
    model: 'claude-sonnet-4',
    groupId: 'g1',
    agentType: 'claude-code',
  };

  it('renders three sections separated by two dividers (not archived)', () => {
    const { getByRole } = renderRow(baseSession);
    openMenu(getByRole);
    const structure = readMenuStructure();
    expect(structure).toEqual([
      { kind: 'item', text: 'Rename' },
      { kind: 'item', text: 'Copy session' },
      { kind: 'separator', text: '' },
      { kind: 'item', text: 'Move to group' },
      { kind: 'item', text: 'Archive' },
      { kind: 'separator', text: '' },
      { kind: 'item', text: 'Reload session' },
      { kind: 'item', text: 'Delete' },
    ]);
  });

  it('renders Unarchive in section 2 for archived sessions (no structural drift)', () => {
    const archived: Session = { ...baseSession, archivedAt: 123456 };
    const { getByRole } = renderRow(archived);
    openMenu(getByRole);
    const structure = readMenuStructure();
    expect(structure).toEqual([
      { kind: 'item', text: 'Rename' },
      { kind: 'item', text: 'Copy session' },
      { kind: 'separator', text: '' },
      { kind: 'item', text: 'Move to group' },
      { kind: 'item', text: 'Unarchive' },
      { kind: 'separator', text: '' },
      { kind: 'item', text: 'Reload session' },
      { kind: 'item', text: 'Delete' },
    ]);
  });
});
