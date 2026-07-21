import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { SessionNavigatorModel } from '../../../src/shared/sessionNavigator';
import { SessionNavigator } from '../../../src/shared/sessionNavigator';

function buildModel(): SessionNavigatorModel {
  return {
    groups: [
      {
        id: 'g1',
        name: 'First',
        order: 1,
        collapsed: false,
        sessions: [
          { id: 's1', name: 'One', cwd: '/one', state: 'active', order: 1 },
          { id: 's0', name: 'Zero', cwd: '/zero', state: 'idle', order: 0 },
        ],
      },
      {
        id: 'g2',
        name: 'Second',
        order: 0,
        collapsed: false,
        sessions: [{ id: 's2', name: 'Two', cwd: '/two', state: 'waiting', order: 0 }],
      },
    ],
    activeSessionId: 's1',
  };
}

describe('SessionNavigator', () => {
  it('renders ordered groups, names, cwd text, selection, and disclosure state without mutating the model', () => {
    const model = buildModel();
    const originalGroupOrder = model.groups.map((group) => group.id);
    const originalSessionOrder = model.groups[0]?.sessions.map((session) => session.id);

    render(
      <SessionNavigator
        model={model}
        collapsedGroups={new Set(['g2'])}
        onSelectSession={() => {}}
        onToggleGroup={() => {}}
      />,
    );

    const buttons = screen.getAllByRole('button');
    expect(buttons[0]).toHaveTextContent('Second');
    expect(buttons[0]).toHaveAttribute('aria-expanded', 'false');
    expect(buttons[0]).toHaveStyle({ minHeight: '36px' });
    expect(buttons[1]).toHaveTextContent('First');
    expect(screen.getByRole('listbox', { name: 'First' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /One.*\/one/i })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('option', { name: /One.*\/one/i })).toHaveStyle({ minHeight: '36px' });
    expect(screen.getByTitle('One')).toBeInTheDocument();
    expect(screen.getByTitle('/one')).toBeInTheDocument();
    expect(model.groups.map((group) => group.id)).toEqual(originalGroupOrder);
    expect(model.groups[0]?.sessions.map((session) => session.id)).toEqual(originalSessionOrder);
  });

  it('passes ids through stable callbacks and honors touch density', async () => {
    const user = userEvent.setup();
    const onSelectSession = vi.fn();
    const onToggleGroup = vi.fn();

    render(
      <SessionNavigator
        model={buildModel()}
        density="touch"
        collapsedGroups={new Set()}
        onSelectSession={onSelectSession}
        onToggleGroup={onToggleGroup}
      />,
    );

    const secondGroup = screen.getByRole('button', { name: /Second/i });
    const secondList = screen.getByRole('listbox', { name: 'Second' });
    const secondOption = within(secondList).getByRole('option', { name: /Two.*\/two/i });

    expect(secondGroup).toHaveStyle({ minHeight: '44px' });
    expect(secondOption).toHaveStyle({ minHeight: '44px' });

    await user.click(secondGroup);
    await user.click(secondOption);

    expect(onToggleGroup).toHaveBeenCalledWith('g2');
    expect(onSelectSession).toHaveBeenCalledWith('s2');
  });
});
