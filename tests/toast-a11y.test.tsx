import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { ToastProvider, useToast, type ToastKind } from '../src/components/ui/Toast';

// Tiny helper component: lets each test trigger a push() with the kind +
// options it cares about, without exposing the provider's internals. Kept
// inside the test file so it can stay tightly scoped to the assertions.
function Pusher({
  kind,
  title = 't',
  body,
  action,
  persistent,
}: {
  kind: ToastKind;
  title?: string;
  body?: string;
  action?: { label: string; onClick: () => void };
  persistent?: boolean;
}) {
  const { push } = useToast();
  return (
    <button
      onClick={() => push({ kind, title, body, action, persistent })}
      data-testid="trigger"
    >
      push
    </button>
  );
}

function flush() {
  return act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

// AnimatePresence keeps a DOM node during its exit animation. For the
// dismiss assertion we don't want to fight framer-motion timing — we just
// check React state cleared by inspecting the data-toast-id attribute,
// which the component sets on the toast root and which AnimatePresence
// will eventually remove. A short tick is enough in jsdom (no real RAF).
async function flushAnim() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 350));
  });
}

describe('<ToastProvider /> a11y + click-to-dismiss', () => {
  it('error toast lives in role="alert" + aria-live="assertive" region with an icon', async () => {
    render(
      <ToastProvider>
        <Pusher kind="error" title="Boom" />
      </ToastProvider>
    );
    fireEvent.click(screen.getByTestId('trigger'));
    await flush();

    const errorRegion = document.querySelector('[role="alert"][aria-live="assertive"]');
    expect(errorRegion).not.toBeNull();
    const item = errorRegion!.querySelector('[data-testid="toast-error"]');
    expect(item).not.toBeNull();
    // The leading glyph is an <svg> rendered by lucide AlertCircle. We
    // assert "an svg is present" rather than a brand-specific class so the
    // test stays robust to lucide version bumps.
    expect(item!.querySelector('svg')).not.toBeNull();
  });

  it('info toast lives in role="status" + aria-live="polite" region', async () => {
    render(
      <ToastProvider>
        <Pusher kind="info" title="Hi" />
      </ToastProvider>
    );
    fireEvent.click(screen.getByTestId('trigger'));
    await flush();

    const polite = document.querySelector('[role="status"][aria-live="polite"]');
    expect(polite).not.toBeNull();
    expect(polite!.querySelector('[data-testid="toast-info"]')).not.toBeNull();
  });

  it('clicking the toast body does NOT dismiss; clicking the close button DOES dismiss', async () => {
    render(
      <ToastProvider>
        {/* persistent so the auto-timer doesn't race the test */}
        <Pusher kind="error" title="Stay" persistent />
      </ToastProvider>
    );
    fireEvent.click(screen.getByTestId('trigger'));
    await flush();

    const item = screen.getByTestId('toast-error');
    // Click the title text — body click must be a no-op.
    fireEvent.click(screen.getByText('Stay'));
    await flush();
    expect(screen.queryByTestId('toast-error')).not.toBeNull();

    // Now click the explicit close button — that should remove it.
    const closeBtn = item.querySelector('button[aria-label="Dismiss"]') as HTMLButtonElement;
    expect(closeBtn).not.toBeNull();
    fireEvent.click(closeBtn);
    await flushAnim();
    expect(screen.queryByTestId('toast-error')).toBeNull();
  });

  it('action button fires its handler without auto-dismissing (caller controls dismiss)', async () => {
    const onAction = vi.fn();
    render(
      <ToastProvider>
        <Pusher
          kind="info"
          title="Update"
          persistent
          action={{ label: 'Restart', onClick: onAction }}
        />
      </ToastProvider>
    );
    fireEvent.click(screen.getByTestId('trigger'));
    await flush();

    fireEvent.click(screen.getByRole('button', { name: 'Restart' }));
    await flush();
    expect(onAction).toHaveBeenCalledTimes(1);
    // Toast should still be on screen — caller decides when to dismiss.
    expect(screen.queryByTestId('toast-info')).not.toBeNull();
  });
});
