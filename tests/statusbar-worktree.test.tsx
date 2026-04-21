import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TooltipProvider } from '../src/components/ui/Tooltip';
import { StatusBar } from '../src/components/StatusBar';

function Wrap(props: React.ComponentProps<typeof StatusBar>) {
  return (
    <TooltipProvider delayDuration={0} skipDelayDuration={0}>
      <StatusBar {...props} />
    </TooltipProvider>
  );
}

describe('<StatusBar /> worktree pill', () => {
  it('does not render the worktree pill when worktreeName is missing', () => {
    render(
      <Wrap
        cwd="/tmp/repo"
        model="claude-opus-4"
        permission="default"
        onChangeCwd={() => {}}
        onChangeModel={() => {}}
        onChangePermission={() => {}}
      />
    );
    expect(screen.queryByTestId('statusbar-worktree-pill')).not.toBeInTheDocument();
  });

  it('renders the worktree pill with the branch name when present', () => {
    render(
      <Wrap
        cwd="/tmp/repo"
        model="claude-opus-4"
        permission="default"
        worktreeName="claude/brave-turing-a1b2c3"
        onChangeCwd={() => {}}
        onChangeModel={() => {}}
        onChangePermission={() => {}}
      />
    );
    const pill = screen.getByTestId('statusbar-worktree-pill');
    expect(pill).toBeInTheDocument();
    expect(pill).toHaveTextContent('claude/brave-turing-a1b2c3');
    expect(pill.getAttribute('title')).toMatch(/Worktree branch/);
  });
});
