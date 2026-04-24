import React, { useRef, useState } from 'react';
import { Copy, Check, Download } from 'lucide-react';
import { useTranslation } from '../../i18n/useTranslation';
import {
  COLLAPSED_HEAD,
  COLLAPSED_TAIL,
  VIEWPORT_LINES,
  VIEWPORT_OVERSCAN,
  LINE_HEIGHT_PX,
  VIEWPORT_HEIGHT_PX,
  MAX_INLINE_BYTES
} from './constants';
import { formatBytes } from './utils';

// ── Long-output viewer ─────────────────────────────────────────────────────
//
// Tool results that aren't shell streams (e.g., Read, Grep, file contents)
// can run to tens of thousands of lines. Three-tier rendering:
//
//   tier 1 (`SMALL`):    <= COLLAPSED_HEAD + COLLAPSED_TAIL lines.
//                        Render every line.
//   tier 2 (`COLLAPSED`):render first 50 + separator + last 50. Separator is
//                        a clickable strip that flips to `expanded`. Toolbar
//                        always shows Copy / Save / Expand.
//   tier 3 (`EXPANDED`): windowed render — only ~VIEWPORT_LINES rows mount,
//                        positioned with absolute + transform on a
//                        height-spaced parent. Pure DOM, no new deps.
//
// Hard ceiling (`MAX_INLINE_BYTES`): if the output exceeds 10MB, the Expand
// button is disabled — the user has to use Save as .log to read it. This
// keeps Electron's renderer stable on huge outputs.
//
// All branches preserve full-text Copy and Save so no data is ever lost.

