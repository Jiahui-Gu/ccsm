import { Terminal, type ITerminalOptions } from '@xterm/xterm';
import { SerializeAddon } from '@xterm/addon-serialize';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';

import type { TerminalGeometry } from '../shared/mobileRemote';
import type { TerminalSyncEffect } from './terminalSync';

const RESIZE_DEBOUNCE_MS = 120;
const ORIENTATION_FOLLOWUP_MS = 250;

export type TerminalViewportAnchor =
  | { mode: 'bottom'; horizontalOffsetPx: number; canonicalCols: number }
  | {
      mode: 'history';
      distanceFromBottom: number;
      horizontalOffsetPx: number;
      canonicalCols: number;
    };

export type TerminalScrollMetrics = {
  maximumTop: number;
  currentTop: number;
  visibleRows: number;
};

export type TerminalViewportState = {
  geometry: TerminalGeometry | null;
  contentWidthPx: number;
  scroll: TerminalScrollMetrics;
};

export type MobileTerminalRenderStats = {
  installSnapshotCount: number;
  terminalResetCount: number;
};

export type RenderTerminalEffect = Extract<
  TerminalSyncEffect,
  { type: 'installSnapshot' | 'write' }
>;

export interface MobileXtermTerminal {
  readonly element: HTMLElement | undefined;
  readonly textarea: HTMLTextAreaElement | undefined;
  readonly cols: number;
  readonly rows: number;
  readonly unicode: { activeVersion: string };
  readonly buffer: { active: { baseY: number; viewportY: number } };
  open(parent: HTMLElement): void;
  reset(): void;
  write(data: string, callback?: () => void): void;
  resize(columns: number, rows: number): void;
  getSelection(): string;
  clearSelection(): void;
  scrollToLine(line: number): void;
  scrollLines(amount: number): void;
  onScroll(listener: (position: number) => void): { dispose(): void };
  loadAddon(addon: MobileXtermAddon): void;
  dispose(): void;
}

export interface MobileXtermAddon {
  dispose(): void;
}

export interface MobileSerializeAddon extends MobileXtermAddon {
  serialize(): string;
}

export type MobileTerminalAdapterOptions = {
  createTerminal?: (options: ITerminalOptions) => MobileXtermTerminal;
  createSerializeAddon?: () => MobileSerializeAddon;
  createUnicode11Addon?: () => MobileXtermAddon;
  createWebLinksAddon?: () => MobileXtermAddon;
};

export type MobileTerminalAdapter = {
  apply(
    effects: readonly RenderTerminalEffect[],
    anchor?: TerminalViewportAnchor,
  ): void;
  captureAnchor(horizontalOffsetPx: number): TerminalViewportAnchor;
  getViewportState(): TerminalViewportState;
  subscribeViewport(listener: (state: TerminalViewportState) => void): () => void;
  scrollToLine(line: number): void;
  scrollLines(lines: number): void;
  copySelection(): Promise<void>;
  serialize(): string;
  getRenderStats?(): MobileTerminalRenderStats;
  dispose(): void;
};

const FONT_FAMILY =
  'JetBrains Mono Variable, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

const THEME = { background: '#0d0f12', foreground: '#e8eaed' };

