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
    (window as unknown as { agentory: unknown }).agentory = {
      worktree: {
        listBranches: vi
          .fn()
          .mockResolvedValue({ ok: true, isRepo: false })
      }
    };
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
    expect(useStore.getState().sessions[0].useWorktree).toBeUndefined();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('disables the worktree checkbox when cwd is not a git repo', async () => {
    (window as unknown as { agentory: unknown }).agentory = {
      worktree: {
        listBranches: vi.fn().mockResolvedValue({ ok: true, isRepo: false })
      }
    };
    renderDialog({ initialCwd: '/tmp/not-repo' });
    await flush();

    const checkbox = screen.getByTestId('session-create-use-worktree') as HTMLInputElement;
    expect(checkbox.disabled).toBe(true);
    expect(screen.getByText(/not a git repository/i)).toBeInTheDocument();
  });

  it('disables the worktree checkbox when worktree IPC is unavailable', async () => {
    // No window.agentory.worktree at all — simulates pre-data-layer state.
    (window as unknown as { agentory: unknown }).agentory = {};
    renderDialog({ initialCwd: '/tmp/anywhere' });
    await flush();

    const checkbox = screen.getByTestId('session-create-use-worktree') as HTMLInputElement;
    expect(checkbox.disabled).toBe(true);
    expect(screen.getByText(/worktree support not loaded/i)).toBeInTheDocument();
  });

  it('enables the worktree checkbox and lets the user pick a base branch when cwd is a repo', async () => {
    (window as unknown as { agentory: unknown }).agentory = {
      worktree: {
        listBranches: vi.fn().mockResolvedValue({
          ok: true,
          isRepo: true,
          repoRoot: '/tmp/repo',
          currentBranch: 'main',
          branches: [
            { name: 'main', isCurrent: true, isRemote: false },
            { name: 'feature/x', isCurrent: false, isRemote: false }
          ]
        })
      }
    };
    renderDialog({ initialCwd: '/tmp/repo' });
    await flush(80);

    const checkbox = screen.getByTestId('session-create-use-worktree') as HTMLInputElement;
    expect(checkbox.disabled).toBe(false);
    fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(true);

    const branchSelect = screen.getByTestId('session-create-branch') as HTMLSelectElement;
    expect(branchSelect.value).toBe('main');
    fireEvent.change(branchSelect, { target: { value: 'feature/x' } });

    fireEvent.click(screen.getByRole('button', { name: /create session/i }));
    const created = useStore.getState().sessions[0];
    expect(created.useWorktree).toBe(true);
    expect(created.sourceBranch).toBe('feature/x');
  });

  it('blocks submit when cwd is empty', async () => {
    (window as unknown as { agentory: unknown }).agentory = {};
    renderDialog({ initialCwd: '' });
    await flush();
    const button = screen.getByRole('button', { name: /create session/i });
    expect(button).toBeDisabled();
  });
});
