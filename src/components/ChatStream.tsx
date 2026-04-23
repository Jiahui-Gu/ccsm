import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ChevronRight,
  AlertCircle,
  ArrowDown,
  Copy,
  Check,
  Download
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { MessageBlock, ImageAttachment } from '../types';
import { useStore } from '../stores/store';
import { attachmentToDataUrl, formatSize } from '../lib/attachments';
import { Button } from './ui/Button';
import { StateGlyph } from './ui/StateGlyph';
import { diffFromToolInput, type DiffSpec } from '../utils/diff';
import { FileTree } from './FileTree';
import { Terminal } from './Terminal';
import { CodeBlock, HighlightedLine, languageFromPath } from './CodeBlock';
import { QuestionBlock } from './QuestionBlock';
import { PermissionPromptBlock } from './PermissionPromptBlock';
import { useTranslation } from '../i18n/useTranslation';

const FILE_TREE_TOOLS = new Set(['Glob', 'LS']);

// Tool names whose output is a shell stream (raw text, often with ANSI
// escapes). We render these in xterm so colors/cursor moves render properly
// instead of leaking as literal `\u001b[...m` noise.
const SHELL_OUTPUT_TOOLS = new Set(['Bash', 'BashOutput']);

function UserBlock({ text, images }: { text: string; images?: ImageAttachment[] }) {
  return (
    <div className="flex gap-3 text-base">
      <span className="text-fg-tertiary select-none w-3 shrink-0 font-mono">&gt;</span>
      <div className="min-w-0 flex-1 flex flex-col gap-1.5">
        {images && images.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {images.map((img) => (
              <a
                key={img.id}
                href={attachmentToDataUrl(img)}
                target="_blank"
                rel="noreferrer"
                title={`${img.name} · ${formatSize(img.size)}`}
                className="group relative block overflow-hidden rounded-sm border border-border-subtle hover:border-border-strong transition-colors duration-150 ease-out"
              >
                <img
                  src={attachmentToDataUrl(img)}
                  alt={img.name}
                  className="h-20 w-20 object-cover transition-transform duration-200 ease-out group-hover:scale-[1.02]"
                  draggable={false}
                />
              </a>
            ))}
          </div>
        )}
        {text && <span className="text-fg-secondary whitespace-pre-wrap">{text}</span>}
      </div>
    </div>
  );
}

function AssistantBlock({ text, streaming }: { text: string; streaming?: boolean }) {
  return (
    <div className="flex gap-3 text-base">
      <span className="text-fg-secondary select-none w-3 shrink-0 font-mono font-semibold leading-[22px]">●</span>
      <div className="text-fg-primary min-w-0 leading-[22px]">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            p: ({ children }) => <p className="whitespace-pre-wrap mb-2 last:mb-0">{children}</p>,
            code: ({ className, children, ...props }: React.HTMLAttributes<HTMLElement> & { node?: unknown; children?: React.ReactNode }) => {
              const isInline = !className?.startsWith('language-');
              const { node: _node, ...rest } = props as { node?: unknown } & Record<string, unknown>;
              if (isInline) {
                return (
                  <code
                    className="font-mono text-[0.9em] px-1 py-0.5 rounded bg-bg-elevated text-fg-primary"
                    {...rest}
                  >
                    {children}
                  </code>
                );
              }
              const lang = className?.replace(/^language-/, '') ?? '';
              const code = Array.isArray(children)
                ? children.filter((c): c is string => typeof c === 'string').join('')
                : typeof children === 'string'
                ? children
                : '';
              return <CodeBlock code={code} language={lang} />;
            },
            pre: ({ children }) => (
              <pre className="my-2 p-3 rounded-md bg-bg-elevated border border-border-subtle overflow-x-auto font-mono text-sm whitespace-pre">
                {children}
              </pre>
            ),
            ul: ({ children }) => <ul className="list-disc pl-5 my-2 space-y-1">{children}</ul>,
            ol: ({ children }) => <ol className="list-decimal pl-5 my-2 space-y-1">{children}</ol>,
            li: ({ children }) => <li className="leading-[22px]">{children}</li>,
            a: ({ children, href }) => (
              <a href={href} target="_blank" rel="noreferrer" className="text-accent underline underline-offset-2">
                {children}
              </a>
            ),
            h1: ({ children }) => <h1 className="text-lg font-semibold mt-3 mb-2">{children}</h1>,
            h2: ({ children }) => <h2 className="text-base font-semibold mt-3 mb-1.5">{children}</h2>,
            h3: ({ children }) => <h3 className="text-base font-semibold mt-2 mb-1">{children}</h3>,
            blockquote: ({ children }) => (
              <blockquote className="border-l-2 border-border-subtle pl-3 my-2 text-fg-secondary">
                {children}
              </blockquote>
            ),
            table: ({ children }) => (
              <div className="my-2 overflow-x-auto">
                <table className="border-collapse text-sm">{children}</table>
              </div>
            ),
            th: ({ children }) => (
              <th className="border border-border-subtle px-2 py-1 text-left font-semibold">{children}</th>
            ),
            td: ({ children }) => <td className="border border-border-subtle px-2 py-1 align-top">{children}</td>
          }}
        >
          {text}
        </ReactMarkdown>
        {streaming && (
          <span
            aria-hidden
            className="inline-block w-[7px] h-[14px] -mb-[2px] ml-0.5 bg-fg-primary/70 align-middle animate-pulse"
          />
        )}
      </div>
    </div>
  );
}