function defaultCreateTerminal(options: ITerminalOptions): MobileXtermTerminal {
  return new Terminal(options);
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

function hardenMobileTerminalTextarea(textarea: HTMLTextAreaElement | undefined): void {
  if (!textarea) return;
  textarea.readOnly = true;
  textarea.tabIndex = -1;
  textarea.setAttribute('inputmode', 'none');
  textarea.setAttribute('aria-hidden', 'true');
  textarea.focus = () => {
    // Preserve native pointer selection while suppressing xterm's private
    // mousedown -> helper textarea focus path that summons software keyboards.
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

type PendingRenderCompletion = { ready: boolean; run: () => void };

export function createMobileTerminalAdapter(
  element: HTMLElement,
  options: MobileTerminalAdapterOptions = {},
): MobileTerminalAdapter {
  const createTerminal = options.createTerminal ?? defaultCreateTerminal;
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
    allowProposedApi: true,
  });

  const serializeAddon = createSerializeAddon();
  const unicode11Addon = createUnicode11Addon();
  const webLinksAddon = createWebLinksAddon();
  const addons: readonly MobileXtermAddon[] = [serializeAddon, unicode11Addon, webLinksAddon];

  terminal.loadAddon(serializeAddon);
  terminal.loadAddon(unicode11Addon);
  terminal.loadAddon(webLinksAddon);
  terminal.unicode.activeVersion = '11';
  terminal.open(element);
  hardenMobileTerminalTextarea(terminal.textarea);

  let geometry: TerminalGeometry | null = null;
  let viewportState: TerminalViewportState = {
    geometry,
    contentWidthPx: 0,
    scroll: {
      maximumTop: clamp(terminal.buffer.active.baseY, 0, Number.MAX_SAFE_INTEGER),
      currentTop: clamp(
        terminal.buffer.active.viewportY,
        0,
        clamp(terminal.buffer.active.baseY, 0, Number.MAX_SAFE_INTEGER),
      ),
      visibleRows: terminal.rows,
    },
  };
  let viewportTimer: ReturnType<typeof setTimeout> | null = null;
  let orientationTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  const viewportListeners = new Set<(state: TerminalViewportState) => void>();
  const pendingRenderCompletions: PendingRenderCompletion[] = [];
  let installSnapshotCount = 0;
  let terminalResetCount = 0;

  function readScrollMetrics(): TerminalScrollMetrics {
    const maximumTop = clamp(terminal.buffer.active.baseY, 0, Number.MAX_SAFE_INTEGER);
    const currentTop = clamp(terminal.buffer.active.viewportY, 0, maximumTop);
    return {
      maximumTop,
      currentTop,
      visibleRows: terminal.rows,
    };
  }

  function measureContentWidthPx(): number {
    const screen = terminal.element?.querySelector('.xterm-screen');
    if (!(screen instanceof HTMLElement)) return 0;
    const width = screen.getBoundingClientRect().width;
    return Number.isFinite(width) && width > 0 ? width : 0;
  }

  function buildViewportState(): TerminalViewportState {
    return {
      geometry,
      contentWidthPx: measureContentWidthPx(),
      scroll: readScrollMetrics(),
    };
  }

  function publishViewport(): void {
    if (disposed) return;
    viewportState = buildViewportState();
    for (const listener of [...viewportListeners]) {
      listener(viewportState);
    }
  }

  function flushRenderCompletions(): void {
    if (disposed) return;
    while (pendingRenderCompletions.length > 0 && pendingRenderCompletions[0]?.ready) {
      const next = pendingRenderCompletions.shift();
      next?.run();
    }
  }

  function enqueueRenderCompletion(
    writeOperation: (done: () => void) => void,
    completion: () => void,
  ): void {
    const pending: PendingRenderCompletion = { ready: false, run: completion };
    pendingRenderCompletions.push(pending);
    writeOperation(() => {
      if (disposed) return;
      pending.ready = true;
      flushRenderCompletions();
    });
  }

  function captureAnchor(horizontalOffsetPx: number): TerminalViewportAnchor {
    const scroll = readScrollMetrics();
    const distanceFromBottom = scroll.maximumTop - scroll.currentTop;
    const canonicalCols = geometry?.cols ?? terminal.cols;
    if (distanceFromBottom <= 0) {
      return {
        mode: 'bottom',
        horizontalOffsetPx,
        canonicalCols,
      };
    }
    return {
      mode: 'history',
      distanceFromBottom,
      horizontalOffsetPx,
      canonicalCols,
    };
  }

  function restoreVerticalAnchor(anchor: TerminalViewportAnchor): void {
    const { maximumTop } = readScrollMetrics();
    if (anchor.mode === 'bottom') {
      terminal.scrollToLine(maximumTop);
      return;
    }
    const target = clamp(maximumTop - anchor.distanceFromBottom, 0, maximumTop);
    terminal.scrollToLine(target);
  }

  function apply(
    effects: readonly RenderTerminalEffect[],
    suppliedAnchor?: TerminalViewportAnchor,
  ): void {
    if (disposed) return;
    const anchor = suppliedAnchor ?? captureAnchor(0);
    for (const effect of effects) {
      if (effect.type === 'installSnapshot') {
        installSnapshotCount += 1;
        geometry = effect.geometry;
        terminal.resize(effect.geometry.cols, effect.geometry.rows);
        terminal.reset();
        terminalResetCount += 1;
        enqueueRenderCompletion(
          (done) => terminal.write(effect.snapshot, done),
          () => {
            restoreVerticalAnchor(anchor);
            publishViewport();
          },
        );
        continue;
      }

      const beforeWrite = captureAnchor(anchor.horizontalOffsetPx);
      enqueueRenderCompletion(
        (done) => terminal.write(effect.data, done),
        () => {
          restoreVerticalAnchor(beforeWrite);
          publishViewport();
        },
      );
    }
  }

  function scheduleViewportPublish(): void {
    if (disposed) return;
    if (viewportTimer) clearTimeout(viewportTimer);
    viewportTimer = setTimeout(() => {
      viewportTimer = null;
      publishViewport();
    }, RESIZE_DEBOUNCE_MS);
  }

  function applyViewportCssVariables(): void {
    const viewport = window.visualViewport;
    if (!viewport) return;
    document.documentElement.style.setProperty('--app-height', `${viewport.height}px`);
    document.documentElement.style.setProperty('--app-offset-top', `${viewport.offsetTop}px`);
  }

  function syncViewportMetrics(): void {
    if (disposed) return;
    applyViewportCssVariables();
    scheduleViewportPublish();
  }

  function handleOrientationChange(): void {
    if (disposed) return;
    syncViewportMetrics();
    if (orientationTimer) clearTimeout(orientationTimer);
    orientationTimer = setTimeout(() => {
      orientationTimer = null;
      syncViewportMetrics();
    }, ORIENTATION_FOLLOWUP_MS);
  }

  function getViewportState(): TerminalViewportState {
    return viewportState;
  }

  function subscribeViewport(listener: (state: TerminalViewportState) => void): () => void {
    viewportListeners.add(listener);
    return () => {
      viewportListeners.delete(listener);
    };
  }

  function scrollToLine(line: number): void {
    if (disposed) return;
    const maximumTop = readScrollMetrics().maximumTop;
    const target = clamp(Math.trunc(line), 0, maximumTop);
    terminal.scrollToLine(target);
    publishViewport();
  }

  function scrollLines(lines: number): void {
    if (disposed) return;
    const scroll = readScrollMetrics();
    const target = clamp(scroll.currentTop + Math.trunc(lines), 0, scroll.maximumTop);
    const amount = target - scroll.currentTop;
    if (amount === 0) return;
    terminal.scrollLines(amount);
    publishViewport();
  }

  async function copySelection(): Promise<void> {
    const selection = terminal.getSelection();
    if (!selection) return;
    await navigator.clipboard.writeText(selection);
    terminal.clearSelection();
  }

  function serialize(): string {
    return serializeAddon.serialize();
  }

  function getRenderStats(): MobileTerminalRenderStats {
    return {
      installSnapshotCount,
      terminalResetCount,
    };
  }

  const scrollSubscription = terminal.onScroll(() => {
    publishViewport();
  });

  let hostResizeObserver: ResizeObserver | null = null;
  if (typeof ResizeObserver === 'function') {
    hostResizeObserver = new ResizeObserver(() => {
      syncViewportMetrics();
    });
    hostResizeObserver.observe(element);
  }

  const viewport = window.visualViewport;
  window.addEventListener('resize', syncViewportMetrics);
  window.addEventListener('orientationchange', handleOrientationChange);
  viewport?.addEventListener('resize', syncViewportMetrics);
  viewport?.addEventListener('scroll', syncViewportMetrics);
  syncViewportMetrics();

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    if (viewportTimer) clearTimeout(viewportTimer);
    if (orientationTimer) clearTimeout(orientationTimer);
    pendingRenderCompletions.length = 0;
    viewportListeners.clear();
    window.removeEventListener('resize', syncViewportMetrics);
    window.removeEventListener('orientationchange', handleOrientationChange);
    viewport?.removeEventListener('resize', syncViewportMetrics);
    viewport?.removeEventListener('scroll', syncViewportMetrics);
    scrollSubscription.dispose();
    hostResizeObserver?.disconnect();
    for (const addon of addons) {
      try {
        addon.dispose();
      } catch {
        // best effort for late teardown
      }
    }
    terminal.dispose();
  }

  const adapter: MobileTerminalAdapter = {
    apply,
    captureAnchor,
    getViewportState,
    subscribeViewport,
    scrollToLine,
    scrollLines,
    copySelection,
    serialize,
    getRenderStats,
    dispose,
  };

  return adapter;
}
