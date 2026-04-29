// Migrated from harness-ui case `tutorial` (Task #740 Batch 3.1).
// The probe asserted: Step 1/4 indicator visible, Skip button present, Next
// advances steps, final step shows New Session + Import Session buttons +
// Done flips an external state. Plus a SCREAMING-strings guard (PR #248
// Gap #1) — no element should have computed `text-transform: uppercase`.
//
// Tutorial is a self-contained controlled component (no store, no IPC),
// so RTL covers it without booting Electron. The store-driven `tutorialSeen`
// flip in App is exercised separately via tests/app-effects/useTutorialOverlay.
//
// Reverse-verify (manual):
//   - Add `text-transform: uppercase` to a Tutorial heading style →
//     `no SCREAMING text-transform: uppercase styles` fails.
//   - Drop the Done button → `final step exposes Done` fails.
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { Tutorial } from '../src/components/Tutorial';

beforeEach(() => cleanup());

describe('<Tutorial />', () => {
  function mount() {
    const onNewSession = vi.fn();
    const onImport = vi.fn();
    const onSkip = vi.fn();
    render(<Tutorial onNewSession={onNewSession} onImport={onImport} onSkip={onSkip} />);
    return { onNewSession, onImport, onSkip };
  }

  it('opens on Step 1 of 4 with welcome copy + Skip button', () => {
    mount();
    expect(screen.getByText(/Step 1 of 4/i)).toBeInTheDocument();
    expect(screen.getByText(/A workbench for AI sessions/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Skip$/ })).toBeInTheDocument();
  });

  it('advances Step 1 → 4 via Next; final step exposes New Session + Import Session + Done', async () => {
    const { onNewSession, onImport, onSkip } = mount();

    const next = () => fireEvent.click(screen.getByRole('button', { name: /^Next$/ }));
    // AnimatePresence with mode="wait" temporarily mounts two copies during
    // the exit/enter transition; use findAllByText to wait until the new
    // step copy is in the DOM (handles either single or transient-double).
    next();
    expect((await screen.findAllByText(/Step 2 of 4/i)).length).toBeGreaterThan(0);
    next();
    expect((await screen.findAllByText(/Step 3 of 4/i)).length).toBeGreaterThan(0);
    next();
    expect((await screen.findAllByText(/Step 4 of 4/i)).length).toBeGreaterThan(0);

    // Final-step copy + dual CTAs.
    expect((await screen.findAllByText(/Ready when you are/i)).length).toBeGreaterThan(0);
    const newSessionBtn = await screen.findByRole('button', { name: /^New Session$/ });
    const importBtn = await screen.findByRole('button', { name: /^Import Session$/ });
    fireEvent.click(newSessionBtn);
    expect(onNewSession).toHaveBeenCalledTimes(1);
    fireEvent.click(importBtn);
    expect(onImport).toHaveBeenCalledTimes(1);

    // Done is the right-side CTA on the last step (replaces Next).
    fireEvent.click(screen.getByRole('button', { name: /^Done$/ }));
    expect(onSkip).toHaveBeenCalledTimes(1);
  });

  it('Skip on step 1 fires onSkip', () => {
    const { onSkip } = mount();
    fireEvent.click(screen.getByRole('button', { name: /^Skip$/ }));
    expect(onSkip).toHaveBeenCalledTimes(1);
  });

  it('no SCREAMING text-transform: uppercase styles in tutorial DOM (#315)', () => {
    mount();
    const root = screen.getByTestId('tutorial');
    const offenders: string[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let node: Node | null = walker.currentNode;
    while (node) {
      const el = node as HTMLElement;
      if (el && el.textContent && el.children.length === 0) {
        const txt = el.textContent.trim();
        if (txt && /[a-zA-Z]/.test(txt)) {
          const tt = window.getComputedStyle(el).textTransform;
          if (tt === 'uppercase') offenders.push(`${el.tagName}: ${txt.slice(0, 60)}`);
        }
      }
      node = walker.nextNode();
    }
    expect(offenders).toEqual([]);
  });
});