function ToolBlock({
  name,
  brief,
  result,
  isError,
  input
}: {
  name: string;
  brief: string;
  result?: string;
  isError?: boolean;
  input?: unknown;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const hasResult = typeof result === 'string';
  const diff = diffFromToolInput(name, input);
  const isFileTree = FILE_TREE_TOOLS.has(name) && hasResult && !isError;
  const isShellTool = SHELL_OUTPUT_TOOLS.has(name);
  return (
    <div
      className={
        'font-mono text-sm ' +
        (isError
          ? 'relative rounded-sm border border-state-error/40 bg-state-error-soft/50 pl-3 pr-2 py-1 my-0.5'
          : '')
      }
      role={isError ? 'alert' : undefined}
    >
      {isError && (
        <span aria-hidden className="absolute left-0 top-0 bottom-0 w-[2px] bg-state-error rounded-l-sm" />
      )}
      <button
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="group flex items-baseline gap-3 w-full text-left text-fg-tertiary hover:text-fg-secondary transition-colors duration-150 ease-out outline-none rounded-sm focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-border-strong"
      >
        <span className="w-3 shrink-0 flex items-center">
          <motion.span
            initial={false}
            animate={{ rotate: open ? 90 : 0 }}
            transition={{ duration: 0.2, ease: [0, 0, 0.2, 1] }}
            className="inline-flex"
          >
            <ChevronRight
              size={11}
              className={'stroke-[1.75] -ml-px ' + (isError ? 'text-state-error' : '')}
            />
          </motion.span>
        </span>
        <span className="min-w-0 truncate flex items-baseline gap-1.5">
          {isError && (
            <AlertCircle
              size={12}
              className="text-state-error self-center shrink-0"
              aria-label={t('chat.toolFailedAria')}
            />
          )}
          <span
            className={
              isError
                ? 'text-state-error group-hover:text-state-error transition-colors duration-150 ease-out font-semibold'
                : 'text-fg-secondary group-hover:text-fg-primary transition-colors duration-150 ease-out'
            }
          >
            {name}
          </span>
          <span className={isError ? 'text-state-error/80 text-xs' : 'text-fg-tertiary text-xs'}>({brief})</span>
          {isError && <span className="text-state-error/80 text-xs ml-1 uppercase tracking-wider">{t('chat.toolFailedTag')}</span>}
          {!hasResult && !isError && <span className="text-fg-tertiary text-xs ml-2">…</span>}
        </span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="content"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: [0, 0, 0.2, 1] }}
            style={{ overflow: 'hidden' }}
          >
            {input !== undefined && input !== null && !diff && <PrettyInput input={input} />}
            {diff ? (
              <DiffView diff={diff} />
            ) : isFileTree ? (
              <FileTree source={result as string} />
            ) : isShellTool ? (
              <Terminal data={hasResult ? (result ?? '') : ''} running={!hasResult} />
            ) : hasResult ? (
              <LongOutputView text={result as string} isError={!!isError} toolName={name} />
            ) : (
              <pre
                className={`mt-1 ml-6 pl-3 border-l text-xs whitespace-pre-wrap font-mono ${
                  isError ? 'border-state-error/40 text-state-error-fg' : 'border-border-subtle text-fg-tertiary'
                }`}
              >
                {t('chat.runningEllipsis')}
              </pre>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

const LONG_STRING_THRESHOLD = 200;

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

const COLLAPSED_HEAD = 50;
const COLLAPSED_TAIL = 50;
const VIEWPORT_LINES = 200; // window mount budget when expanded
const VIEWPORT_OVERSCAN = 30;
const LINE_HEIGHT_PX = 18;
const VIEWPORT_HEIGHT_PX = 360;
const MAX_INLINE_BYTES = 10 * 1024 * 1024;

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function LongOutputView({
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

  // Toolbar (always rendered).
  const toolbar = (
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
        className="inline-flex items-center gap-1 px-1.5 py-px rounded-sm border border-border-subtle text-mono-xs text-fg-tertiary hover:text-fg-primary hover:border-border-strong active:bg-bg-hover transition-colors duration-150 ease-out outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-border-strong"
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
        className="inline-flex items-center gap-1 px-1.5 py-px rounded-sm border border-border-subtle text-mono-xs text-fg-tertiary hover:text-fg-primary hover:border-border-strong active:bg-bg-hover transition-colors duration-150 ease-out outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-border-strong"
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
          className="inline-flex items-center px-1.5 py-px rounded-sm border border-border-subtle text-mono-xs text-fg-tertiary hover:text-fg-primary hover:border-border-strong active:bg-bg-hover transition-colors duration-150 ease-out outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-border-strong disabled:opacity-50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:hover:text-fg-tertiary disabled:hover:border-border-subtle"
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
          className={`ml-6 pl-3 border-l text-xs whitespace-pre-wrap font-mono ${colorCls}`}
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
        <div className={`ml-6 pl-3 border-l text-xs font-mono ${colorCls}`}>
          <pre
            className="whitespace-pre-wrap"
            data-testid="tool-output-collapsed-head"
          >{head}</pre>
          <button
            type="button"
            onClick={() => !tooLarge && setExpanded(true)}
            disabled={tooLarge}
            data-testid="tool-output-separator"
            className="block w-full text-left my-1 py-0.5 text-fg-tertiary hover:text-fg-secondary hover:bg-bg-hover transition-colors duration-150 ease-out outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-border-strong rounded-sm disabled:hover:text-fg-tertiary disabled:hover:bg-transparent disabled:cursor-not-allowed"
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
        className={`ml-6 pl-3 border-l text-xs font-mono overflow-auto ${colorCls}`}
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

// Pretty-prints tool input with 2-space indent, subtle syntax coloring
// (keys vs strings vs other), and click-to-expand for long string values.
// Keeps the pre element copy-friendly: expanded content is inline plain text.
function PrettyInput({ input }: { input: unknown }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const toggle = (path: string) =>
    setExpanded((prev) => ({ ...prev, [path]: !prev[path] }));

  function render(value: unknown, indent: number, path: string): React.ReactNode[] {
    const pad = '  '.repeat(indent);
    if (value === null) return [<span key={path} className="text-fg-tertiary">null</span>];
    if (typeof value === 'boolean' || typeof value === 'number') {
      return [<span key={path} className="text-fg-secondary">{String(value)}</span>];
    }
    if (typeof value === 'string') {
      const long = value.length > LONG_STRING_THRESHOLD;
      if (long && !expanded[path]) {
        return [
          <span key={`${path}:open`} className="text-fg-tertiary">&quot;</span>,
          <span key={`${path}:body`} className="text-state-running/90 whitespace-pre-wrap">
            {value.slice(0, LONG_STRING_THRESHOLD)}
          </span>,
          <span key={`${path}:ell`} className="text-fg-tertiary">…</span>,
          <button
            key={`${path}:btn`}
            type="button"
            onClick={() => toggle(path)}
            className="ml-1.5 px-1 py-px rounded-sm border border-border-subtle text-mono-xs text-fg-tertiary hover:text-fg-primary hover:border-border-strong active:bg-bg-hover transition-colors duration-150 ease-out outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-border-strong"
            aria-expanded={false}
          >
            {t('chat.expandStringChars', { count: value.length - LONG_STRING_THRESHOLD })}
          </button>,
          <span key={`${path}:close`} className="text-fg-tertiary">&quot;</span>
        ];
      }
      return [
        <span key={`${path}:open`} className="text-fg-tertiary">&quot;</span>,
        <span key={`${path}:body`} className="text-state-running/90 whitespace-pre-wrap">{value}</span>,
        <span key={`${path}:close`} className="text-fg-tertiary">&quot;</span>,
        long ? (
          <button
            key={`${path}:btn`}
            type="button"
            onClick={() => toggle(path)}
            className="ml-1.5 px-1 py-px rounded-sm border border-border-subtle text-mono-xs text-fg-tertiary hover:text-fg-primary hover:border-border-strong active:bg-bg-hover transition-colors duration-150 ease-out outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-border-strong"
            aria-expanded={true}
          >
            {t('chat.collapseString')}
          </button>
        ) : null
      ];
    }
    if (Array.isArray(value)) {
      if (value.length === 0) return [<span key={path}>[]</span>];
      const parts: React.ReactNode[] = [<span key={`${path}:o`}>[</span>, '\n'];
      value.forEach((item, i) => {
        parts.push(pad + '  ');
        parts.push(...render(item, indent + 1, `${path}.${i}`));
        if (i < value.length - 1) parts.push(',');
        parts.push('\n');
      });
      parts.push(pad, <span key={`${path}:c`}>]</span>);
      return parts;
    }
    if (typeof value === 'object') {
      const entries = Object.entries(value as Record<string, unknown>);
      if (entries.length === 0) return [<span key={path}>{'{}'}</span>];
      const parts: React.ReactNode[] = [<span key={`${path}:o`}>{'{'}</span>, '\n'];
      entries.forEach(([k, v], i) => {
        parts.push(pad + '  ');
        parts.push(
          <span key={`${path}.${k}:k`} className="text-accent">{`"${k}"`}</span>,
          <span key={`${path}.${k}:colon`} className="text-fg-tertiary">: </span>
        );
        parts.push(...render(v, indent + 1, `${path}.${k}`));
        if (i < entries.length - 1) parts.push(',');
        parts.push('\n');
      });
      parts.push(pad, <span key={`${path}:c`}>{'}'}</span>);
      return parts;
    }
    return [<span key={path}>{String(value)}</span>];
  }

  return (
    <AnimatePresence initial={false}>
      <motion.pre
        key="input"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.15, ease: [0, 0, 0.2, 1] }}
        className="mt-1 ml-6 pl-3 border-l border-border-subtle text-xs font-mono text-fg-secondary whitespace-pre-wrap mb-1"
      >
        <span className="text-fg-tertiary text-mono-xs uppercase tracking-wider mr-2">{t('chat.inputBytes')}</span>
        {render(input, 0, 'root')}
      </motion.pre>
    </AnimatePresence>
  );
}

function DiffView({ diff }: { diff: DiffSpec }) {
  const { t } = useTranslation();
  // Per-hunk accept/reject state. `null` = pending, 'accepted' / 'rejected'
  // once the user acts. Today this is UI-only — the partial-write IPC back
  // to the main process is a follow-up (see PR body).
  const [decisions, setDecisions] = useState<Array<'accepted' | 'rejected' | null>>(
    () => diff.hunks.map(() => null)
  );
  const decide = (idx: number, decision: 'accepted' | 'rejected') => {
    setDecisions((prev) => {
      const next = prev.slice();
      next[idx] = decision;
      return next;
    });
    // TODO(partial-write): replace with an IPC that writes just this hunk
    // to diff.filePath via a main-process handler.
  };
  const lang = languageFromPath(diff.filePath);
  return (
    <div className="mt-1 ml-6 rounded-sm border border-border-subtle overflow-hidden">
      <div className="px-3 py-1 bg-bg-elevated/60 border-b border-border-subtle font-mono text-mono-sm text-fg-tertiary">
        {diff.filePath}
      </div>
      <div className="font-mono text-xs">
        {diff.hunks.map((h, i) => {
          const decision = decisions[i];
          return (
            <div
              key={i}
              className={
                (i > 0 ? 'border-t border-border-subtle ' : '') +
                'relative group'
              }
            >
              <AnimatePresence>
                {decision === 'rejected' && (
                  <motion.div
                    key="rej-overlay"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 0.55 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.18, ease: [0, 0, 0.2, 1] }}
                    className="absolute inset-0 bg-bg-app pointer-events-none"
                    aria-hidden
                  />
                )}
              </AnimatePresence>
              {h.removed.map((line, j) => (
                <div
                  key={`r-${j}`}
                  className="grid grid-cols-[12px_1fr] bg-[oklch(0.55_0.18_27_/_0.10)] text-state-error-fg"
                >
                  <span aria-hidden className="pl-1 select-none text-state-error">-</span>
                  <span className="pr-2 font-mono">
                    {line ? <HighlightedLine code={line} language={lang} /> : '\u00A0'}
                  </span>
                </div>
              ))}
              {h.added.map((line, j) => (
                <div
                  key={`a-${j}`}
                  className="grid grid-cols-[12px_1fr] bg-[oklch(0.55_0.18_145_/_0.08)] text-fg-secondary"
                >
                  <span aria-hidden className="pl-1 select-none text-state-running">+</span>
                  <span className="pr-2 font-mono">
                    {line ? <HighlightedLine code={line} language={lang} /> : '\u00A0'}
                  </span>
                </div>
              ))}
              <div className="relative flex items-center justify-end gap-1.5 px-2 py-1 bg-bg-elevated/50 border-t border-border-subtle">
                <AnimatePresence mode="wait" initial={false}>
                  {decision ? (
                    <motion.span
                      key={`label-${decision}`}
                      initial={{ opacity: 0, y: 4 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -4 }}
                      transition={{ duration: 0.18, ease: [0, 0, 0.2, 1] }}
                      className={
                        'font-mono text-mono-xs uppercase tracking-wider ' +
                        (decision === 'accepted'
                          ? 'text-state-running'
                          : 'text-state-error')
                      }
                    >
                      {decision === 'accepted' ? t('chat.diffAccepted') : t('chat.diffRejected')}
                    </motion.span>
                  ) : (
                    <motion.div
                      key="buttons"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.15, ease: [0, 0, 0.2, 1] }}
                      className="flex items-center gap-1.5"
                    >
                      <button
                        type="button"
                        onClick={() => decide(i, 'rejected')}
                        className="px-2 py-0.5 rounded-sm border border-border-subtle text-mono-xs font-mono text-fg-tertiary hover:text-state-error hover:border-state-error/60 active:bg-bg-hover transition-colors duration-150 ease-out outline-none focus-visible:ring-1 focus-visible:ring-state-error/60"
                      >
                        {t('chat.diffReject')}
                      </button>
                      <button
                        type="button"
                        onClick={() => decide(i, 'accepted')}
                        className="px-2 py-0.5 rounded-sm border border-border-subtle text-mono-xs font-mono text-fg-tertiary hover:text-state-running hover:border-state-running/60 active:bg-bg-hover transition-colors duration-150 ease-out outline-none focus-visible:ring-1 focus-visible:ring-state-running/60"
                      >
                        {t('chat.diffAccept')}
                      </button>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PlanBlock({ plan, onAllow, onDeny }: { plan: string; onAllow?: () => void; onDeny?: () => void }) {
  const { t } = useTranslation();
  const approveRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const t = window.setTimeout(() => approveRef.current?.focus(), 150);
    return () => window.clearTimeout(t);
  }, []);

  return (
    <motion.div
      role="alertdialog"
      aria-modal="false"
      aria-labelledby="plan-title"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22, ease: [0.32, 0.72, 0, 1] }}
      className="relative my-2 rounded-md border border-state-waiting/40 bg-state-waiting/[0.06] surface-highlight surface-elevated pl-4 pr-4 py-3"
    >
      <span
        aria-hidden
        className="absolute left-0 top-0 bottom-0 w-[2px] bg-state-waiting rounded-l-md"
      />
      <div id="plan-title" className="flex items-center gap-2 text-base text-fg-primary font-semibold">
        <StateGlyph state="waiting" size="sm" />
        <span>{t('chat.planTitle')}</span>
      </div>
      <div className="mt-2 max-h-[420px] overflow-y-auto rounded-sm border border-border-subtle bg-bg-app/40 px-3 py-2">
        <div className="prose prose-invert prose-sm max-w-none font-mono text-sm text-fg-secondary [&_h1]:text-fg-primary [&_h2]:text-fg-primary [&_h3]:text-fg-primary [&_code]:text-fg-primary [&_pre]:bg-bg-elevated [&_pre]:rounded-sm">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{plan}</ReactMarkdown>
        </div>
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <Button variant="secondary" size="md" onClick={onDeny}>
          {t('chat.planReject')}
        </Button>
        <Button ref={approveRef} variant="primary" size="md" onClick={onAllow}>
          {t('chat.planApprove')}
        </Button>
      </div>
    </motion.div>
  );
}

function TodoBlock({ todos }: { todos: import('../types').TodoItem[] }) {
  const { t } = useTranslation();
  const total = todos.length;
  const done = todos.filter((t) => t.status === 'completed').length;
  return (
    <div className="my-1.5 rounded-md border border-border-subtle bg-bg-elevated/40 px-3 py-2">
      <div className="flex items-center justify-between mb-1.5">
        <span className="font-mono text-mono-sm uppercase tracking-wider text-fg-tertiary">{t('chat.todoLabel')}</span>
        <span className="font-mono text-mono-sm text-fg-tertiary">
          {done}/{total}
        </span>
      </div>
      <ul className="space-y-1">
        {todos.map((t, i) => {
          const inProgress = t.status === 'in_progress';
          const completed = t.status === 'completed';
          return (
            <li key={i} className="flex items-start gap-2 text-sm">
              <span
                aria-hidden
                className={
                  'mt-1 inline-flex h-3 w-3 shrink-0 items-center justify-center rounded-sm border ' +
                  (completed
                    ? 'bg-state-running border-state-running'
                    : inProgress
                    ? 'border-state-waiting'
                    : 'border-border-strong')
                }
              >
                {completed && (
                  <svg viewBox="0 0 12 12" className="h-2.5 w-2.5 text-bg-app" aria-hidden>
                    <path
                      d="M2.5 6.5L5 9l4.5-5"
                      stroke="currentColor"
                      strokeWidth="2"
                      fill="none"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                )}
                {inProgress && (
                  <span className="block h-1.5 w-1.5 rounded-full bg-state-waiting animate-pulse" />
                )}
              </span>
              <span
                className={
                  (completed ? 'text-fg-tertiary line-through ' : inProgress ? 'text-fg-primary ' : 'text-fg-secondary ') +
                  'min-w-0 flex-1'
                }
              >
                {inProgress && t.activeForm ? t.activeForm : t.content}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function StatusBanner({ tone, title, detail }: { tone: 'info' | 'warn'; title: string; detail?: string }) {
  const { t } = useTranslation();
  const isWarn = tone === 'warn';
  return (
    <div
      role="status"
      className={
        'relative my-1.5 rounded-md border pl-3 pr-3 py-1.5 text-xs ' +
        (isWarn
          ? 'border-state-waiting/40 bg-state-waiting/[0.06] text-fg-secondary'
          : 'border-border-subtle bg-bg-elevated/60 text-fg-tertiary')
      }
    >
      <span
        aria-hidden
        className={
          'absolute left-0 top-0 bottom-0 w-[2px] rounded-l-md ' +
          (isWarn ? 'bg-state-waiting' : 'bg-border-strong')
        }
      />
      <div className="flex items-baseline gap-2">
        <span className={'font-mono uppercase tracking-wider text-mono-xs ' + (isWarn ? 'text-state-waiting' : 'text-fg-tertiary')}>
          {isWarn ? t('chat.warnLabel') : t('chat.infoLabel')}
        </span>
        <span className={isWarn ? 'text-fg-primary' : 'text-fg-secondary'}>{title}</span>
        {detail && <span className="text-fg-tertiary">— {detail}</span>}
      </div>
    </div>
  );
}

function ErrorBlock({ text }: { text: string }) {
  const { t } = useTranslation();
  return (
    <div
      role="alert"
      className="relative my-1.5 rounded-md border border-state-error/40 bg-state-error-soft pl-3 pr-3 py-2 text-sm text-state-error-fg"
    >
      <span aria-hidden className="absolute left-0 top-0 bottom-0 w-[2px] bg-state-error rounded-l-md" />
      <div className="flex items-start gap-2">
        <AlertCircle size={14} className="text-state-error mt-0.5 shrink-0" aria-label={t('chat.errorLabel')} />
        <span className="whitespace-pre-wrap">{text}</span>
      </div>
    </div>
  );
}

/**
 * Read-only trace block left behind after the user resolves a permission
 * prompt. Replaces the original waiting block in place so the chat preserves
 * a scrollable record of allow/deny decisions (otherwise the prompt would
 * vanish without a trace and users couldn't audit what they approved).
 */
function SystemTraceBlock({
  subkind,
  toolName,
  toolInputSummary,
  decision
}: {
  subkind: 'permission-resolved';
  toolName: string;
  toolInputSummary: string;
  decision: 'allowed' | 'denied';
}) {
  // Only one subkind today; the discriminator exists so future system traces
  // (e.g. queued-message-cleared, autopilot-step) can land here without
  // schema churn.
  void subkind;
  const { t } = useTranslation();
  const denied = decision === 'denied';
  const label = denied ? t('chat.permResolvedDenied') : t('chat.permResolvedAllowed');
  return (
    <div
      role="status"
      data-system-trace="permission-resolved"
      data-decision={decision}
      className="relative my-1 rounded-sm border border-border-subtle bg-bg-elevated/40 pl-3 pr-3 py-1 text-xs text-fg-tertiary font-mono"
    >
      <span
        aria-hidden
        className={
          'absolute left-0 top-0 bottom-0 w-[2px] rounded-l-sm ' +
          (denied ? 'bg-state-error/70' : 'bg-state-running/70')
        }
      />
      <span className={denied ? 'text-state-error-fg' : 'text-fg-secondary'}>{label}</span>
      <span className="text-fg-tertiary">: </span>
      <span className="text-fg-secondary">{toolName}</span>
      {toolInputSummary && (
        <span className="text-fg-tertiary"> ({toolInputSummary})</span>
      )}
    </div>
  );
}

function renderBlock(
  b: MessageBlock,
  activeId: string,
  resolvePermission: (sid: string, rid: string, d: 'allow' | 'deny') => void,
  bumpComposerFocus: () => void,
  opts: { permissionAutoFocus?: boolean } = {}
) {
  switch (b.kind) {
    case 'user':
      return <UserBlock text={b.text} images={b.images} />;
    case 'assistant':
      return <AssistantBlock text={b.text} streaming={b.streaming} />;
    case 'tool':
      return <ToolBlock name={b.name} brief={b.brief} result={b.result} isError={b.isError} input={b.input} />;
    case 'todo':
      return <TodoBlock todos={b.todos} />;
    case 'waiting':
      if (b.intent === 'plan' && b.plan) {
        return (
          <PlanBlock
            plan={b.plan}
            onAllow={b.requestId ? () => resolvePermission(activeId, b.requestId!, 'allow') : undefined}
            onDeny={b.requestId ? () => resolvePermission(activeId, b.requestId!, 'deny') : undefined}
          />
        );
      }
      return (
        <PermissionPromptBlock
          prompt={b.prompt}
          toolName={b.toolName}
          toolInput={b.toolInput}
          autoFocus={opts.permissionAutoFocus ?? true}
          onAllow={b.requestId ? () => resolvePermission(activeId, b.requestId!, 'allow') : undefined}
          onReject={b.requestId ? () => resolvePermission(activeId, b.requestId!, 'deny') : undefined}
        />
      );
    case 'question':
      return (
        <QuestionBlock
          questions={b.questions}
          onSubmit={(answersText) => {
            const api = window.agentory;
            if (!api) return;
            // Two flows land here:
            //  1. can_use_tool path (SDK-era / possible future): answers the
            //     pending permission with "deny" and sends the answer as a
            //     fresh user message — slightly lossy but unblocks the turn.
            //  2. tool_use path (current claude.exe spawn): no requestId, the
            //     bogus tool_result has already landed, agent is waiting on
            //     the next user turn. Just send the answer text.
            if (b.requestId) {
              void api.agentResolvePermission(activeId, b.requestId, 'deny');
            }
            void api.agentSend(activeId, answersText);
            // Return focus to the composer so the user's next keystroke types
            // into chat instead of being eaten by the now-disabled options.
            bumpComposerFocus();
          }}
        />
      );
    case 'status':
      return <StatusBanner tone={b.tone} title={b.title} detail={b.detail} />;
    case 'system':
      return <SystemTraceBlock subkind={b.subkind} toolName={b.toolName} toolInputSummary={b.toolInputSummary} decision={b.decision} />;
    case 'error':
      return <ErrorBlock text={b.text} />;
  }
}

const EMPTY_BLOCKS: readonly MessageBlock[] = [];

function EmptyState() {
  const { t } = useTranslation();
  return (
    <div className="h-full flex items-center justify-center px-6">
      <div className="font-mono text-sm text-fg-tertiary">{t('chat.ready')}</div>
    </div>
  );
}

// Auto-follow heuristic: consider the user "at the bottom" if they're within
// this many pixels of the actual scrollHeight. Anything larger and we assume
// they've scrolled up intentionally and stop following.
const FOLLOW_THRESHOLD_PX = 32;

export function ChatStream() {
  const { t } = useTranslation();
  const activeId = useStore((s) => s.activeId);
  const blocks = useStore((s) => s.messagesBySession[activeId] ?? EMPTY_BLOCKS);
  const resolvePermission = useStore((s) => s.resolvePermission);
  const bumpComposerFocus = useStore((s) => s.bumpComposerFocus);
  const loadMessages = useStore((s) => s.loadMessages);

  const scrollRef = useRef<HTMLDivElement>(null);
  const followingRef = useRef(true);
  const [showJump, setShowJump] = useState(false);

  // Belt-and-suspenders: selectSession already triggers a load, but hot-reload
  // and other edge paths can change activeId without going through it.
  useEffect(() => {
    if (!activeId) return;
    const state = useStore.getState();
    if (!(activeId in state.messagesBySession)) void loadMessages(activeId);
  }, [activeId, loadMessages]);

  // Reset follow state when the active session changes.
  useEffect(() => {
    followingRef.current = true;
    setShowJump(false);
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [activeId]);

  // After every render that adds blocks, if we're still in follow mode, snap
  // to bottom synchronously to avoid the user briefly seeing the mid-stream
  // before the scroll catches up.
  useLayoutEffect(() => {
    if (!followingRef.current) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [blocks]);

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const atBottom = distanceFromBottom <= FOLLOW_THRESHOLD_PX;
    followingRef.current = atBottom;
    setShowJump(!atBottom && el.scrollHeight > el.clientHeight);
  }

  function jumpToLatest() {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    followingRef.current = true;
    setShowJump(false);
  }

  return (
    <div className="relative flex-1 min-h-0 min-w-0 flex flex-col">
      <div ref={scrollRef} onScroll={onScroll} data-chat-stream className="flex-1 overflow-y-auto min-w-0">
        {blocks.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="px-4 py-3 flex flex-col gap-1.5 max-w-[1100px]">
            {(() => {
              // Only the LAST pending permission block gets auto-focus. Older
              // ones (unlikely but possible) stay put so we don't rip focus
              // off the user mid-interaction.
              let lastPermIdx = -1;
              for (let i = blocks.length - 1; i >= 0; i--) {
                const b = blocks[i];
                if (b.kind === 'waiting' && b.intent === 'permission') {
                  lastPermIdx = i;
                  break;
                }
              }
              return blocks.map((m, i) => (
                <div key={m.id}>
                  {renderBlock(m, activeId, resolvePermission, bumpComposerFocus, {
                    permissionAutoFocus: i === lastPermIdx
                  })}
                </div>
              ));
            })()}
          </div>
        )}
      </div>
      <AnimatePresence>
        {showJump && (
          <motion.button
            key="jump"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.18, ease: [0.32, 0.72, 0, 1] }}
            onClick={jumpToLatest}
            className="absolute bottom-3 left-1/2 -translate-x-1/2 flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-bg-elevated border border-border-strong text-sm text-fg-primary shadow-md hover:bg-bg-hover transition-colors duration-150 ease-out"
            aria-label={t('chat.jumpToLatest')}
          >
            <ArrowDown size={14} />
            <span>{t('chat.jumpToLatest')}</span>
          </motion.button>
        )}
      </AnimatePresence>
    </div>
  );
}
