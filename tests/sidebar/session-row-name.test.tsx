import React from 'react';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { DndContext } from '@dnd-kit/core';
import { SortableContext } from '@dnd-kit/sortable';
import { SessionRow } from '../../src/components/sidebar/SessionRow';
import { useStore } from '../../src/stores/store';
import { ToastProvider } from '../../src/components/ui/Toast';
import type { Group, Session } from '../../src/types';

// Task #788: regression guard — SessionRow's visible label must come from
// `session.name` (the user-visible name maintained by the store), NOT the
// session id and NOT a derived alias. A regression where the row fell back
// to id rendering would silently uglify the sidebar without breaking other
// assertions; this pins the label to the store-supplied name.
describe('<SessionRow /> renders store.name, not id (#788)', () => {
  beforeEach(() => {
    useStore.setState({ flashStates: {}, disconnectedSessions: {} });
    if (!(Element.prototype as { scrollIntoView?: unknown }).scrollIntoView) {
      (Element.prototype as { scrollIntoView: () => void }).scrollIntoView = () => {};
    }
  });
  afterEach(() => cleanup());

  it('shows session.name verbatim and does not fall back to session.id', () => {
    const session: Session = {
      id: 'sess-uuid-deadbeef-0001',
      name: 'My Custom Name',
      state: 'idle',
      cwd: '/tmp',
      model: 'claude-sonnet-4',
      groupId: 'g1',
      agentType: 'claude-code',
    };
    const group: Group = { id: 'g1', name: 'g', collapsed: false, kind: 'normal' };

    const { container, getByText } = render(
      <ToastProvider>
        <DndContext>
          <SortableContext items={[session.id]} id="g1">
            <ul>
              <SessionRow
                session={session}
                active={false}
                selected={false}
                onSelect={() => {}}
                normalGroups={[group]}
              />
            </ul>
          </SortableContext>
        </DndContext>
      </ToastProvider>
    );

    expect(getByText('My Custom Name')).toBeInTheDocument();
    // The id must never appear as visible text content (it remains valid
    // as the data-session-id attribute, which we explicitly ignore here).
    const li = container.querySelector('[data-session-id]');
    expect(li).toBeTruthy();
    expect(li!.textContent ?? '').not.toContain(session.id);
  });
});
