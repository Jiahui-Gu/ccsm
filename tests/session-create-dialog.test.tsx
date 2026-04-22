import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { TooltipProvider } from '../src/components/ui/Tooltip';
import { SessionCreateDialog } from '../src/components/SessionCreateDialog';
import { useStore } from '../src/stores/store';

function flush(ms = 30) {
  return act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

const initial = useStore.getState();

beforeEach(() => {
  useStore.setState(
    {
      ...initial,
      sessions: [],
      groups: [{ id: 'g-default', name: 'Sessions', collapsed: false, kind: 'normal' }],
      recentProjects: [],
      activeId: '',
      focusedGroupId: null,
      messagesBySession: {},
      startedSessions: {},
      runningSessions: {},
      focusInputNonce: 0
    },
    true
  );
});

afterEach(() => {
  (window as unknown as { agentory?: unknown }).agentory = undefined;
});

function renderDialog(props?: Partial<React.ComponentProps<typeof SessionCreateDialog>>) {
  return render(
    <TooltipProvider delayDuration={0} skipDelayDuration={0}>
      <SessionCreateDialog
        open
        onOpenChange={() => {}}
        initialCwd={null}
        {...props}
      />
    </TooltipProvider>
  );
}

describe('<SessionCreateDialog />', () => {
  it('renders all fields and creates a session on submit', async () => {
    (window as unknown as { agentory: unknown }).agentory = {};
    const onOpenChange = vi.fn();
    renderDialog({ onOpenChange, initialCwd: '/tmp/repo' });
    await flush();

    expect(screen.getByText('New session')).toBeInTheDocument();
    expect(screen.getByTestId('session-create-cwd')).toHaveValue('/tmp/repo');

    const nameInput = screen.getByTestId('session-create-name') as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: 'My session' } });

    fireEvent.click(screen.getByRole('button', { name: /create session/i }));
    expect(useStore.getState().sessions).toHaveLength(1);
    expect(useStore.getState().sessions[0].name).toBe('My session');
    expect(useStore.getState().sessions[0].cwd).toBe('/tmp/repo');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('blocks submit when cwd is empty', async () => {
    (window as unknown as { agentory: unknown }).agentory = {};
    renderDialog({ initialCwd: '' });
    await flush();
    const button = screen.getByRole('button', { name: /create session/i });
    expect(button).toBeDisabled();
  });

  it('seeds cwd from window.agentory.recentCwds when no initialCwd and no in-app history', async () => {
    const recentCwds = vi.fn().mockResolvedValue(['/cli/project-a', '/cli/project-b', '/cli/project-c']);
    (window as unknown as { agentory: unknown }).agentory = {
      recentCwds,
    };
    renderDialog({ initialCwd: null });
    await flush();

    const cwdInput = screen.getByTestId('session-create-cwd') as HTMLInputElement;
    expect(recentCwds).toHaveBeenCalledTimes(1);
    expect(cwdInput.value).toBe('/cli/project-a');

    // The remaining entries are surfaced as datalist suggestions on the
    // input so the user can pick from a dropdown without typing.
    expect(cwdInput.getAttribute('list')).toBe('session-create-cwd-suggestions');
    const datalist = document.getElementById(
      'session-create-cwd-suggestions'
    ) as HTMLDataListElement | null;
    expect(datalist).not.toBeNull();
    const options = Array.from(datalist!.querySelectorAll('option')).map((o) =>
      (o as HTMLOptionElement).value
    );
    expect(options).toEqual(['/cli/project-a', '/cli/project-b', '/cli/project-c']);
  });

  it('does not stomp an explicit initialCwd with a recentCwds value', async () => {
    const recentCwds = vi.fn().mockResolvedValue(['/cli/other']);
    (window as unknown as { agentory: unknown }).agentory = {
      recentCwds,
    };
    renderDialog({ initialCwd: '/explicit/seed' });
    await flush();

    const cwdInput = screen.getByTestId('session-create-cwd') as HTMLInputElement;
    expect(cwdInput.value).toBe('/explicit/seed');
  });

  it('prefers in-app recentProjects over CLI-derived recentCwds', async () => {
    useStore.setState({
      recentProjects: [{ id: 'rp-1', name: 'most-recent', path: '/in-app/most-recent' }],
    } as Partial<ReturnType<typeof useStore.getState>>);

    const recentCwds = vi.fn().mockResolvedValue(['/cli/different']);
    (window as unknown as { agentory: unknown }).agentory = {
      recentCwds,
    };
    renderDialog({ initialCwd: null });
    await flush();

    const cwdInput = screen.getByTestId('session-create-cwd') as HTMLInputElement;
    expect(cwdInput.value).toBe('/in-app/most-recent');
  });
});
