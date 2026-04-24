import { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import * as Checkbox from '@radix-ui/react-checkbox';
import { Check, ChevronRight, MessageSquare, MessageSquarePlus, Trash2 } from 'lucide-react';
import { useTranslation } from '../../i18n/useTranslation';
import type { DiffSpec } from '../../utils/diff';
import { HighlightedLine, languageFromPath } from '../CodeBlock';
import { useStore } from '../../stores/store';
import type { PendingDiffComment } from '../../stores/store';

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

// Inline composer that opens below a diff line on "+" click (#303). Two-row
// textarea, Enter to save, Esc to dismiss. Save is also exposed as a button
// for mouse-only users / a11y. We deliberately don't autosize beyond two
// rows — feedback to the agent is meant to be a sentence, not a thesis.
function InlineCommentComposer({
  initialText,
  onSave,
  onCancel,
}: {
  initialText: string;
  onSave: (text: string) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState(initialText);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    // Defer focus a frame so the AnimatePresence height transition has
    // started — focusing into a 0-height element scrolls jankily on Chromium.
    const id = requestAnimationFrame(() => ref.current?.focus());
    return () => cancelAnimationFrame(id);
  }, []);
  const trimmed = value.trim();
  return (
    <div
      className="px-2 py-1.5 bg-bg-elevated border-t border-border-subtle"
      data-diff-comment-composer=""
      // Stop click bubbling so opening the composer doesn't also re-toggle
      // the file section header (the entire FileSection sits inside an
      // outer button-less div, but defensive against future refactors).
      onClick={(e) => e.stopPropagation()}
    >
      <textarea
        ref={ref}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            if (trimmed) onSave(trimmed);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            onCancel();
          }
        }}
        rows={2}
        placeholder={t('task303.diffCommentPlaceholder')}
        className="block w-full resize-none rounded-sm border border-border-default bg-bg-app px-2 py-1 text-meta font-sans text-fg-primary placeholder:text-fg-tertiary outline-none focus-visible:border-accent transition-colors duration-150 ease-out"
      />
      <div className="mt-1 flex items-center justify-end gap-1.5">
        <button
          type="button"
          onClick={onCancel}
          className="px-2 py-0.5 rounded-sm text-mono-xs font-mono text-fg-tertiary hover:text-fg-secondary active:bg-bg-hover transition-colors duration-150 ease-out outline-none focus-ring"
        >
          {t('common.cancel')}
        </button>
        <button
          type="button"
          disabled={!trimmed}
          onClick={() => trimmed && onSave(trimmed)}
          className="px-2 py-0.5 rounded-sm border border-border-subtle text-mono-xs font-mono text-fg-tertiary hover:text-accent hover:border-accent/60 active:bg-bg-hover transition-colors duration-150 ease-out outline-none focus-ring disabled:opacity-40 disabled:pointer-events-none"
        >
          {t('task303.diffCommentSave')}
        </button>
      </div>
    </div>
  );
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

  // ─── #303 per-line comments ─────────────────────────────────────────────
  // Composer state is local to the FileSection (only one composer can be
  // open per file at a time — opening a second one closes the first). The
  // saved comments live in the global store, scoped to the active session.
  // Keying by `lineIndex` (sequential within this FileSection across all
  // hunks, removed-then-added, matching DiffView's render order) means the
  // composer + chip stay attached to the line the user clicked, not to a
  // shifting source-file line number.
  const activeId = useStore((s) => s.activeId);
  const sessionComments = useStore((s) => s.pendingDiffComments[activeId]);
  const { addDiffComment, updateDiffComment, deleteDiffComment } = useStore.getState();
  // Bucket the saved comments by lineIndex for O(1) per-row lookup. We
  // recompute on every render — diff comment counts in a single file are
  // tiny (typically 0–3) so the cost is irrelevant compared to the
  // syntax-highlighting work happening on the same lines.
  const commentsForFile: Record<number, PendingDiffComment> = {};
  if (sessionComments) {
    for (const c of Object.values(sessionComments)) {
      // Encode `(file, line)` as the row key on save; here we just match
      // back. lineIndex is stored as `line`; file path must match exactly.
      if (c.file === spec.filePath) commentsForFile[c.line] = c;
    }
  }
  // Composer opens on a specific lineIndex. `null` = no composer open.
  // Note: opening the composer for a line that already has a comment puts
  // the composer into edit mode (initialText preloaded from the comment).
  const [composerLine, setComposerLine] = useState<number | null>(null);
  const openComposer = (lineIndex: number) => {
    setComposerLine((prev) => (prev === lineIndex ? null : lineIndex));
  };
  const commitComment = (lineIndex: number, text: string) => {
    const existing = commentsForFile[lineIndex];
    if (existing) {
      updateDiffComment(activeId, existing.id, text);
    } else if (activeId) {
      addDiffComment(activeId, { file: spec.filePath, line: lineIndex, text });
    }
    setComposerLine(null);
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
              {(() => {
                // Sequential line counter across all hunks of this file —
                // the unit we attach comments to. Reset per-FileSection so
                // it never collides across files in a multi-file render.
                let lineIndex = 0;
                return spec.hunks.map((h, i) => {
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
                    {h.removed.map((line, j) => {
                      const myLine = lineIndex++;
                      const comment = commentsForFile[myLine];
                      const composerOpen = composerLine === myLine;
                      return (
                        <DiffLineRow
                          key={`r-${j}`}
                          tone="removed"
                          line={line}
                          lang={lang}
                          comment={comment}
                          composerOpen={composerOpen}
                          onOpenComposer={() => openComposer(myLine)}
                          onSaveComment={(text) => commitComment(myLine, text)}
                          onCancelComposer={() => setComposerLine(null)}
                          onDeleteComment={() => {
                            if (comment && activeId) deleteDiffComment(activeId, comment.id);
                          }}
                        />
                      );
                    })}
                    {h.added.map((line, j) => {
                      const myLine = lineIndex++;
                      const comment = commentsForFile[myLine];
                      const composerOpen = composerLine === myLine;
                      return (
                        <DiffLineRow
                          key={`a-${j}`}
                          tone="added"
                          line={line}
                          lang={lang}
                          comment={comment}
                          composerOpen={composerOpen}
                          onOpenComposer={() => openComposer(myLine)}
                          onSaveComment={(text) => commitComment(myLine, text)}
                          onCancelComposer={() => setComposerLine(null)}
                          onDeleteComment={() => {
                            if (comment && activeId) deleteDiffComment(activeId, comment.id);
                          }}
                        />
                      );
                    })}
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
              });
              })()}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// One rendered diff line + its (optional) inline comment composer / chip
// affordance (#303). Pulled out of FileSection so the +/chip/composer logic
// lives next to the row markup it decorates, rather than ballooning the
// hunk-loop inline.
//
// Layout per row: gutter (12px) + line content. The hover affordance lives
// inside the gutter, absolutely positioned over the +/- glyph, so it doesn't
// shift the line content when it appears. When a comment is saved we leave
// the chip visible to the right of the line content; when the composer is
// open we render it directly below the line.
function DiffLineRow({
  tone,
  line,
  lang,
  comment,
  composerOpen,
  onOpenComposer,
  onSaveComment,
  onCancelComposer,
  onDeleteComment,
}: {
  tone: 'removed' | 'added';
  line: string;
  lang: string;
  comment: PendingDiffComment | undefined;
  composerOpen: boolean;
  onOpenComposer: () => void;
  onSaveComment: (text: string) => void;
  onCancelComposer: () => void;
  onDeleteComment: () => void;
}) {
  const { t } = useTranslation();
  const tonePalette =
    tone === 'removed'
      ? 'bg-[oklch(0.55_0.18_27_/_0.10)] text-state-error-fg'
      : 'bg-[oklch(0.55_0.18_145_/_0.08)] text-fg-secondary';
  const glyphTone = tone === 'removed' ? 'text-state-error' : 'text-state-running';
  const glyph = tone === 'removed' ? '-' : '+';
  return (
    <>
      <div
        className={`group/row relative grid grid-cols-[12px_1fr_auto] items-center ${tonePalette}`}
        data-diff-line=""
        data-diff-line-tone={tone}
      >
        {/* Gutter: shows the diff sign by default; on row hover (or when
            this row already owns a comment / composer), the +-comment
            button overlays it. We keep both glyphs in the same 12px column
            so the line content never shifts. */}
        <span className="relative pl-1 select-none">
          {/* Default sign — visually hidden when the action button is up. */}
          <span
            aria-hidden
            className={`${glyphTone} ${composerOpen || comment ? 'opacity-0' : 'group-hover/row:opacity-0'} transition-opacity duration-150`}
          >
            {glyph}
          </span>
          <button
            type="button"
            onClick={onOpenComposer}
            aria-label={
              comment
                ? t('task303.diffEditCommentAria')
                : t('task303.diffAddCommentAria')
            }
            data-diff-add-comment=""
            className={`absolute inset-0 inline-flex items-center justify-center text-fg-tertiary hover:text-accent transition-opacity duration-150 outline-none focus-visible:opacity-100 focus-ring rounded-sm ${
              composerOpen || comment ? 'opacity-100' : 'opacity-0 group-hover/row:opacity-100'
            }`}
          >
            <MessageSquarePlus size={10} className="stroke-[2]" />
          </button>
        </span>
        <span className="pr-2 font-mono min-w-0 truncate">
          {line ? <HighlightedLine code={line} language={lang} /> : '\u00A0'}
        </span>
        {/* Saved-comment chip. Click → reopen composer in edit mode (the
            FileSection toggles composerLine on the same lineIndex). */}
        {comment && !composerOpen && (
          <button
            type="button"
            onClick={onOpenComposer}
            data-diff-comment-chip=""
            title={comment.text}
            aria-label={t('task303.diffEditCommentAria')}
            className="mr-2 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-sm border border-border-subtle bg-bg-elevated text-fg-tertiary hover:text-fg-secondary hover:border-border-default transition-colors duration-150 ease-out outline-none focus-ring text-mono-xs font-mono"
          >
            <MessageSquare size={10} className="stroke-[2]" />
            <span className="max-w-[14ch] truncate">{comment.text}</span>
          </button>
        )}
      </div>
      <AnimatePresence initial={false}>
        {composerOpen && (
          <motion.div
            key="composer"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.16, ease: [0, 0, 0.2, 1] }}
            className="overflow-hidden"
          >
            <div className="relative">
              <InlineCommentComposer
                initialText={comment?.text ?? ''}
                onSave={onSaveComment}
                onCancel={onCancelComposer}
              />
              {comment && (
                <button
                  type="button"
                  onClick={onDeleteComment}
                  data-diff-comment-delete=""
                  aria-label={t('task303.diffDeleteCommentAria')}
                  className="absolute right-2 top-1.5 inline-flex h-5 w-5 items-center justify-center rounded-sm text-fg-tertiary hover:text-state-error hover:bg-bg-hover transition-colors duration-150 ease-out outline-none focus-ring-destructive"
                >
                  <Trash2 size={11} className="stroke-[2]" />
                </button>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
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
