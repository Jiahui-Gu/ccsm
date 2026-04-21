import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SlashCommandPicker } from '../src/components/SlashCommandPicker';

describe('<SlashCommandPicker />', () => {
  it('renders nothing when closed', () => {
    const { container } = render(
      <SlashCommandPicker
        open={false}
        query=""
        activeIndex={0}
        onActiveIndexChange={() => {}}
        onSelect={() => {}}
      />
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders filtered commands by query', () => {
    render(
      <SlashCommandPicker
        open
        query="cl"
        activeIndex={0}
        onActiveIndexChange={() => {}}
        onSelect={() => {}}
      />
    );
    expect(screen.getByText('/clear')).toBeInTheDocument();
    // 'cl' must not match /compact
    expect(screen.queryByText('/compact')).not.toBeInTheDocument();
  });

  it('marks the active row as aria-selected', () => {
    render(
      <SlashCommandPicker
        open
        query=""
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
        query="help"
        activeIndex={0}
        onActiveIndexChange={() => {}}
        onSelect={onSelect}
      />
    );
    fireEvent.mouseDown(screen.getByText('/help'));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0].name).toBe('help');
  });
});
