// UT for src/components/WindowControls.tsx — covers:
//   * darwin platform → renders nothing (mac uses native traffic-light controls)
//   * win32 platform → 3 buttons: minimize / maximize-or-restore / close
//   * each button delegates to the corresponding bridge method
//   * the maximize/restore button label flips with the maximized state
//   * DragRegion / NoDragRegion apply the WebkitAppRegion style
import React from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import {
  WindowControls,
  DragRegion,
  NoDragRegion,
} from '../../src/components/WindowControls';

type MaxChangedHandler = (isMax: boolean) => void;

function installBridge(opts: {
  platform: 'win32' | 'darwin' | 'linux';
  initialMaximized?: boolean;
}) {
  let listener: MaxChangedHandler | null = null;
  const handlers = {
    minimize: vi.fn(function () {}),
    toggleMaximize: vi.fn(function () {}),
    close: vi.fn(function () {}),
    isMaximized: vi.fn(function () {
      return Promise.resolve(opts.initialMaximized ?? false);
    }),
    onMaximizedChanged: vi.fn(function (cb: MaxChangedHandler) {
      listener = cb;
      return function () {
        listener = null;
      };
    }),
  };
  (window as unknown as { ccsm: unknown }).ccsm = {
    window: { platform: opts.platform, ...handlers },
  };
  return { handlers, fireMaxChanged: (v: boolean) => listener?.(v) };
}

afterEach(() => {
  cleanup();
  delete (window as unknown as { ccsm?: unknown }).ccsm;
});

beforeEach(() => {
  delete (window as unknown as { ccsm?: unknown }).ccsm;
});

describe('<WindowControls />', () => {
  it('renders nothing on darwin', () => {
    installBridge({ platform: 'darwin' });
    const { container } = render(<WindowControls />);
    // Only renders the empty shell-side; no buttons inside.
    expect(container.querySelectorAll('button')).toHaveLength(0);
  });

  it('renders three buttons on win32 (minimize / maximize / close)', async () => {
    installBridge({ platform: 'win32' });
    await act(async () => {
      render(<WindowControls />);
      await Promise.resolve();
    });
    expect(screen.getAllByRole('button')).toHaveLength(3);
    expect(screen.getByLabelText(/minimize/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/maximize/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/close/i)).toBeInTheDocument();
  });

  it('clicking the buttons delegates to the bridge', async () => {
    const { handlers } = installBridge({ platform: 'win32' });
    await act(async () => {
      render(<WindowControls />);
      await Promise.resolve();
    });
    fireEvent.click(screen.getByLabelText(/minimize/i));
    expect(handlers.minimize).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByLabelText(/maximize/i));
    expect(handlers.toggleMaximize).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByLabelText(/close/i));
    expect(handlers.close).toHaveBeenCalledTimes(1);
  });

  it('maximize button switches to "restore" once the window is maximized', async () => {
    const { fireMaxChanged } = installBridge({
      platform: 'win32',
      initialMaximized: false,
    });
    await act(async () => {
      render(<WindowControls />);
      await Promise.resolve();
    });
    expect(screen.getByLabelText(/maximize/i)).toBeInTheDocument();

    act(() => fireMaxChanged(true));
    expect(screen.getByLabelText(/restore/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/^maximize$/i)).toBeNull();

    act(() => fireMaxChanged(false));
    expect(screen.getByLabelText(/maximize/i)).toBeInTheDocument();
  });
});

describe('<DragRegion /> + <NoDragRegion />', () => {
  it('DragRegion applies WebkitAppRegion: drag', () => {
    const { container } = render(<DragRegion data-testid="d">x</DragRegion>);
    const el = container.firstElementChild as HTMLElement;
    // jsdom converts WebkitAppRegion into the camel-cased style key.
    expect((el.style as unknown as Record<string, string>).WebkitAppRegion).toBe('drag');
  });

  it('NoDragRegion applies WebkitAppRegion: no-drag', () => {
    const { container } = render(<NoDragRegion>x</NoDragRegion>);
    const el = container.firstElementChild as HTMLElement;
    expect((el.style as unknown as Record<string, string>).WebkitAppRegion).toBe('no-drag');
  });

  it('DragRegion merges custom inline style alongside the drag region style', () => {
    const { container } = render(
      <DragRegion style={{ height: 12 }}>x</DragRegion>
    );
    const el = container.firstElementChild as HTMLElement;
    expect(el.style.height).toBe('12px');
    expect((el.style as unknown as Record<string, string>).WebkitAppRegion).toBe('drag');
  });
});
