import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronRight } from 'lucide-react';
import { useTranslation } from '../../i18n/useTranslation';
import type { DiffSpec } from '../../utils/diff';
import { HighlightedLine, languageFromPath } from '../CodeBlock';

// Threshold above which multi-file diffs default to collapsed sections.
// Picked at 3 to keep the common Edit/Write/MultiEdit case (almost always
// 1 file) fully expanded while taming the unscannable 5+ file MultiEdit /
// scripted multi-tool batches reported in #249.
const DEFAULT_COLLAPSE_THRESHOLD = 3;

function countChanges(spec: DiffSpec): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const h of spec.hunks) {
    added += h.added.length;
    removed += h.removed.length;
  }
  return { added, removed };
}

interface FileSectionProps {
  spec: DiffSpec;
  expanded: boolean;
  onToggle: () => void;
}

// One file's worth of hunks. Header chip = chevron + path + +N/-M counts;
// body holds the hunk grid + per-hunk Accept/Reject (preserved from the
// pre-#302 single-file layout so the in-flight #306 hunk-selection PR can
// land on top without conflict).
function FileSection({ spec, expanded, onToggle }: FileSectionProps) {
  const { t } = useTranslation();
  const lang = languageFromPath(spec.filePath);
  const { added, removed } = countChanges(spec);
  // Per-hunk accept/reject state lives at the section level so it survives
  // collapse/expand within the same render lifecycle.
  const [decisions, setDecisions] = useState<Array<'accepted' | 'rejected' | null>>(
    () => spec.hunks.map(() => null)
  );
  const decide = (idx: number, decision: 'accepted' | 'rejected') => {
    setDecisions((prev) => {
      const next = prev.slice();
      next[idx] = decision;
      return next;
    });
    // TODO(partial-write): replace with an IPC that writes just this hunk
    // to spec.filePath via a main-process handler.
  };
  return (
    <div className="border-b last:border-b-0 border-border-subtle">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-label={t('chat.diffFileToggleAria', { path: spec.filePath })}
        className="group flex items-center gap-2 w-full text-left px-3 py-1 bg-bg-elevated/60 text-fg-tertiary hover:text-fg-secondary transition-colors duration-150 ease-out outline-none focus-ring"
      >
        <span className="w-3 shrink-0 flex items-center">
          <motion.span
            initial={false}
            animate={{ rotate: expanded ? 90 : 0 }}
            transition={{ duration: 0.2, ease: [0, 0, 0.2, 1] }}
            className="inline-flex"
          >
            <ChevronRight size={11} className="stroke-[1.75] -ml-px" />
          </motion.span>
        </span>
        <span
          className="min-w-0 flex-1 truncate font-mono text-mono-sm"
          title={spec.filePath}
        >
          {spec.filePath}
        </span>
        <span
          className="shrink-0 font-mono text-mono-xs tabular-nums"
          aria-label={t('chat.diffCountsAria', { added, removed })}
        >
          <span className="text-state-running">+{added}</span>
          <span className="text-fg-tertiary"> / </span>
          <span className="text-state-error">-{removed}</span>
        </span>
      </button>
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            key="content"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: [0, 0, 0.2, 1] }}
            className="overflow-hidden"
          >
            <div className="font-mono text-meta">
              {spec.hunks.map((h, i) => {
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
                              className="px-2 py-0.5 rounded-sm border border-border-subtle text-mono-xs font-mono text-fg-tertiary hover:text-state-error hover:border-state-error/60 active:bg-bg-hover transition-colors duration-150 ease-out outline-none focus-ring-destructive"
                            >
                              {t('chat.diffReject')}
                            </button>
                            <button
                              type="button"
                              onClick={() => decide(i, 'accepted')}
                              className="px-2 py-0.5 rounded-sm border border-border-subtle text-mono-xs font-mono text-fg-tertiary hover:text-state-running hover:border-state-running/60 active:bg-bg-hover transition-colors duration-150 ease-out outline-none focus-ring-success"
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
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export interface DiffViewProps {
  // Either a single file's diff (current callers — preserved) or an array of
  // per-file specs. The array form is what enables per-file collapse for the
  // multi-file render path; the single form keeps the existing tool-block
  // contract intact.
  diff: DiffSpec | DiffSpec[];
}

export function DiffView({ diff }: DiffViewProps) {
  const specs = Array.isArray(diff) ? diff : [diff];
  // Default expansion: keep small batches fully open; collapse large ones so
  // the user sees the file list before paying for syntax highlighting.
  const defaultExpanded = specs.length <= DEFAULT_COLLAPSE_THRESHOLD;
  const [expandedMap, setExpandedMap] = useState<Record<number, boolean>>(() => {
    const init: Record<number, boolean> = {};
    for (let i = 0; i < specs.length; i++) init[i] = defaultExpanded;
    return init;
  });
  const toggle = (idx: number) => {
    setExpandedMap((prev) => ({ ...prev, [idx]: !prev[idx] }));
  };
  return (
    <div
      data-testid="diff-view"
      data-file-count={specs.length}
      className="mt-1 ml-6 rounded-sm border border-border-subtle overflow-hidden"
    >
      {specs.map((spec, i) => (
        <FileSection
          key={`${spec.filePath}-${i}`}
          spec={spec}
          expanded={expandedMap[i] ?? defaultExpanded}
          onToggle={() => toggle(i)}
        />
      ))}
    </div>
  );
}
