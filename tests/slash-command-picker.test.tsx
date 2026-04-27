import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SlashCommandPicker } from '../src/components/SlashCommandPicker';
import { BUILT_IN_COMMANDS, type SlashCommand } from '../src/slash-commands/registry';

const userCmd: SlashCommand = {
  name: 'run-worker',
  description: 'Run the worker against a PR',
  source: 'user',
  passThrough: true,
};
const pluginCmd: SlashCommand = {
  name: 'superpowers:brainstorm',
  description: 'Brainstorm a feature',
  source: 'plugin',
  pluginId: 'superpowers',
  passThrough: true,
};

const ALL = [...BUILT_IN_COMMANDS, userCmd, pluginCmd];

describe('<SlashCommandPicker />', () => {
  it('renders nothing when closed', () => {
    const { container } = render(
      <SlashCommandPicker
        open={false}
        query=""
        commands={ALL}
        activeIndex={0}
        onActiveIndexChange={() => {}}
        onSelect={() => {}}
      />
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders filtered built-in by query', () => {
    render(
      <SlashCommandPicker
        open
        query="cl"
        commands={ALL}
        activeIndex={0}
        onActiveIndexChange={() => {}}
        onSelect={() => {}}
      />
    );
    expect(screen.getByText('/clear')).toBeInTheDocument();
    expect(screen.queryByText('/compact')).not.toBeInTheDocument();
  });

  it('renders source-grouped headings when open with no query', () => {
    render(
      <SlashCommandPicker
        open
        query=""
        commands={ALL}
        activeIndex={0}
        onActiveIndexChange={() => {}}
        onSelect={() => {}}
      />
    );
    // Headings come from i18n; tests/setup.ts initialises en.
    expect(screen.getByText(/Built-in/i)).toBeInTheDocument();
    expect(screen.getByText(/User commands/i)).toBeInTheDocument();
    expect(screen.getByText(/Plugin commands/i)).toBeInTheDocument();
    expect(screen.getByText('/superpowers:brainstorm')).toBeInTheDocument();
  });

  it('marks the active row as aria-selected (flat index across groups)', () => {
    render(
      <SlashCommandPicker
        open
        query=""
        commands={ALL}
        activeIndex={2}
        onActiveIndexChange={() => {}}
        onSelect={() => {}}
      />
    );
    const options = screen.getAllByRole('option');
    expect(options[2].getAttribute('aria-selected')).toBe('true');
    expect(options[0].getAttribute('aria-selected')).toBe('false');
  });

  it('shows the empty state when no commands match', () => {
    render(
      <SlashCommandPicker
        open
        query="xxxxxnope"
        commands={ALL}
        activeIndex={0}
        onActiveIndexChange={() => {}}
        onSelect={() => {}}
      />
    );
    expect(screen.getByText(/No matching commands/i)).toBeInTheDocument();
  });

  it('fires onSelect when a row is clicked', () => {
    const onSelect = vi.fn();
    render(
      <SlashCommandPicker
        open
        query="clear"
        commands={ALL}
        activeIndex={0}
        onActiveIndexChange={() => {}}
        onSelect={onSelect}
      />
    );
    fireEvent.mouseDown(screen.getByText('/clear'));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0].name).toBe('clear');
  });

  // The 6-tier effort+thinking chip moved to the StatusBar; `/think` and
  // its trailing Switch facsimile are gone. We pin that absence here so a
  // future regression that adds another inline-toggle slash row doesn't
  // sneak past review.
  it('does not render a slash-think-switch trailing widget anywhere', async () => {
    const { hydrateStore } = await import('../src/stores/store');
    await hydrateStore();
    render(
      <SlashCommandPicker
        open
        query=""
        commands={ALL}
        activeIndex={0}
        onActiveIndexChange={() => {}}
        onSelect={() => {}}
      />
    );
    expect(screen.queryByTestId('slash-think-switch')).toBeNull();
    // /clear and /config still render as built-ins.
    expect(screen.getByText('/clear')).toBeInTheDocument();
    expect(screen.getByText('/config')).toBeInTheDocument();
    // /think is gone from the registry entirely.
    expect(screen.queryByText('/think')).toBeNull();
  });
});
