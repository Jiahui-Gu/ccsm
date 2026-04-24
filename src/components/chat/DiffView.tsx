import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import * as Checkbox from '@radix-ui/react-checkbox';
import { Check, ChevronRight } from 'lucide-react';
import { useTranslation } from '../../i18n/useTranslation';
import type { DiffSpec } from '../../utils/diff';
import { HighlightedLine, languageFromPath } from '../CodeBlock';

// Threshold above which multi-file diffs default to collapsed sections (#249).
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
  /**
   * When provided (#306), switches the per-hunk action UI from the legacy
   * accept/reject buttons (UI-only acknowledgement of an already-applied
   * change) to a checkbox-driven selection. The parent (PermissionPromptBlock)
   * owns `selection` and is notified of every toggle so it can wire the
   * result into `agentResolvePermissionPartial`.
   *
   * Selection semantics: indices are hunks within THIS file's spec.hunks.
   * Default state should be "all checked" so the prompt's primary button
   * matches today's whole-allow behavior on first interaction.
   */
  selection?: Set<number>;
  onSelectionChange?: (next: Set<number>) => void;
  /** Disable interaction (e.g. while the parent is resolving the IPC). */
  disabled?: boolean;
}

// One file's worth of hunks. Header chip = chevron + path + +N/-M counts (#249);
// body holds the hunk grid + per-hunk Accept/Reject (legacy) OR per-hunk
// checkboxes (#306 select mode).
function FileSection({
  spec,
  expanded,
  onToggle,
  selection,
  onSelectionChange,
  disabled,
}: FileSectionProps) {
  const { t } = useTranslation();
  const lang = languageFromPath(spec.filePath);
  const { added, removed } = countChanges(spec);
  const selectMode = !!selection && !!onSelectionChange;
  // Per-hunk accept/reject state lives at the section level so it survives
  // collapse/expand within the same render lifecycle. Used only in legacy
  // (non-select) mode.
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
  const toggleHunk = (idx: number) => {
    if (!selection || !onSelectionChange) return;
    const next = new Set(selection);
    if (next.has(idx)) {
      next.delete(idx);
    } else {
      next.add(idx);
    }
    onSelectionChange(next);
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
                const isChecked = selectMode ? selection!.has(i) : false;
                return (
                  <div
                    key={i}
                    className={
                      (i > 0 ? 'border-t border-border-subtle ' : '') +
                      'relative group'
                    }
                  >
                    <AnimatePresence>
                      {/* Legacy mode: dim a rejected hunk. Select mode: dim
                          when unchecked so the user can see at a glance
                          which hunks won't be applied. */}
                      {(decision === 'rejected' || (selectMode && !isChecked)) && (
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
                      {selectMode ? (
                        <label
                          className="flex items-center gap-2 select-none cursor-pointer text-mono-xs font-mono text-fg-tertiary hover:text-fg-secondary transition-colors duration-150"
                          data-perm-hunk-row=""
                        >
                          <Checkbox.Root
                            checked={isChecked}
                            disabled={disabled}
                            onCheckedChange={() => toggleHunk(i)}
                            data-perm-hunk-checkbox=""
                            data-perm-hunk-index={i}
                            aria-label={t('permissionPrompt.hunkLabel', { n: i + 1 })}
                            className="h-3.5 w-3.5 shrink-0 rounded-sm border border-border-strong data-[state=checked]:bg-accent data-[state=checked]:border-accent outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            <Checkbox.Indicator className="flex items-center justify-center text-bg-app">
                              <Check size={10} strokeWidth={3} />
                            </Checkbox.Indicator>
                          </Checkbox.Root>
                          <span className="uppercase tracking-wider">
                            {t('permissionPrompt.hunkLabel', { n: i + 1 })}
                          </span>
                        </label>
                      ) : (
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
                      )}
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
  // multi-file render path (#249); the single form keeps the existing
  // tool-block contract intact.
  diff: DiffSpec | DiffSpec[];
  /**
   * Per-hunk selection (#306). Only meaningful for the single-file form
   * (PermissionPromptBlock is the sole caller). When provided, the file's
   * FileSection switches into checkbox-driven select mode. For the
   * multi-file form these props are ignored — multi-file partial selection
   * is not a supported flow today.
   */
  selection?: Set<number>;
  onSelectionChange?: (next: Set<number>) => void;
  disabled?: boolean;
}

export function DiffView({ diff, selection, onSelectionChange, disabled }: DiffViewProps) {
  const specs = Array.isArray(diff) ? diff : [diff];
  const isSingle = !Array.isArray(diff);
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
          // Per-hunk select mode is single-file only (PermissionPromptBlock).
          selection={isSingle ? selection : undefined}
          onSelectionChange={isSingle ? onSelectionChange : undefined}
          disabled={isSingle ? disabled : undefined}
        />
      ))}
    </div>
  );
}
