import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useTranslation } from '../../i18n/useTranslation';
import type { DiffSpec } from '../../utils/diff';
import { HighlightedLine, languageFromPath } from '../CodeBlock';

export function DiffView({ diff }: { diff: DiffSpec }) {
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
                        className="px-2 py-0.5 rounded-sm border border-border-subtle text-mono-xs font-mono text-fg-tertiary hover:text-state-error hover:border-state-error/60 active:bg-bg-hover transition-colors duration-150 ease-out outline-none focus-ring-destructive"
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
