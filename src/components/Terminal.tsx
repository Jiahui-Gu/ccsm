import { useEffect, useLayoutEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { useTranslation } from '../i18n/useTranslation';

// Read-only ANSI renderer for tool output (Bash etc.). v0.1: append-only,
// no input. The data prop is treated as the *full* output for the call —
// when it changes we diff (append the new tail or rewrite if shrunk).
//
// Sizing: the host gives us width via the parent flex container. Height
// is derived from rows (capped) so the block sits inline in the chat
// stream rather than scrolling its own viewport indefinitely.

const MIN_ROWS = 4;
const MAX_ROWS = 24;
const FALLBACK_COLS = 80;

// Theme matched to global.css surface tokens. Hard-coded sRGB hex because
// xterm's renderer doesn't accept oklch(); approximations of bg-elevated /
// fg-primary / fg-tertiary / accent / state-error / state-running.
const THEME = {
  background: '#26282b',
  foreground: '#e8e8e8',
  cursor: '#e8e8e8',
  cursorAccent: '#26282b',
  selectionBackground: 'rgba(255,255,255,0.18)',
  black: '#3b3d40',
  red: '#e06c5a',
  green: '#82c98a',
  yellow: '#d8a86b',
  blue: '#6aa9d9',
  magenta: '#c490d1',
  cyan: '#6dc5c2',
  white: '#d6d6d6',
  brightBlack: '#5a5d61',
  brightRed: '#ed8a7a',
  brightGreen: '#9bd9a3',
  brightYellow: '#e6c08c',
  brightBlue: '#8bbde2',
  brightMagenta: '#d4a8de',
  brightCyan: '#90d4d2',
  brightWhite: '#f0f0f0'
} as const;

export interface TerminalProps {
  data: string;
  /** Whether the producing tool is still running — affects the empty hint. */
  running?: boolean;
}

export function Terminal({ data, running }: TerminalProps) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const lastWrittenRef = useRef<string>('');

  // One-time mount: build the xterm instance.
  useLayoutEffect(() => {
    const host = containerRef.current;
    if (!host) return;

    const term = new XTerm({
      convertEol: true,
      cursorBlink: false,
      cursorStyle: 'underline',
      disableStdin: true,
      scrollback: 5000,
      fontFamily:
        '"JetBrains Mono Variable", "JetBrains Mono", "SF Mono", Menlo, Consolas, monospace',
      fontSize: 12,
      lineHeight: 1.2,
      cols: FALLBACK_COLS,
      rows: MIN_ROWS,
      theme: THEME,
      allowProposedApi: false
    });

    const fit = new FitAddon();
    const links = new WebLinksAddon();
    term.loadAddon(fit);
    term.loadAddon(links);
    term.open(host);

    termRef.current = term;
    fitRef.current = fit;
    lastWrittenRef.current = '';

    // Initial fit. Dimensions may not be ready on first frame — guard.
    try {
      fit.fit();
    } catch {
      /* container not measurable yet — retry on resize */
    }

    const ro = new window.ResizeObserver(() => {
      try {
        fit.fit();
        const rows = Math.max(MIN_ROWS, Math.min(MAX_ROWS, term.rows));
        if (rows !== term.rows) term.resize(term.cols, rows);
      } catch {
        /* ignore — host may be detached mid-resize */
      }
    });
    ro.observe(host);

    return () => {
      ro.disconnect();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      lastWrittenRef.current = '';
    };
  }, []);

  // Sync data into the terminal. We treat `data` as the cumulative output;
  // when it grows we write the new tail, when it shrinks (rare — caller
  // resets) we clear and rewrite.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    const prev = lastWrittenRef.current;
    if (data === prev) return;
    if (data.startsWith(prev)) {
      const tail = data.slice(prev.length);
      if (tail) term.write(tail);
    } else {
      term.reset();
      if (data) term.write(data);
    }
    lastWrittenRef.current = data;
  }, [data]);

  // Clamp rows to content so the block doesn't reserve giant empty space
  // for short output. Re-runs whenever data changes.
  useEffect(() => {
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit) return;
    try {
      const proposed = fit.proposeDimensions();
      const cols = proposed?.cols ?? term.cols;
      // Estimate used rows from data line count (cheap, not exact w/ wrapping).
      const lineCount = data ? data.split('\n').length : 1;
      const rows = Math.max(MIN_ROWS, Math.min(MAX_ROWS, lineCount + 1));
      if (cols !== term.cols || rows !== term.rows) term.resize(cols, rows);
    } catch {
      /* container not measurable */
    }
  }, [data]);

  const empty = !data;
  return (
    <div className="mt-1 ml-6 rounded-sm border border-border-subtle overflow-hidden bg-[#26282b]">
      <div
        ref={containerRef}
        data-testid="terminal-host"
        className="px-2 py-1.5 min-h-[64px]"
        style={{ width: '100%' }}
      />
      {empty && (
        <div className="px-3 py-1 font-mono text-mono-sm text-fg-tertiary border-t border-border-subtle">
          {running ? t('terminal.waitingOutput') : t('terminal.noOutput')}
        </div>
      )}
    </div>
  );
}