export function LongOutputView({
  text,
  isError,
  toolName
}: {
  text: string;
  isError: boolean;
  toolName: string;
}) {
  const { t } = useTranslation();
  // Lazy-split: useMemo so 50k-line splits don't run on every render.
  const lines = React.useMemo(() => text.split('\n'), [text]);
  const total = lines.length;
  const byteLen = text.length; // approximation; chars≈bytes for ASCII tool output
  const tooLarge = byteLen > MAX_INLINE_BYTES;
  const small = total <= COLLAPSED_HEAD + COLLAPSED_TAIL;
  // Toolbar is visual noise on tiny outputs (≤10 lines). Hide it — users can
  // still copy via native text selection; Save/Expand are meaningless here.
  const toolbarHidden = total <= 10;

  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState<null | 'ok' | 'err'>(null);
  const [saved, setSaved] = useState<null | 'ok' | 'err'>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const viewportRef = useRef<HTMLDivElement | null>(null);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied('ok');
    } catch {
      setCopied('err');
    }
    setTimeout(() => setCopied(null), 1500);
  };

  const onSave = async () => {
    const api = window.agentory;
    if (!api?.saveFile) {
      setSaved('err');
      setTimeout(() => setSaved(null), 1500);
      return;
    }
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const res = await api.saveFile({
      defaultName: `${toolName.toLowerCase()}-output-${ts}.log`,
      content: text
    });
    if (res.ok) setSaved('ok');
    else if ('canceled' in res && res.canceled) setSaved(null);
    else setSaved('err');
    setTimeout(() => setSaved(null), 1500);
  };

  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    setScrollTop((e.target as HTMLDivElement).scrollTop);
  };

  const colorCls = isError ? 'border-state-error/40 text-state-error-fg' : 'border-border-subtle text-fg-tertiary';

  // Toolbar (rendered unless the output is tiny — see `toolbarHidden`).
  const toolbar = toolbarHidden ? null : (
    <div className="flex items-center justify-end gap-1.5 mb-1 ml-6">
      <span className="text-fg-tertiary text-mono-xs mr-auto font-mono">
        {t('chat.longOutputTooLargeBadge', { size: formatBytes(byteLen), lines: total })}
      </span>
      <button
        type="button"
        onClick={onCopy}
        title={t('chat.longOutputCopy')}
        aria-label={t('chat.longOutputCopy')}
        data-testid="tool-output-copy"
        className="inline-flex items-center gap-1 px-1.5 py-px rounded-sm border border-border-subtle text-mono-xs text-fg-tertiary hover:text-fg-primary hover:border-border-strong active:bg-bg-hover transition-colors duration-150 ease-out outline-none focus-ring"
      >
        {copied === 'ok' ? <Check size={10} /> : <Copy size={10} />}
        {copied === 'ok' ? t('chat.longOutputCopied') : t('chat.longOutputCopy')}
      </button>
      <button
        type="button"
        onClick={onSave}
        title={t('chat.longOutputSave')}
        aria-label={t('chat.longOutputSave')}
        data-testid="tool-output-save"
        className="inline-flex items-center gap-1 px-1.5 py-px rounded-sm border border-border-subtle text-mono-xs text-fg-tertiary hover:text-fg-primary hover:border-border-strong active:bg-bg-hover transition-colors duration-150 ease-out outline-none focus-ring"
      >
        <Download size={10} />
        {saved === 'ok'
          ? t('chat.longOutputSaved')
          : saved === 'err'
            ? t('chat.longOutputSaveFailed')
            : t('chat.longOutputSave')}
      </button>
      {!small && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          disabled={!expanded && tooLarge}
          aria-pressed={expanded}
          data-testid="tool-output-expand"
          title={!expanded && tooLarge ? t('chat.longOutputTooLargeExpand') : undefined}
          className="inline-flex items-center px-1.5 py-px rounded-sm border border-border-subtle text-mono-xs text-fg-tertiary hover:text-fg-primary hover:border-border-strong active:bg-bg-hover transition-colors duration-150 ease-out outline-none focus-ring disabled:opacity-50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:hover:text-fg-tertiary disabled:hover:border-border-subtle"
        >
          {expanded ? t('chat.longOutputCollapse') : t('chat.longOutputExpand')}
        </button>
      )}
    </div>
  );

  // ── tier 1: small — render everything ────────────────────────────────────
  if (small) {
    return (
      <div className="mt-1">
        {toolbar}
        <pre
          className={`ml-6 pl-3 border-l text-meta whitespace-pre-wrap font-mono ${colorCls}`}
          data-testid="tool-output-pre"
        >
          {text}
        </pre>
      </div>
    );
  }

  // ── tier 2: collapsed — head + separator + tail ─────────────────────────
  if (!expanded) {
    const head = lines.slice(0, COLLAPSED_HEAD).join('\n');
    const tail = lines.slice(total - COLLAPSED_TAIL).join('\n');
    const hidden = total - COLLAPSED_HEAD - COLLAPSED_TAIL;
    return (
      <div className="mt-1">
        {toolbar}
        <div className={`ml-6 pl-3 border-l text-meta font-mono ${colorCls}`}>
          <pre
            className="whitespace-pre-wrap"
            data-testid="tool-output-collapsed-head"
          >{head}</pre>
          <button
            type="button"
            onClick={() => !tooLarge && setExpanded(true)}
            disabled={tooLarge}
            data-testid="tool-output-separator"
            className="block w-full text-left my-1 py-0.5 text-fg-tertiary hover:text-fg-secondary hover:bg-bg-hover transition-colors duration-150 ease-out outline-none focus-ring rounded-sm disabled:hover:text-fg-tertiary disabled:hover:bg-transparent disabled:cursor-not-allowed"
            title={tooLarge ? t('chat.longOutputTooLargeExpand') : undefined}
          >
            {t('chat.longOutputHidden', { count: hidden })}
          </button>
          <pre
            className="whitespace-pre-wrap"
            data-testid="tool-output-collapsed-tail"
          >{tail}</pre>
        </div>
      </div>
    );
  }

  // ── tier 3: expanded — windowed render ──────────────────────────────────
  // We allocate a tall scroller (total * LINE_HEIGHT_PX) and only mount the
  // slice of lines visible in the viewport plus an overscan. Each visible
  // line is absolutely positioned at its own offset, so scroll sync is
  // pixel-accurate without React reconciling tens of thousands of nodes.
  const totalHeight = total * LINE_HEIGHT_PX;
  const startIdx = Math.max(0, Math.floor(scrollTop / LINE_HEIGHT_PX) - VIEWPORT_OVERSCAN);
  const endIdx = Math.min(
    total,
    startIdx + VIEWPORT_LINES + VIEWPORT_OVERSCAN * 2
  );
  const slice: Array<{ idx: number; line: string }> = [];
  for (let i = startIdx; i < endIdx; i++) slice.push({ idx: i, line: lines[i] });

  return (
    <div className="mt-1">
      {toolbar}
      <div
        ref={viewportRef}
        onScroll={onScroll}
        data-testid="tool-output-viewport"
        className={`ml-6 pl-3 border-l text-meta font-mono overflow-auto ${colorCls}`}
        style={{ height: VIEWPORT_HEIGHT_PX, position: 'relative' }}
      >
        <div
          data-testid="tool-output-spacer"
          style={{ height: totalHeight, position: 'relative' }}
        >
          {slice.map(({ idx, line }) => (
            <div
              key={idx}
              data-line-index={idx}
              style={{
                position: 'absolute',
                top: idx * LINE_HEIGHT_PX,
                left: 0,
                right: 0,
                height: LINE_HEIGHT_PX,
                lineHeight: `${LINE_HEIGHT_PX}px`,
                whiteSpace: 'pre',
                overflow: 'hidden',
                textOverflow: 'ellipsis'
              }}
            >
              {line || '\u00A0'}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
