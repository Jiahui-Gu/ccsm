// Unit tests for `useFocusRestore` — these assertions must be strong enough
// that removing ONLY our custom restore logic (not Radix) causes each test to
// fail. The old version of this file had one trivially-passing case: it
// focused `prior` before opening and asserted focus was still on `prior`
// after close, without ever moving focus elsewhere in between. A no-op
// `onCloseAutoFocus` handler would have passed that assertion. We now
// simulate what Radix (or the user) does between open and close — move focus
// to an element inside the dialog — so that "focus lands back on prior" is
// only true if our hook actively restored it. We also pin the preventDefault
// contract that keeps Radix's built-in restore from racing us.
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

  it('restores the captured previous element even when focus has moved INSIDE the dialog in between', () => {
    const { getByTestId } = render(
      <div>
        <input data-testid="prior" />
        <input data-testid="inside-dialog" />
        <Harness fallbackSelector='[data-session-id]' />
      </div>
    );

    const prior = getByTestId('prior') as HTMLInputElement;
    const insideDialog = getByTestId('inside-dialog') as HTMLInputElement;
    prior.focus();
    expect(document.activeElement).toBe(prior);

    act(() => {
      getByTestId('open').click();
    });

    // Simulate Radix's focus trap (or the user tabbing around inside the
    // dialog) moving focus somewhere other than `prior` between open and
    // close. Without this, a no-op `handleCloseAutoFocus` would trivially
    // "pass" because nothing ever moved focus away from `prior`.
    insideDialog.focus();
    expect(document.activeElement).toBe(insideDialog);

    // Now close. Only our hook's restore logic puts focus back on `prior`;
    // a no-op handler leaves focus on `insideDialog`.
    act(() => {
      getByTestId('close').click();
    });

    expect(document.activeElement).toBe(prior);
    // Paranoid: catch a hypothetical buggy restore that targets the wrong
    // element (e.g. fallback-selector match) by pinning the negative.
    expect(document.activeElement).not.toBe(insideDialog);
  });
});

// Pinning the preventDefault contract separately: a hook that restores focus
// but forgets `event.preventDefault()` would pass the focus-outcome tests
// above, yet in real usage Radix would still race it and sometimes land
// focus on document.body. JSDOM-with-plain-Harness can't reproduce that
// race, so we assert the contract directly on the Event object.
describe('useFocusRestore contract: suppresses Radix default restore', () => {
  function HarnessExposed({
    onHandler
  }: {
    onHandler: (h: (e: Event) => void) => void;
  }) {
    const [open, setOpen] = useState(false);
    const { handleCloseAutoFocus } = useFocusRestore(open, {
      fallbackSelector: '[data-session-id]'
    });
    onHandler(handleCloseAutoFocus);
    return (
      <button data-testid="open-x" onClick={() => setOpen(true)}>
        open
      </button>
    );
  }

  it('handleCloseAutoFocus calls event.preventDefault()', () => {
    let handler: ((e: Event) => void) | null = null;
    const { getByTestId } = render(
      <HarnessExposed onHandler={(h) => (handler = h)} />
    );
    act(() => {
      getByTestId('open-x').click();
    });
    expect(handler).toBeTruthy();
    const ev = new Event('test', { cancelable: true });
    act(() => {
      handler!(ev);
    });
    // If the hook forgets preventDefault, Radix's built-in focus return
    // runs and can land focus on document.body. Pin the contract here so
    // a regression is caught even though JSDOM doesn't execute Radix's
    // focus scope.
    expect(ev.defaultPrevented).toBe(true);
  });
});
