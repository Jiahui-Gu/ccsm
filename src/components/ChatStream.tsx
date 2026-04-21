import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronRight, AlertCircle, ArrowDown } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { MessageBlock } from '../types';
import { useStore } from '../stores/store';
import { Button } from './ui/Button';
import { StateGlyph } from './ui/StateGlyph';
import { diffFromToolInput, type DiffSpec } from '../utils/diff';
import { FileTree } from './FileTree';
import { Terminal } from './Terminal';
import { CodeBlock, HighlightedLine, languageFromPath } from './CodeBlock';
import { QuestionBlock } from './QuestionBlock';
import { PermissionPromptBlock } from './PermissionPromptBlock';

const FILE_TREE_TOOLS = new Set(['Glob', 'LS']);

// Tool names whose output is a shell stream (raw text, often with ANSI
// escapes). We render these in xterm so colors/cursor moves render properly
// instead of leaking as literal `\u001b[...m` noise.
const SHELL_OUTPUT_TOOLS = new Set(['Bash', 'BashOutput']);

function UserBlock({ text }: { text: string }) {
  return (
    <div className="flex gap-3 text-base">
      <span className="text-fg-tertiary select-none w-3 shrink-0 font-mono">&gt;</span>
      <span className="text-fg-secondary whitespace-pre-wrap min-w-0">{text}</span>
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
              aria-label="tool failed"
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
          {isError && <span className="text-state-error/80 text-xs ml-1 uppercase tracking-wider">failed</span>}
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
            ) : (
              <pre
                className={`mt-1 ml-6 pl-3 border-l text-xs whitespace-pre-wrap font-mono ${
                  isError ? 'border-state-error/40 text-state-error-fg' : 'border-border-subtle text-fg-tertiary'
                }`}
              >
                {hasResult ? result : '(running…)'}
              </pre>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

const LONG_STRING_THRESHOLD = 200;

// Pretty-prints tool input with 2-space indent, subtle syntax coloring
// (keys vs strings vs other), and click-to-expand for long string values.
// Keeps the pre element copy-friendly: expanded content is inline plain text.
function PrettyInput({ input }: { input: unknown }) {
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
            className="ml-1.5 px-1 py-px rounded-sm border border-border-subtle text-[10px] text-fg-tertiary hover:text-fg-primary hover:border-border-strong active:bg-bg-hover transition-colors duration-150 ease-out outline-none focus-visible:ring-1 focus-visible:ring-border-strong"
            aria-expanded={false}
          >
            +{value.length - LONG_STRING_THRESHOLD} chars
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
            className="ml-1.5 px-1 py-px rounded-sm border border-border-subtle text-[10px] text-fg-tertiary hover:text-fg-primary hover:border-border-strong active:bg-bg-hover transition-colors duration-150 ease-out outline-none focus-visible:ring-1 focus-visible:ring-border-strong"
            aria-expanded={true}
          >
            collapse
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
        <span className="text-fg-tertiary text-[10px] uppercase tracking-wider mr-2">input</span>
        {render(input, 0, 'root')}
      </motion.pre>
    </AnimatePresence>
  );
}

function DiffView({ diff }: { diff: DiffSpec }) {
  // Per-hunk accept/reject state. `null` = pending, 'accepted' / 'rejected'
  // once the user acts. Today this is UI-only — the partial-write IPC back
  // to the main process is a follow-up (see PR body). Buttons emit
  // console.log so the shape of the event stream is easy to see in devtools
  // while that path is being wired up.
  const [decisions, setDecisions] = useState<Array<'accepted' | 'rejected' | null>>(
    () => diff.hunks.map(() => null)
  );
  const decide = (idx: number, decision: 'accepted' | 'rejected') => {
    setDecisions((prev) => {
      const next = prev.slice();
      next[idx] = decision;
      return next;
    });
    // TODO(partial-write): replace with an IPC that writes just this hunk to
    // diff.filePath via a main-process handler. Today we log so reviewers can
    // see the interaction working without the round-trip.
    console.log('[diff-hunk]', decision, { filePath: diff.filePath, hunkIndex: idx });
  };
  const lang = languageFromPath(diff.filePath);
  return (
    <div className="mt-1 ml-6 rounded-sm border border-border-subtle overflow-hidden">
      <div className="px-3 py-1 bg-bg-elevated/60 border-b border-border-subtle font-mono text-[11px] text-fg-tertiary">
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
                        'font-mono text-[10px] uppercase tracking-wider ' +
                        (decision === 'accepted'
                          ? 'text-state-running'
                          : 'text-state-error')
                      }
                    >
                      {decision}
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
                        className="px-2 py-0.5 rounded-sm border border-border-subtle text-[10px] font-mono text-fg-tertiary hover:text-state-error hover:border-state-error/60 active:bg-bg-hover transition-colors duration-150 ease-out outline-none focus-visible:ring-1 focus-visible:ring-state-error/60"
                      >
                        Reject
                      </button>
                      <button
                        type="button"
                        onClick={() => decide(i, 'accepted')}
                        className="px-2 py-0.5 rounded-sm border border-border-subtle text-[10px] font-mono text-fg-tertiary hover:text-state-running hover:border-state-running/60 active:bg-bg-hover transition-colors duration-150 ease-out outline-none focus-visible:ring-1 focus-visible:ring-state-running/60"
                      >
                        Accept
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
        <span>Plan ready for review</span>
      </div>
      <div className="mt-2 max-h-[420px] overflow-y-auto rounded-sm border border-border-subtle bg-bg-app/40 px-3 py-2">
        <div className="prose prose-invert prose-sm max-w-none font-mono text-sm text-fg-secondary [&_h1]:text-fg-primary [&_h2]:text-fg-primary [&_h3]:text-fg-primary [&_code]:text-fg-primary [&_pre]:bg-bg-elevated [&_pre]:rounded-sm">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{plan}</ReactMarkdown>
        </div>
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <Button variant="secondary" size="md" onClick={onDeny}>
          Reject
        </Button>
        <Button ref={approveRef} variant="primary" size="md" onClick={onAllow}>
          Approve plan
        </Button>
      </div>
    </motion.div>
  );
}

