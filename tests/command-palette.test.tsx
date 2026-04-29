// Migrated from harness-ui cases `palette-empty` + `palette-nav`
// (Task #740 Batch 3.1). Both probes exercised the in-renderer
// CommandPalette dialog — empty state, no-matches block, kbd hint footer,
// and ↓/↑/Enter keyboard navigation. None of this needs Electron; the
// palette is a controlled Radix Dialog whose results derive from the
// store. RTL covers the contract without booting Chromium + IPC.
//
// Reverse-verify (manual):
//   - Remove the `!hasQuery` empty-hint <li> in CommandPalette.tsx →
//     `surfaces "Type to search…" hint when empty` fails.
//   - Drop the `aria-selected` flag flip in onKeyDown ArrowDown branch →
//     `ArrowDown moves the active row` fails.
//
// Tests cover both palette-empty (CP3 no-matches block, CP4 kbd hint
// footer, empty-on-open contract) and palette-nav (Arrow keys + Enter
// selection).
import React, { useState } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within, act } from '@testing-library/react';
import { CommandPalette } from '../src/components/CommandPalette';
import { useStore } from '../src/stores/store';

// jsdom doesn't ship matchMedia. CommandPalette subscribes to
// `(prefers-color-scheme: dark)` for the "Switch theme → X" label.
function stubMatchMedia(): void {
  if (typeof window === 'undefined' || window.matchMedia) return;
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

const initial = useStore.getState();

function seedSessions(sessions: Array<{ id: string; name: string; cwd?: string }>) {
  useStore.setState(
    {
      ...initial,
      groups: [{ id: 'g-default', name: 'Sessions', collapsed: false, kind: 'normal' }],
      sessions: sessions.map((s) => ({
        id: s.id,
        name: s.name,
        state: 'idle',
        cwd: s.cwd ?? '~',
        model: 'claude-opus-4',
        groupId: 'g-default',
        agentType: 'claude-code',
      })),
      activeId: sessions[0]?.id ?? '',
      hydrated: true,
    } as ReturnType<typeof useStore.getState>,
    true
  );
}

function Harness({ initialOpen = true, ...handlers }: {
  initialOpen?: boolean;
  onSelectSession?: (id: string) => void;
}) {
  const [open, setOpen] = useState(initialOpen);
  return (
    <CommandPalette open={open} onOpenChange={setOpen} {...handlers} />
  );
}

beforeEach(() => {
  cleanup();
  stubMatchMedia();
});

describe('<CommandPalette /> empty / no-matches / kbd hints', () => {
  it('renders zero option rows on open before user types (CP empty contract)', async () => {
    seedSessions([{ id: 's-alpha', name: 'Alpha session', cwd: '~/alpha' }]);
    render(<Harness initialOpen />);
    // listbox is the <ul>; its option children should be exactly zero
    // until the user types — instead we render a placeholder hint <li>.
    const dialog = screen.getByRole('dialog');
    const options = within(dialog).queryAllByRole('option');
    expect(options.length).toBe(0);
    // Empty hint visible.
    expect(within(dialog).getByText(/Type to search/i)).toBeInTheDocument();
  });

  it('typing surfaces matching session row (CP search)', async () => {
    seedSessions([{ id: 's-alpha', name: 'Alpha session', cwd: '~/alpha' }]);
    render(<Harness initialOpen />);
    const dialog = screen.getByRole('dialog');
    const input = within(dialog).getByPlaceholderText(/Search/i);
    fireEvent.change(input, { target: { value: 'alpha' } });
    const options = within(dialog).getAllByRole('option');
    expect(options.length).toBeGreaterThanOrEqual(1);
    expect(within(dialog).getByText(/Alpha session/)).toBeInTheDocument();
  });

  it('shows the no-matches block with SearchX icon + echoed query (#258 CP3)', async () => {
    seedSessions([{ id: 's-x', name: 'somewhere' }]);
    render(<Harness initialOpen />);
    const dialog = screen.getByRole('dialog');
    const input = within(dialog).getByPlaceholderText(/Search/i);
    fireEvent.change(input, { target: { value: 'zzz-no-such-thing-zzz' } });
    const noMatch = within(dialog).getByTestId('cmd-palette-no-matches');
    expect(noMatch).toBeInTheDocument();
    expect(noMatch.textContent || '').toMatch(/No matches/i);
    expect(noMatch.textContent || '').toMatch(/zzz-no-such-thing-zzz/);
    // SearchX is a lucide svg; assert at least one svg present.
    expect(noMatch.querySelector('svg')).not.toBeNull();
  });

  it('renders the kbd hint footer with Navigate / Select / Close (#258 CP4)', () => {
    seedSessions([{ id: 's-y', name: 'one' }]);
    render(<Harness initialOpen />);
    const dialog = screen.getByRole('dialog');
    const hints = within(dialog).getByTestId('cmd-palette-kbd-hints');
    const text = (hints.textContent || '').replace(/\s+/g, ' ').trim();
    expect(text).toMatch(/Navigate/);
    expect(text).toMatch(/Select/);
    expect(text).toMatch(/Close/);
  });
});

describe('<CommandPalette /> keyboard navigation', () => {
  it('ArrowDown / ArrowUp move active row; Enter triggers onSelectSession', async () => {
    seedSessions([
      { id: 's-nav-A', name: 'session alpha', cwd: '~/a' },
      { id: 's-nav-B', name: 'session bravo', cwd: '~/b' },
    ]);
    const onSelect = vi.fn();
    render(<Harness initialOpen onSelectSession={onSelect} />);
    const dialog = screen.getByRole('dialog');
    const input = within(dialog).getByPlaceholderText(/Search/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'session' } });

    // After typing, expect ≥2 option rows; first is active.
    let options = within(dialog).getAllByRole('option');
    expect(options.length).toBeGreaterThanOrEqual(2);
    expect(options[0].getAttribute('aria-selected')).toBe('true');

    // ArrowDown → index 1 active.
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    options = within(dialog).getAllByRole('option');
    expect(options[1].getAttribute('aria-selected')).toBe('true');
    expect(options[0].getAttribute('aria-selected')).toBe('false');

    // ArrowUp → back to index 0.
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    options = within(dialog).getAllByRole('option');
    expect(options[0].getAttribute('aria-selected')).toBe('true');

    // Walk to the "session bravo" row by finding its index after typing,
    // then pressing ArrowDown the right number of times before Enter.
    const labels = options.map((el) => el.textContent || '');
    const bravoIdx = labels.findIndex((l) => l.includes('bravo'));
    expect(bravoIdx).toBeGreaterThan(-1);
    for (let i = 0; i < bravoIdx; i++) {
      fireEvent.keyDown(input, { key: 'ArrowDown' });
    }
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith('s-nav-B');
  });
});
