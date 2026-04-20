import React, { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronRight, AlertCircle } from 'lucide-react';
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
      <span className="text-fg-primary whitespace-pre-wrap min-w-0">{text}</span>
    </div>
  );
}

function ToolBlock({ name, brief, result }: { name: string; brief: string; result?: string }) {
  const [open, setOpen] = useState(false);
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
          <span className="text-fg-secondary group-hover:text-fg-primary transition-colors duration-150 ease-out">
            {name}
          </span>
          <span className="text-fg-tertiary text-xs">({brief})</span>
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
            <pre className="mt-1 ml-6 pl-3 border-l border-border-subtle text-fg-tertiary text-xs whitespace-pre-wrap font-mono">
              {result ?? '(no captured output yet)'}
            </pre>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// Module-level stack of mounted permission prompts. Only the top entry
// reacts to Esc — prevents stacked prompts from all denying simultaneously.
const denyStack: Array<() => void> = [];

if (typeof window !== 'undefined') {
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || denyStack.length === 0) return;
    e.preventDefault();
    denyStack[denyStack.length - 1]();
  });
}

function WaitingBlock({ prompt, onAllow, onDeny }: { prompt: string; onAllow?: () => void; onDeny?: () => void }) {
  // Permission prompts are destructive-by-default: focus lands on Deny so an
  // accidental Enter/Space doesn't grant access. Esc also denies. Focus is
  // delayed 150ms so the entrance animation settles before the ring lands.
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

function renderBlock(b: MessageBlock) {
  switch (b.kind) {
    case 'user':
      return <UserBlock text={b.text} />;
    case 'assistant':
      return <AssistantBlock text={b.text} />;
    case 'tool':
      return <ToolBlock name={b.name} brief={b.brief} result={b.result} />;
    case 'waiting':
      return <WaitingBlock prompt={b.prompt} />;
    case 'error':
      return <ErrorBlock text={b.text} />;
  }
}

const EMPTY_BLOCKS: readonly MessageBlock[] = [];

export function ChatStream() {
  const activeId = useStore((s) => s.activeId);
  const blocks = useStore((s) => s.messagesBySession[activeId] ?? EMPTY_BLOCKS);
  return (
    <div className="flex-1 overflow-y-auto min-w-0">
      <div className="px-4 py-3 flex flex-col gap-1.5 max-w-[1100px]">
        {blocks.map((m) => (
          <div key={m.id}>{renderBlock(m)}</div>
        ))}
      </div>
    </div>
  );
}