function TodoBlock({ todos }: { todos: import('../types').TodoItem[] }) {
  const total = todos.length;
  const done = todos.filter((t) => t.status === 'completed').length;
  return (
    <div className="my-1.5 rounded-md border border-border-subtle bg-bg-elevated/40 px-3 py-2">
      <div className="flex items-center justify-between mb-1.5">
        <span className="font-mono text-[11px] uppercase tracking-wider text-fg-tertiary">Todo</span>
        <span className="font-mono text-[11px] text-fg-tertiary">
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
        <span className={'font-mono uppercase tracking-wider text-[10px] ' + (isWarn ? 'text-state-waiting' : 'text-fg-tertiary')}>
          {isWarn ? 'WARN' : 'INFO'}
        </span>
        <span className={isWarn ? 'text-fg-primary' : 'text-fg-secondary'}>{title}</span>
        {detail && <span className="text-fg-tertiary">— {detail}</span>}
      </div>
    </div>
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


function renderBlock(
  b: MessageBlock,
  activeId: string,
  resolvePermission: (sid: string, rid: string, d: 'allow' | 'deny') => void,
  opts: { permissionAutoFocus?: boolean } = {}
) {
  switch (b.kind) {
    case 'user':
      return <UserBlock text={b.text} />;
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
          }}
        />
      );
    case 'status':
      return <StatusBanner tone={b.tone} title={b.title} detail={b.detail} />;
    case 'error':
      return <ErrorBlock text={b.text} />;
  }
}

const EMPTY_BLOCKS: readonly MessageBlock[] = [];

function EmptyState() {
  return (
    <div className="h-full flex items-center justify-center px-6">
      <div className="font-mono text-sm text-fg-tertiary">Ready when you are.</div>
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
                  {renderBlock(m, activeId, resolvePermission, {
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
