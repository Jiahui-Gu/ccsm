// Long-lived, read-only xterm.js adapter for the phone remote terminal pane.
//
// Hard contract (mobile composer/terminal-sync plan, Task 4 + global
// constraints): the terminal is read, scroll, select, and copy only. It
// never opens the software keyboard, never registers `terminal.onData`, and
// this module never calls `terminal.focus()` / `terminal.blur()` on the
// instance or its helper textarea. The composer (a later task) is the sole
// keyboard input surface. Pointer interaction here is only ever used for
// native browser text selection + copy — nothing in this file reacts to
// pointer events by moving focus.
//
// One structural exception: `hardenMobileTerminalTextarea` (below) replaces
// the helper textarea's own `focus` property with a no-op. This is not a
// `focus()`/`blur()` *call* — xterm.js's internal core independently
// registers a native "mousedown" listener on the terminal element that
// calls its own private `focus()`, reaching straight into the helper
// textarea. That internal wiring is otherwise unreachable/unwireable from
// outside xterm, so neutering the instance property is the only way to
// keep the composer as the sole keyboard entry point.
//
// One `Terminal` is created per adapter instance and lives for the whole
// phone session; switching PTYs re-applies effects (`reset` + `write`) to
// the same instance rather than recreating it. Terminal/addon/factory
// construction is injectable via `MobileTerminalAdapterOptions` so unit
// tests can supply plain fakes instead of unsafely mocking `@xterm/xterm`.

import { Terminal, type ITerminalOptions } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SerializeAddon } from '@xterm/addon-serialize';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';

import type { TerminalSyncEffect } from './terminalSync';

const RESIZE_DEBOUNCE_MS = 120;
const ORIENTATION_FOLLOWUP_MS = 250;
// A terminal narrower or shorter than this is not a usable viewport (e.g. a
// host that hasn't been laid out yet) — never resize/emit for it.
const MIN_TERMINAL_DIMENSION = 2;

export type MobileTerminalDimensions = { cols: number; rows: number };

// Structural subset of xterm's public `Terminal` API that this adapter
// depends on. Real `Terminal` instances satisfy this automatically; unit
// tests can inject a plain object instead.
export interface MobileXtermTerminal {
  readonly element: HTMLElement | undefined;
  readonly textarea: HTMLTextAreaElement | undefined;
  readonly cols: number;
  readonly rows: number;
  readonly unicode: { activeVersion: string };
  open(parent: HTMLElement): void;
  reset(): void;
  write(data: string, callback?: () => void): void;
  resize(columns: number, rows: number): void;
  getSelection(): string;
  clearSelection(): void;
  loadAddon(addon: MobileXtermAddon): void;
  dispose(): void;
}

export interface MobileXtermAddon {
  dispose(): void;
}

export interface MobileFitAddon extends MobileXtermAddon {
  proposeDimensions(): MobileTerminalDimensions | undefined;
}

export interface MobileSerializeAddon extends MobileXtermAddon {
  serialize(): string;
}

export type MobileTerminalAdapterOptions = {
  onResize?: (dimensions: MobileTerminalDimensions) => void;
  // Test seams — default to the real xterm.js constructors/addons. Never
  // used in production code paths.
  createTerminal?: (options: ITerminalOptions) => MobileXtermTerminal;
  createFitAddon?: () => MobileFitAddon;
  createSerializeAddon?: () => MobileSerializeAddon;
  createUnicode11Addon?: () => MobileXtermAddon;
  createWebLinksAddon?: () => MobileXtermAddon;
};

export type MobileTerminalAdapter = {
  apply(effects: readonly TerminalSyncEffect[]): void;
  // Computes + applies dimensions immediately (no debounce). `force`
  // re-emits `onResize` even when the proposed dimensions are unchanged from
  // the last emission — used when a newly selected sid needs a resize
  // message at the viewport's current (unchanged) size.
  fit(force?: boolean): void;
  copySelection(): Promise<void>;
  serialize(): string;
  dispose(): void;
};

const FONT_FAMILY =
  'JetBrains Mono Variable, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

const THEME = { background: '#0d0f12', foreground: '#e8eaed' };

function defaultCreateTerminal(options: ITerminalOptions): MobileXtermTerminal {
  return new Terminal(options);
}

function defaultCreateFitAddon(): MobileFitAddon {
  return new FitAddon();
}

function defaultCreateSerializeAddon(): MobileSerializeAddon {
  return new SerializeAddon();
}

function defaultCreateUnicode11Addon(): MobileXtermAddon {
  return new Unicode11Addon();
}

function defaultCreateWebLinksAddon(): MobileXtermAddon {
  return new WebLinksAddon();
}

// Hardens the helper textarea xterm uses to capture keyboard input, without
// ever calling `focus()`/`blur()` on it (never fight the browser's/xterm's
// own focus handling by invoking it ourselves) — it only makes the element
// unable to summon a software keyboard or receive input if it does end up
// focused. Pointer events are left completely untouched so mouse/touch text
// selection inside the terminal viewport keeps working.
//
// Also replaces the textarea's own `focus` with a configurable own no-op.
// This is necessary because xterm.js's internal core registers its OWN
// native "mousedown" listener directly on the terminal element
// (`bindMouse()`), which calls a private `focus()` reaching straight into
// `this.textarea.focus({ preventScroll: true })` — completely bypassing the
// public `Terminal.prototype.focus` API and unreachable from outside xterm.
// Replacing the instance property (not calling it) is the only way to stop
// that internal call from moving keyboard focus; it is exported so the
// production bootstrap entry point (`src/mobile/bootstrap.tsx`) can reuse the exact same
// hardening instead of duplicating it. Safe to call with `undefined` and
// safe to call more than once (idempotent).
export function hardenMobileTerminalTextarea(textarea: HTMLTextAreaElement | undefined): void {
  if (!textarea) return;
  textarea.readOnly = true;
  textarea.tabIndex = -1;
  textarea.setAttribute('inputmode', 'none');
  textarea.setAttribute('aria-hidden', 'true');
  textarea.focus = () => {};
}

