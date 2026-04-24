import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { CwdPopover } from '../src/components/CwdPopover';
import { useStore } from '../src/stores/store';

const SAMPLE = [
  '/home/alice/projects/agentory',
  '/home/alice/projects/agentory-next',
  '/home/alice/work/cli-tools',
  '/tmp/scratch-pad'
];

function renderPopover(
  overrides: Partial<React.ComponentProps<typeof CwdPopover>> = {}
) {
  const onPick = vi.fn();
  const onBrowse = vi.fn();
  const loadRecent = vi.fn(async () => SAMPLE);
  const utils = render(
    <CwdPopover
      cwd="/home/alice/projects/agentory"
      onPick={onPick}
      onBrowse={onBrowse}
      loadRecent={loadRecent}
      {...overrides}
    />
  );
  return { ...utils, onPick, onBrowse, loadRecent };
}

async function openPopover() {
  // Trigger renders the last segment of the cwd; click it to open.
  const trigger = screen.getByRole('button', { name: /agentory/i });
  await act(async () => {
    fireEvent.click(trigger);
  });
  // Allow the loadRecent promise to resolve.
  await waitFor(() => {
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
}

describe('<CwdPopover />', () => {
  // The popover's open state now lives on the global store (PR #221:
  // openPopoverId mutex). Reset between tests so a leftover "cwd" slot from
  // the previous case doesn't make the next click toggle the popover shut.
  beforeEach(() => {
    useStore.setState({ openPopoverId: null });
  });

  it('renders the trigger labelled with the last cwd path segment', () => {
    renderPopover();
    expect(screen.getByRole('button', { name: /agentory/i })).toBeInTheDocument();
  });

  it('opens on click and lists ALL recent cwds (no seeded filter)', async () => {
    const { loadRecent } = renderPopover();
    await openPopover();
    expect(loadRecent).toHaveBeenCalled();
    // Regression: the input must NOT be seeded with the current cwd, so the
    // full Recent list is visible on open. (Previously seeding `cwd` filtered
    // recent down to entries containing the current path substring.)
    await waitFor(() => {
      const options = screen.getAllByRole('option');
      expect(options.length).toBe(SAMPLE.length);
    });
  });

  it('shows the current cwd as the input placeholder on open', async () => {
    renderPopover();
    await openPopover();
    const input = screen.getByRole('textbox');
    expect(input).toHaveValue('');
    expect((input as HTMLInputElement).placeholder).toContain('agentory');
  });

  it('clearing the input still shows every recent cwd', async () => {
    renderPopover();
    await openPopover();
    const input = screen.getByRole('textbox');
    await act(async () => {
      fireEvent.change(input, { target: { value: '' } });
    });
    await waitFor(() => {
      expect(screen.getAllByRole('option').length).toBe(SAMPLE.length);
    });
  });

  it('filters the recent list as the user types in the input', async () => {
    renderPopover();
    await openPopover();
    const input = screen.getByRole('textbox');
    await act(async () => {
      fireEvent.change(input, { target: { value: 'cli' } });
    });
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(1);
    expect(options[0].textContent).toMatch(/cli-tools/);
  });

  it('clicking a recent entry calls onPick with the full path', async () => {
    const { onPick } = renderPopover();
    await openPopover();
    await waitFor(() => {
      expect(screen.getAllByRole('option').length).toBe(SAMPLE.length);
    });
    const options = screen.getAllByRole('option');
    // Use mousedown — the component listens on mousedown so the input
    // doesn't blur before commit fires.
    await act(async () => {
      fireEvent.mouseDown(options[2]);
    });
    expect(onPick).toHaveBeenCalledWith(SAMPLE[2]);
  });

  it('clicking the Browse button calls onBrowse and closes the popover', async () => {
    const { onBrowse, onPick } = renderPopover();
    await openPopover();
    const browse = screen.getByRole('button', { name: /browse/i });
    await act(async () => {
      fireEvent.mouseDown(browse);
    });
    expect(onBrowse).toHaveBeenCalledTimes(1);
    expect(onPick).not.toHaveBeenCalled();
    // Popover should be closed (dialog removed from the tree).
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Escape closes the popover without picking', async () => {
    const { onPick } = renderPopover();
    await openPopover();
    await act(async () => {
      fireEvent.keyDown(document, { key: 'Escape' });
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(onPick).not.toHaveBeenCalled();
  });

  it('shows the empty hint when no recent path matches the query', async () => {
    renderPopover();
    await openPopover();
    const input = screen.getByRole('textbox');
    await act(async () => {
      fireEvent.change(input, { target: { value: 'zzz-no-match-zzz' } });
    });
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(screen.getByText(/no matching recent/i)).toBeInTheDocument();
  });

  it('Enter on the input commits the highlighted recent entry', async () => {
    const { onPick } = renderPopover();
    await openPopover();
    const input = screen.getByRole('textbox');
    // Query starts empty so the full list is shown; arrow down once to move
    // off the first row.
    await waitFor(() => {
      expect(screen.getAllByRole('option').length).toBe(SAMPLE.length);
    });
    await act(async () => {
      fireEvent.keyDown(input, { key: 'ArrowDown' });
    });
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
    });
    expect(onPick).toHaveBeenCalledWith(SAMPLE[1]);
  });

  it('renders the missing-cwd warning glyph when cwdMissing is true', () => {
    renderPopover({ cwdMissing: true });
    // The trigger gains the warning aria-label on its inner glyph.
    expect(screen.getByLabelText(/missing/i)).toBeInTheDocument();
  });
});
