import React from 'react';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { DndContext } from '@dnd-kit/core';
import { SortableContext } from '@dnd-kit/sortable';
import { SessionRow } from '../../src/components/sidebar/SessionRow';
import { useStore } from '../../src/stores/store';
import { ToastProvider } from '../../src/components/ui/Toast';
import type { Group, Session } from '../../src/types';

// Task #784: regression guard — only the active SessionRow should render the
// "open in chat" selection dot (the small bg-accent pip on the right rail).
// A prior regression leaked the dot to every row when the `active` gate was
// dropped. We render three rows with one of them active and assert the dot
// count is exactly one and lives on the active row.
describe('<SessionRow /> selection dot — only on active row (#784)', () => {
  beforeEach(() => {
    useStore.setState({ flashStates: {}, disconnectedSessions: {} });
    if (!(Element.prototype as { scrollIntoView?: unknown }).scrollIntoView) {
      (Element.prototype as { scrollIntoView: () => void }).scrollIntoView = () => {};
    }
  });
  afterEach(() => cleanup());

  function makeSession(id: string, name: string): Session {
    return {
      id,
      name,
      state: 'idle',
      cwd: '/tmp',
      model: 'claude-sonnet-4',
      groupId: 'g1',
      agentType: 'claude-code',
    };
  }

  it('renders the active selection dot on exactly the active row', () => {
    const sessions = [
      makeSession('s1', 'Session 1'),
      makeSession('s2', 'Session 2'),
      makeSession('s3', 'Session 3'),
    ];
    const activeId = 's2';
    const group: Group = { id: 'g1', name: 'g', collapsed: false, kind: 'normal' };

    const { container } = render(
      <ToastProvider>
        <DndContext>
          <SortableContext items={sessions.map((s) => s.id)} id="g1">
            <ul>
              {sessions.map((s) => (
                <SessionRow
                  key={s.id}
                  session={s}
                  active={s.id === activeId}
                  selected={s.id === activeId}
                  onSelect={() => {}}
                  normalGroups={[group]}
                />
              ))}
            </ul>
          </SortableContext>
        </DndContext>
      </ToastProvider>
    );

    // The active "open in chat" dot is the inner span carrying
    // aria-label="Open in chat" + bg-accent. Anchor on aria-label so the
    // assertion survives class-name churn.
    const dots = container.querySelectorAll('[aria-label="Open in chat"]');
    expect(dots.length).toBe(1);

    const activeRow = container.querySelector('[data-session-id="s2"]');
    expect(activeRow).toBeTruthy();
    expect(activeRow!.querySelector('[aria-label="Open in chat"]')).toBeTruthy();

    // Sanity: the other rows have no dot.
    for (const id of ['s1', 's3']) {
      const row = container.querySelector(`[data-session-id="${id}"]`);
      expect(row).toBeTruthy();
      expect(row!.querySelector('[aria-label="Open in chat"]')).toBeNull();
    }
  });
});
