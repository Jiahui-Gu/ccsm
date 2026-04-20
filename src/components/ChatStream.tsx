import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronRight, AlertCircle, ArrowDown } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { MessageBlock } from '../types';
import { useStore } from '../stores/store';
import { Button } from './ui/Button';
import { StateGlyph } from './ui/StateGlyph';

function UserBlock({ text }: { text: string }) {
  return (
    <div className="flex gap-3 text-base">
      <span className="text-fg-tertiary select-none w-3 shrink-0 font-mono">&gt;</span>
      <span className="text-fg-secondary whitespace-pre-wrap min-w-0">{text}</span>
    </div>
  );
}

function AssistantBlock({ text }: { text: string }) {
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
              return (
                <code className={className} {...rest}>
                  {children}
                </code>
              );
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
      </div>
    </div>
  );
}

function ToolBlock({
  name,
  brief,
  result,
  isError
}: {
  name: string;
  brief: string;
  result?: string;
  isError?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const hasResult = typeof result === 'string';
  return (
    <div className="font-mono text-sm">
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
            <ChevronRight size={11} className="stroke-[1.75] -ml-px" />
          </motion.span>
        </span>
        <span className="min-w-0 truncate">
          <span
            className={
              isError
                ? 'text-state-error group-hover:text-state-error transition-colors duration-150 ease-out'
                : 'text-fg-secondary group-hover:text-fg-primary transition-colors duration-150 ease-out'
            }
          >
            {name}
          </span>
          <span className="text-fg-tertiary text-xs">({brief})</span>
          {!hasResult && <span className="text-fg-tertiary text-xs ml-2">…</span>}
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
            <pre
              className={`mt-1 ml-6 pl-3 border-l text-xs whitespace-pre-wrap font-mono ${
                isError ? 'border-state-error/40 text-state-error-fg' : 'border-border-subtle text-fg-tertiary'
              }`}
            >
              {hasResult ? result : '(running…)'}
            </pre>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

const denyStack: Array<() => void> = [];

if (typeof window !== 'undefined') {
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || denyStack.length === 0) return;
    e.preventDefault();
    denyStack[denyStack.length - 1]();
  });
}

function WaitingBlock({ prompt, onAllow, onDeny }: { prompt: string; onAllow?: () => void; onDeny?: () => void }) {
  const denyRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const t = window.setTimeout(() => denyRef.current?.focus(), 150);
    const handler = () => onDeny?.();
    denyStack.push(handler);
    return () => {
      window.clearTimeout(t);
      const i = denyStack.lastIndexOf(handler);
      if (i !== -1) denyStack.splice(i, 1);
    };
  }, [onDeny]);

  return (
    <motion.div
      role="alertdialog"
      aria-modal="false"
      aria-labelledby="perm-title"
      aria-describedby="perm-desc"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22, ease: [0.32, 0.72, 0, 1] }}
      className="relative my-2 rounded-md border border-state-waiting/40 bg-state-waiting/[0.06] surface-highlight surface-elevated pl-4 pr-4 py-3"
    >
      <span
        aria-hidden
        className="absolute left-0 top-0 bottom-0 w-[2px] bg-state-waiting rounded-l-md"
      />
      <div id="perm-title" className="flex items-center gap-2 text-base text-fg-primary font-semibold">
        <StateGlyph state="waiting" size="sm" />
        <span>Permission requested</span>
      </div>
      <div id="perm-desc" className="mt-1.5 font-mono text-sm text-fg-secondary">{prompt}</div>
      <div className="mt-3 flex justify-end gap-2">
        <Button ref={denyRef} variant="secondary" size="md" onClick={onDeny}>
          Deny
        </Button>
        <Button variant="primary" size="md" onClick={onAllow}>
          Allow
        </Button>
      </div>
    </motion.div>
  );
}

function ErrorBlock({ text }: { text: string }) {
  return (
    <div
      role="alert"
      className="relative my-1.5 rounded-md border border-state-error/40 bg-state-error-soft pl-3 pr-3 py-2 text-sm text-state-error-fg"
    >
      <span aria-hidden className="absolute left-0 top-0 bottom-0 w-[2px] bg-state-error rounded-l-md" />
      <div className="flex items-start gap-2">
        <AlertCircle size={14} className="text-state-error mt-0.5 shrink-0" aria-label="error" />
        <span className="whitespace-pre-wrap">{text}</span>
      </div>
    </div>
  );
}

function renderBlock(b: MessageBlock, activeId: string, resolvePermission: (sid: string, rid: string, d: 'allow' | 'deny') => void) {
  switch (b.kind) {
    case 'user':
      return <UserBlock text={b.text} />;
    case 'assistant':
      return <AssistantBlock text={b.text} />;
    case 'tool':
      return <ToolBlock name={b.name} brief={b.brief} result={b.result} isError={b.isError} />;
    case 'waiting':
      return (
        <WaitingBlock
          prompt={b.prompt}
          onAllow={b.requestId ? () => resolvePermission(activeId, b.requestId!, 'allow') : undefined}
          onDeny={b.requestId ? () => resolvePermission(activeId, b.requestId!, 'deny') : undefined}
        />
      );
    case 'error':
      return <ErrorBlock text={b.text} />;
  }
}

const EMPTY_BLOCKS: readonly MessageBlock[] = [];

function EmptyState() {
  return (
    <div className="h-full flex items-center justify-center px-6">
      <div className="font-mono text-sm text-fg-tertiary select-none">Ready when you are.</div>
    </div>
  );
}

// Auto-follow heuristic: consider the user "at the bottom" if they're within
// this many pixels of the actual scrollHeight. Anything larger and we assume
// they've scrolled up intentionally and stop following.
const FOLLOW_THRESHOLD_PX = 32;

export function ChatStream() {
  const activeId = useStore((s) => s.activeId);
  const blocks = useStore((s) => s.messagesBySession[activeId] ?? EMPTY_BLOCKS);
  const resolvePermission = useStore((s) => s.resolvePermission);

  const scrollRef = useRef<HTMLDivElement>(null);
  const followingRef = useRef(true);
  const [showJump, setShowJump] = useState(false);

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
      <div ref={scrollRef} onScroll={onScroll} className="flex-1 overflow-y-auto min-w-0">
        {blocks.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="px-4 py-3 flex flex-col gap-1.5 max-w-[1100px]">
            {blocks.map((m) => (
              <div key={m.id}>{renderBlock(m, activeId, resolvePermission)}</div>
            ))}
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
            aria-label="Jump to latest"
          >
            <ArrowDown size={14} />
            <span>Jump to latest</span>
          </motion.button>
        )}
      </AnimatePresence>
    </div>
  );
}