export function createMobileTerminalAdapter(
  element: HTMLElement,
  options: MobileTerminalAdapterOptions = {},
): MobileTerminalAdapter {
  const createTerminal = options.createTerminal ?? defaultCreateTerminal;
  const createFitAddon = options.createFitAddon ?? defaultCreateFitAddon;
  const createSerializeAddon = options.createSerializeAddon ?? defaultCreateSerializeAddon;
  const createUnicode11Addon = options.createUnicode11Addon ?? defaultCreateUnicode11Addon;
  const createWebLinksAddon = options.createWebLinksAddon ?? defaultCreateWebLinksAddon;

  const terminal = createTerminal({
    convertEol: false,
    disableStdin: true,
    cursorBlink: false,
    fontSize: 13,
    fontFamily: FONT_FAMILY,
    scrollback: 5000,
    theme: THEME,
    // Unicode11Addon uses a proposed API; without this, activating it
    // (below) throws at runtime — in a real browser, not just under test.
    allowProposedApi: true,
  });

  const fitAddon = createFitAddon();
  const serializeAddon = createSerializeAddon();
  const unicode11Addon = createUnicode11Addon();
  const webLinksAddon = createWebLinksAddon();
  const addons: readonly MobileXtermAddon[] = [
    fitAddon,
    serializeAddon,
    unicode11Addon,
    webLinksAddon,
  ];

  terminal.loadAddon(fitAddon);
  terminal.loadAddon(serializeAddon);
  terminal.loadAddon(unicode11Addon);
  terminal.loadAddon(webLinksAddon);
  terminal.unicode.activeVersion = '11';

  terminal.open(element);
  hardenMobileTerminalTextarea(terminal.textarea);

  let lastEmittedCols = -1;
  let lastEmittedRows = -1;
  let fitTimer: ReturnType<typeof setTimeout> | null = null;
  let orientationTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  function apply(effects: readonly TerminalSyncEffect[]): void {
    for (const effect of effects) {
      if (effect.type === 'reset') {
        terminal.reset();
        terminal.write(effect.data);
      } else if (effect.type === 'write') {
        terminal.write(effect.data);
      }
      // `requestSnapshot` carries no direct terminal action — the caller
      // (mobileRemoteStore) already turns it into an outgoing command.
    }
  }

  function fit(force = false): void {
    let dimensions: MobileTerminalDimensions | undefined;
    try {
      dimensions = fitAddon.proposeDimensions();
    } catch {
      return;
    }
    if (
      !dimensions ||
      !Number.isFinite(dimensions.cols) ||
      !Number.isFinite(dimensions.rows) ||
      dimensions.cols < MIN_TERMINAL_DIMENSION ||
      dimensions.rows < MIN_TERMINAL_DIMENSION
    ) {
      return;
    }
    terminal.resize(dimensions.cols, dimensions.rows);
    const unchanged =
      dimensions.cols === lastEmittedCols && dimensions.rows === lastEmittedRows;
    if (unchanged && !force) return;
    lastEmittedCols = dimensions.cols;
    lastEmittedRows = dimensions.rows;
    options.onResize?.({ cols: dimensions.cols, rows: dimensions.rows });
  }

  function scheduleFit(): void {
    if (fitTimer) clearTimeout(fitTimer);
    fitTimer = setTimeout(() => fit(), RESIZE_DEBOUNCE_MS);
  }

  function syncViewportMetrics(): void {
    const viewport = window.visualViewport;
    if (viewport) {
      document.documentElement.style.setProperty('--app-height', `${viewport.height}px`);
      document.documentElement.style.setProperty('--app-offset-top', `${viewport.offsetTop}px`);
    }
    scheduleFit();
  }

  function handleOrientation(): void {
    scheduleFit();
    if (orientationTimer) clearTimeout(orientationTimer);
    orientationTimer = setTimeout(scheduleFit, ORIENTATION_FOLLOWUP_MS);
  }

  async function copySelection(): Promise<void> {
    const selection = terminal.getSelection();
    if (!selection) return;
    await navigator.clipboard.writeText(selection);
    // Only clear the selection once the copy is confirmed to have
    // succeeded — a rejected write must leave the user's selection intact
    // and reject this promise rather than silently swallow the failure.
    terminal.clearSelection();
  }

  function serialize(): string {
    return serializeAddon.serialize();
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    if (fitTimer) clearTimeout(fitTimer);
    if (orientationTimer) clearTimeout(orientationTimer);
    window.removeEventListener('resize', scheduleFit);
    window.removeEventListener('orientationchange', handleOrientation);
    window.visualViewport?.removeEventListener('resize', syncViewportMetrics);
    window.visualViewport?.removeEventListener('scroll', syncViewportMetrics);
    for (const addon of addons) {
      try {
        addon.dispose();
      } catch {
        /* an addon's dispose() may throw if it was already torn down some
           other way — swallow so the remaining addons still get disposed */
      }
    }
    terminal.dispose();
  }

  window.addEventListener('resize', scheduleFit);
  window.addEventListener('orientationchange', handleOrientation);
  window.visualViewport?.addEventListener('resize', syncViewportMetrics);
  window.visualViewport?.addEventListener('scroll', syncViewportMetrics);
  syncViewportMetrics();

  return { apply, fit, copySelection, serialize, dispose };
}
