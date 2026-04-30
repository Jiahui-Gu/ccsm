import React from 'react';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { DndContext } from '@dnd-kit/core';
import { SortableContext } from '@dnd-kit/sortable';
import { SessionRow } from '../../src/components/sidebar/SessionRow';
import { useStore } from '../../src/stores/store';
import { ToastProvider } from '../../src/components/ui/Toast';
import type { Group, Session } from '../../src/types';

// Snapshot smoke test for SessionRow extraction (Task #723 Phase A).
// Confirms the row renders as an aria-listbox option with expected text and
// selection state, and that the crashed indicator surfaces when the
// disconnectedSessions store entry is `crashed`.
describe('<SessionRow /> (extracted)', () => {
  beforeEach(() => {
    useStore.setState({ flashStates: {}, disconnectedSessions: {} });
    // jsdom doesn't implement scrollIntoView; SessionRow's selected-row
    // visibility effect calls it. Stub on the prototype for the duration
    // of the test file.
    if (!(Element.prototype as { scrollIntoView?: unknown }).scrollIntoView) {
      (Element.prototype as { scrollIntoView: () => void }).scrollIntoView = () => {};
    }
  });
  afterEach(() => cleanup());

  function renderRow(session: Session, opts: { selected?: boolean; active?: boolean } = {}) {
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
                active={opts.active ?? false}
                selected={opts.selected ?? false}
                onSelect={() => {}}
                normalGroups={[group]}
              />
            </ul>
          </SortableContext>
        </DndContext>
      </ToastProvider>
    );
  }

  it('renders an aria-listbox option with the session name', () => {
    const session: Session = {
      id: 's1',
      name: 'My session',
      state: 'idle',
      cwd: '/tmp',
      model: 'claude-sonnet-4',
      groupId: 'g1',
      agentType: 'claude-code',
    };
    const { getByRole, getByText } = renderRow(session, { selected: true, active: true });
    const li = getByRole('option');
    expect(li.getAttribute('aria-selected')).toBe('true');
    expect(li.getAttribute('data-session-id')).toBe('s1');
    expect(getByText('My session')).toBeInTheDocument();
  });

  it('shows the crashed indicator when disconnectedSessions[id].kind === "crashed"', () => {
    useStore.setState({
      disconnectedSessions: { s1: { kind: 'crashed', detail: 'exit 1' } as never },
    });
    const session: Session = {
      id: 's1',
      name: 'Boom',
      state: 'idle',
      cwd: '/tmp',
      model: 'claude-sonnet-4',
      groupId: 'g1',
      agentType: 'claude-code',
    };
    const { container } = renderRow(session);
    expect(container.querySelector('[data-session-crashed]')).toBeTruthy();
  });

  // audit #876 cluster 2.3: SessionRow forwards `crashed` to AgentIcon so
  // the icon's halo is suppressed when the row also paints the red dot.
  // We assert the resolved priority via AgentIcon's `data-attention`.
  describe('attention priority (audit #876 cluster 2.3)', () => {
    it('crashed + state=waiting → AgentIcon data-attention="crashed"', () => {
      useStore.setState({
        disconnectedSessions: { s1: { kind: 'crashed', detail: 'exit 1' } as never },
      });
      const session: Session = {
        id: 's1',
        name: 'Boom',
        state: 'waiting',
        cwd: '/tmp',
        model: 'claude-sonnet-4',
        groupId: 'g1',
        agentType: 'claude-code',
      };
      const { container } = renderRow(session);
      const icon = container.querySelector('[data-attention]')!;
      expect(icon.getAttribute('data-attention')).toBe('crashed');
      // Red dot is still rendered — crashed wins, halo is gone but the
      // crash signal itself remains.
      expect(container.querySelector('[data-session-crashed]')).toBeTruthy();
    });

    it('crashed + flashing (via flashStates) → AgentIcon data-attention="crashed"', () => {
      useStore.setState({
        flashStates: { s1: true },
        disconnectedSessions: { s1: { kind: 'crashed', detail: 'exit 1' } as never },
      });
      const session: Session = {
        id: 's1',
        name: 'Boom',
        state: 'idle',
        cwd: '/tmp',
        model: 'claude-sonnet-4',
        groupId: 'g1',
        agentType: 'claude-code',
      };
      const { container } = renderRow(session);
      expect(
        container.querySelector('[data-attention]')!.getAttribute('data-attention')
      ).toBe('crashed');
    });

    it('not crashed + state=waiting → data-attention="waiting-or-flashing"', () => {
      const session: Session = {
        id: 's1',
        name: 'Live',
        state: 'waiting',
        cwd: '/tmp',
        model: 'claude-sonnet-4',
        groupId: 'g1',
        agentType: 'claude-code',
      };
      const { container } = renderRow(session);
      expect(
        container.querySelector('[data-attention]')!.getAttribute('data-attention')
      ).toBe('waiting-or-flashing');
    });

    it('not crashed + flashStates[id]=true → data-attention="waiting-or-flashing"', () => {
      useStore.setState({ flashStates: { s1: true } });
      const session: Session = {
        id: 's1',
        name: 'Pulse',
        state: 'idle',
        cwd: '/tmp',
        model: 'claude-sonnet-4',
        groupId: 'g1',
        agentType: 'claude-code',
      };
      const { container } = renderRow(session);
      expect(
        container.querySelector('[data-attention]')!.getAttribute('data-attention')
      ).toBe('waiting-or-flashing');
    });

    it('idle, not crashed, not flashing → data-attention="idle"', () => {
      const session: Session = {
        id: 's1',
        name: 'Quiet',
        state: 'idle',
        cwd: '/tmp',
        model: 'claude-sonnet-4',
        groupId: 'g1',
        agentType: 'claude-code',
      };
      const { container } = renderRow(session);
      expect(
        container.querySelector('[data-attention]')!.getAttribute('data-attention')
      ).toBe('idle');
    });
  });
});
