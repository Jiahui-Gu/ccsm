// Unit test for `useFocusRestore` covering the fallback-selector path.
//
// Why a unit test (not an e2e probe): the fallback fires only when the
// previously-focused element is `document.body` / `document.documentElement`
// or is no longer in the DOM. In normal product flow the user always has
// SOMETHING focused before opening a dialog (clicking a session row leaves
// focus on the chat textarea, see selectSession + InputBar nonce effect),
// so this branch is unreachable from a click flow. JSDOM lets us drive
// the synthetic state directly.
import React, { useState } from 'react';
import { describe, it, expect } from 'vitest';
import { render, act } from '@testing-library/react';
import { useFocusRestore } from '../src/lib/useFocusRestore';

function Harness({ fallbackSelector }: { fallbackSelector: string }) {
  const [open, setOpen] = useState(false);
  const { handleCloseAutoFocus } = useFocusRestore(open, { fallbackSelector });
  return (
    <div>
      <button data-testid="open" onClick={() => setOpen(true)}>open</button>
      <button
        data-testid="close"
        onClick={() => {
          // Simulate Radix `onCloseAutoFocus` — flip open=false in the same
          // tick we invoke the handler. The hook's useLayoutEffect cleans
          // wasOpenRef on the next render; the handler captures previousRef
          // synchronously here.
          setOpen(false);
          const ev = new Event('focusrestore-test', { cancelable: true });
          handleCloseAutoFocus(ev);
        }}
      >
        close
      </button>
      <ul role="listbox">
        <li
          role="option"
          tabIndex={0}
          aria-selected="true"
          data-session-id="sA"
          data-testid="session-row"
        >
          session-a
        </li>
      </ul>
    </div>
  );
}

describe('useFocusRestore fallback selector', () => {
  it('falls back to the active session row when nothing was focused before open', () => {
    const { getByTestId } = render(
      <Harness fallbackSelector='[data-session-id][aria-selected="true"], [data-session-id][tabindex="0"]' />
    );

    // Precondition: focus is on document.body (no element focused). This
    // mirrors the "user opened a dialog from a global shortcut without
    // anything else focused" edge case that the fallback exists for.
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    expect(document.activeElement).toBe(document.body);

    // Open the dialog. The hook's useLayoutEffect captures activeElement;
    // since it's document.body, previousRef stays null and the close path
    // must use the fallback selector.
    act(() => {
      getByTestId('open').click();
    });

    // Close and trigger the restore handler.
    act(() => {
      getByTestId('close').click();
    });

    // Fallback should have focused the session row.
    expect(document.activeElement).toBe(getByTestId('session-row'));
  });

  it('restores the previously-focused element when one exists, ignoring fallback', () => {
    const { getByTestId } = render(
      <div>
        <input data-testid="prior" />
        <Harness fallbackSelector='[data-session-id]' />
      </div>
    );

    const prior = getByTestId('prior') as HTMLInputElement;
    prior.focus();
    expect(document.activeElement).toBe(prior);

    act(() => {
      getByTestId('open').click();
    });

    act(() => {
      getByTestId('close').click();
    });

    expect(document.activeElement).toBe(prior);
  });
});
