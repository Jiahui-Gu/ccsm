import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AssistantBlock } from '../src/components/chat/blocks/AssistantBlock';

describe('<AssistantBlock />', () => {
  it('renders text without a skill badge by default', () => {
    render(<AssistantBlock text="Hello world" />);
    expect(screen.getByText('Hello world')).toBeInTheDocument();
    expect(screen.queryByTestId('assistant-via-skill-badge')).toBeNull();
  });

  it('renders the via-skill badge with the skill name when viaSkill is set', () => {
    render(
      <AssistantBlock
        text="Skill-driven reply."
        viaSkill={{ name: 'using-superpowers', path: '~/.claude/skills/using-superpowers/SKILL.md' }}
      />
    );
    const badge = screen.getByTestId('assistant-via-skill-badge');
    expect(badge).toBeInTheDocument();
    expect(badge.textContent).toBe('via skill: using-superpowers');
    // Tooltip Trigger marks the trigger element with data-state; presence of
    // the badge inside the tooltip trigger asChild slot is enough — the
    // floating Content portal only mounts on hover, but the tooltip provider
    // still wraps the trigger so verify it's wired by checking the badge
    // sits where the Tooltip placed it (no crash + correct text).
    expect(screen.getByText('Skill-driven reply.')).toBeInTheDocument();
  });

  it('renders the badge for plugin-namespaced skills (e.g. pua:p7) verbatim', () => {
    render(
      <AssistantBlock
        text="Plugin skill output."
        viaSkill={{ name: 'pua:p7', path: '~/.claude/plugins/pua/skills/p7/SKILL.md' }}
      />
    );
    const badge = screen.getByTestId('assistant-via-skill-badge');
    expect(badge.textContent).toBe('via skill: pua:p7');
  });
});
