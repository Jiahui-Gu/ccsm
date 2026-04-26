import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { Check, X } from 'lucide-react';
import type { QuestionSpec } from '../types';
import { useTranslation } from '../i18n/useTranslation';
import { DURATION_RAW, EASING } from '../lib/motion';

/**
 * AskUserQuestion sticky widget.
 *
 * Mirrors the upstream Claude VS Code extension component (`o30` in
 * webview/index.js, around line 1519): a single sticky card that floats
 * above the composer while at least one question in the current
 * AskUserQuestion call is unanswered. Multiple questions inside the same
 * call are paged via chip tabs at the top, with ←/→ to navigate questions
 * and ↑/↓ to move between options inside the active question.
 *
 * Behaviors implemented (one-to-one with upstream):
 *  - Top chip-tab bar lists every question in the call. The active tab
 *    has a stronger ring; tabs with at least one selected option are
 *    marked "answered" (subtler accent).
 *  - ←/→ pages question (clamped at the ends).
 *  - ↑/↓ moves option focus inside the active question (loops at edges).
 *  - Single-select: clicking an option sets it AND, if this isn't the
 *    last question, schedules a 300ms "confirming" highlight then auto-
 *    advances to the next question (matches upstream's optionConfirming
 *    timing, line 1519).
 *  - Multi-select: clicking toggles the option, never auto-advances.
 *  - We always append a synthetic "Other" option (last). Selecting it
 *    expands an inline contenteditable input. Submission swaps the
 *    literal "Other" label for the user's typed text.
 *  - Submit fires only when EVERY question has at least one option
 *    selected (or "Other" with non-empty text).
 *  - Submit payload: `answers[question] = labels.join("\n ")`, with the
 *    literal "Other" replaced by the user's typed text. Newline-space
 *    separator matches upstream so multi-select answers render naturally
 *    in the assistant's tool_result body.
 *  - Esc anywhere inside the widget invokes `onReject` — the can_use_tool
 *    permission is denied and no answer is sent.
 */

export interface QuestionBlockProps {
  questions: QuestionSpec[];
  /**
   * Receives the per-question answer map: keys are the original `question`
   * strings, values are the labels (Other replaced with the typed text)
   * joined by `"\n "`. Caller routes this to `agentSend` (and resolves
   * any pending permission as deny first).
   */
  onSubmit: (answersByQuestion: Record<string, string>) => void;
  /**
   * Esc / explicit close — caller must reject the pending can_use_tool
   * promise (no follow-up agentSend). Optional so older callers (tests)
   * can omit it.
   */
  onReject?: () => void;
  /** When false, the widget will not auto-focus its first option on mount. */
  autoFocus?: boolean;
}

const OTHER_LABEL = 'Other';
const ANSWER_JOIN = '\n ';
const AUTO_ADVANCE_MS = 300;

export function QuestionBlock({ questions, onSubmit, onReject, autoFocus = true }: QuestionBlockProps) {
  const { t } = useTranslation();

  // Page index (active question).
  const [active, setActive] = useState(0);
  // Per-question selection set. Key = question.question, value = Set of
  // labels (NOT indices — matches upstream's `selectedAnswers` shape; lets
  // "Other" coexist with named options without index tricks).
  const [picks, setPicks] = useState<Record<string, Set<string>>>(() => {
    const init: Record<string, Set<string>> = {};
    for (const q of questions) init[q.question] = new Set();
    return init;
  });
  // Per-question free-text for the synthetic "Other" option.
  const [otherText, setOtherText] = useState<Record<string, string>>({});
  // Transient highlight on the option that triggered an auto-advance.
  const [confirming, setConfirming] = useState<string | null>(null);
  // While the inline Other input has focus, suppress arrow-key handling so
  // typing arrows inside the input doesn't page the widget.
  const [otherFocused, setOtherFocused] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const rootRef = useRef<HTMLDivElement>(null);
  const optionsRef = useRef<HTMLDivElement>(null);
  const otherInputRef = useRef<HTMLDivElement>(null);

  const current = questions[active];

  const isSelected = useCallback(
    (label: string) => picks[current?.question ?? '']?.has(label) === true,
    [picks, current?.question]
  );

  // Whether every question has at least one valid selection (Other counts
  // only when the typed text is non-empty).
  const allAnswered = useMemo(() => {
    for (const q of questions) {
      const set = picks[q.question];
      if (!set || set.size === 0) return false;
      if (set.has(OTHER_LABEL)) {
        const txt = otherText[q.question]?.trim() ?? '';
        if (!txt && set.size === 1) return false;
      }
    }
    return true;
  }, [questions, picks, otherText]);

  // Build the submit payload per upstream:
  //   answers[question] = labels.join("\n "), Other → typed text.
  const buildAnswers = useCallback((): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const q of questions) {
      const set = picks[q.question];
      if (!set || set.size === 0) continue;
      const labels = Array.from(set);
      const final = labels
        .map((l) => (l === OTHER_LABEL ? otherText[q.question]?.trim() || '' : l))
        .filter(Boolean);
      if (final.length === 0) continue;
      out[q.question] = final.join(ANSWER_JOIN);
    }
    return out;
  }, [questions, picks, otherText]);

  const submit = useCallback(() => {
    if (!allAnswered || submitted) return;
    setSubmitted(true);
    onSubmit(buildAnswers());
  }, [allAnswered, submitted, onSubmit, buildAnswers]);

  // Auto-focus first option of the active question on mount + on every page
  // change. Mirrors upstream's "切题自动 focus 第一个" behavior.
  //
  // Task #291 — we DO steal focus from the composer textarea on mount. The
  // question card is the dominant interaction surface once it appears; the
  // composer draft is a controlled value, so taking focus doesn't lose what
  // the user typed. The only thing we still respect is focus already living
  // INSIDE the question (e.g. a freshly-mounted "Other" contenteditable)
  // because re-running on `active` change shouldn't yank focus off something
  // the user is currently typing into.
  useEffect(() => {
    if (!autoFocus || submitted) return;
    const root = optionsRef.current;
    if (!root) return;
    const id = requestAnimationFrame(() => {
      const target = root.querySelector<HTMLElement>('[data-question-option]');
      if (!target) return;
      const ae = document.activeElement as HTMLElement | null;
      // Don't steal focus from an element already inside the options group —
      // covers the inline "Other" contenteditable that a previous interaction
      // moved focus to. Composer textarea / external inputs are NOT exempt:
      // when the question mounts, it takes over.
      if (ae && root.contains(ae) && ae !== target) return;
      target.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(id);
  }, [active, autoFocus, submitted]);

  // ---- Selection + auto-advance -------------------------------------------
  const togglePick = useCallback(
    (q: QuestionSpec, label: string) => {
      if (submitted) return;
      // Compute the "fresh selection" signal BEFORE the setPicks call. The
      // updater fn passed to setState runs during the next render commit,
      // not synchronously when set is called — reading a `let` flag set
      // INSIDE the updater on the line below would always observe the
      // initial `false` value (the auto-advance condition would silently
      // never fire in production). Tests masked this because RTL's
      // fireEvent flushes updaters synchronously inside `act`, but real
      // browser dispatch defers them. Read from current picks instead.
      const didSelectFresh = !q.multiSelect && !(picks[q.question]?.has(label) ?? false);
      setPicks((prev) => {
        const next = { ...prev };
        const set = new Set(next[q.question] ?? []);
        if (q.multiSelect) {
          if (set.has(label)) set.delete(label);
          else set.add(label);
        } else {
          set.clear();
          set.add(label);
        }
        next[q.question] = set;
        return next;
      });
      if (label === OTHER_LABEL) {
        setTimeout(() => otherInputRef.current?.focus(), 0);
      }
      if (
        !q.multiSelect &&
        didSelectFresh &&
        label !== OTHER_LABEL &&
        active < questions.length - 1 &&
        confirming === null
      ) {
        setConfirming(label);
        setTimeout(() => {
          setConfirming(null);
          setActive((a) => Math.min(a + 1, questions.length - 1));
        }, AUTO_ADVANCE_MS);
      }
    },
    [active, confirming, picks, questions.length, submitted]
  );

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (submitted) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onReject?.();
      return;
    }
    if (otherFocused) return;
    if (e.key === 'ArrowLeft' && active > 0) {
      e.preventDefault();
      e.stopPropagation();
      setActive((a) => Math.max(0, a - 1));
      return;
    }
    if (e.key === 'ArrowRight' && active < questions.length - 1) {
      e.preventDefault();
      e.stopPropagation();
      setActive((a) => Math.min(questions.length - 1, a + 1));
      return;
    }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      const root = optionsRef.current;
      if (!root) return;
      const opts = Array.from(root.querySelectorAll<HTMLElement>('[data-question-option]'));
      if (opts.length === 0) return;
      const cur = opts.findIndex((el) => el === document.activeElement);
      let nextIdx: number;
      if (e.key === 'ArrowUp') nextIdx = cur <= 0 ? opts.length - 1 : cur - 1;
      else nextIdx = cur >= opts.length - 1 ? 0 : cur + 1;
      e.preventDefault();
      e.stopPropagation();
      opts[nextIdx]?.focus();
      return;
    }
    if (e.key === 'Enter') {
      const ae = document.activeElement as HTMLElement | null;
      if (ae && ae.closest('[data-question-option]')) {
        const label = (ae as HTMLElement).dataset.questionLabel;
        if (label !== undefined) {
          e.preventDefault();
          e.stopPropagation();
          togglePick(current, label);
        }
      }
    }
  };

  if (!current) return null;

  const optionsToRender: Array<{ label: string; description?: string; isOther: boolean }> = [
    ...current.options.map((o) => ({ label: o.label, description: o.description, isOther: false })),
    { label: OTHER_LABEL, isOther: true }
  ];

  return (
    <motion.div
      ref={rootRef}
      role="dialog"
      aria-label={t('questionBlock.title')}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: DURATION_RAW.ms220, ease: EASING.standard }}
      className="relative mx-3 mb-2 rounded-md border border-state-waiting/40 bg-state-waiting/[0.06] surface-highlight surface-elevated"
      onKeyDown={onKeyDown}
    >
      <span aria-hidden className="absolute left-0 top-0 bottom-0 w-[2px] bg-state-waiting rounded-l-md" />

      {/* Chip-tab navigation bar. */}
      <div
        data-testid="question-nav-bar"
        className="flex items-center gap-1.5 px-3 py-2 border-b border-border-subtle"
      >
        {questions.map((q, i) => {
          const answered = (picks[q.question]?.size ?? 0) > 0;
          const isActive = i === active;
          const label = q.header || t('questionBlock.tabFallback', { n: i + 1 });
          return (
            <button
              key={i}
              type="button"
              data-testid={`question-tab-${i}`}
              data-active={isActive ? 'true' : 'false'}
              data-answered={answered ? 'true' : 'false'}
              onClick={() => setActive(i)}
              className={
                'inline-flex items-center gap-1.5 px-2 py-0.5 rounded-sm text-meta font-mono tracking-wider uppercase outline-none focus-ring-waiting transition-colors duration-150 ease-out ' +
                (isActive
                  ? 'bg-state-waiting/15 text-fg-primary border border-state-waiting/60'
                  : answered
                    ? 'bg-state-waiting/[0.06] text-fg-secondary border border-state-waiting/30 hover:bg-state-waiting/10'
                    : 'border border-border-subtle text-fg-tertiary hover:text-fg-secondary hover:border-border-default')
              }
              aria-current={isActive ? 'step' : undefined}
            >
              {answered && <Check size={10} className="stroke-[2.5]" aria-hidden />}
              <span className="truncate max-w-[160px]">{label}</span>
            </button>
          );
        })}
        <div className="flex-1" />
        {onReject && (
          <button
            type="button"
            aria-label={t('questionBlock.cancel')}
            title={t('questionBlock.cancel')}
            onClick={() => onReject()}
            className="inline-flex h-5 w-5 items-center justify-center rounded-sm text-fg-tertiary hover:text-fg-primary hover:bg-bg-hover outline-none focus-ring transition-colors duration-150 ease-out"
          >
            <X size={12} className="stroke-[2.25]" />
          </button>
        )}
      </div>

      {/* Active question body */}
      <div className="px-4 py-3">
        <div className="text-body text-fg-primary mb-3">{current.question}</div>
        <div
          ref={optionsRef}
          className="space-y-1"
          role={current.multiSelect ? 'group' : 'radiogroup'}
          aria-label={current.question}
        >
          {optionsToRender.map((opt, oi) => {
            const selected = isSelected(opt.label);
            const isConfirming = confirming === opt.label;
            const role = current.multiSelect ? 'checkbox' : 'radio';
            return (
              <div
                key={`${active}-${oi}`}
                data-question-option=""
                data-question-label={opt.label}
                role={role}
                aria-checked={selected}
                tabIndex={0}
                onClick={() => togglePick(current, opt.label)}
                onKeyDown={(e) => {
                  if (e.key === ' ') {
                    e.preventDefault();
                    togglePick(current, opt.label);
                  }
                }}
                className={
                  'flex items-start gap-2 w-full text-left px-3 py-2 rounded-sm border cursor-pointer transition-colors duration-150 ease-out outline-none focus-ring-waiting ' +
                  (selected
                    ? 'border-state-waiting/70 bg-state-waiting/10'
                    : 'border-border-subtle hover:bg-bg-hover hover:border-border-default') +
                  (isConfirming ? ' ring-2 ring-state-waiting/60' : '')
                }
              >
                <span
                  aria-hidden
                  className={
                    (current.multiSelect
                      ? 'mt-[3px] h-3.5 w-3.5 shrink-0 rounded-sm border flex items-center justify-center '
                      : 'mt-[3px] h-3.5 w-3.5 shrink-0 rounded-full border flex items-center justify-center ') +
                    (selected ? 'border-state-waiting bg-state-waiting/20' : 'border-border-strong')
                  }
                >
                  {selected && current.multiSelect && (
                    <Check size={10} strokeWidth={3} className="text-state-waiting" />
                  )}
                  {selected && !current.multiSelect && (
                    <span className="block h-1.5 w-1.5 rounded-full bg-state-waiting" />
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-body text-fg-primary break-words [overflow-wrap:anywhere]">
                    {opt.label === OTHER_LABEL ? t('questionBlock.other') : opt.label}
                  </div>
                  {opt.description && (
                    <div className="text-meta text-fg-tertiary mt-0.5 break-words [overflow-wrap:anywhere]">
                      {opt.description}
                    </div>
                  )}
                  {opt.isOther && selected && (
                    <div
                      ref={otherInputRef}
                      role="textbox"
                      aria-label={t('questionBlock.otherPlaceholder')}
                      contentEditable
                      suppressContentEditableWarning
                      data-testid="question-other-input"
                      spellCheck={false}
                      onFocus={() => setOtherFocused(true)}
                      onBlur={() => setOtherFocused(false)}
                      onClick={(e) => e.stopPropagation()}
                      onInput={(e) => {
                        const txt = (e.currentTarget.textContent ?? '').replace(/\n/g, '');
                        setOtherText((prev) => ({ ...prev, [current.question]: txt }));
                      }}
                      onKeyDown={(e) => {
                        if (e.nativeEvent.isComposing) return;
                        e.stopPropagation();
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault();
                          if (active < questions.length - 1) setActive(active + 1);
                        }
                      }}
                      className="mt-2 min-h-[28px] px-2 py-1 rounded-sm border border-border-default bg-bg-app text-body text-fg-primary outline-none focus-ring-waiting empty:before:content-[attr(data-placeholder)] empty:before:text-fg-tertiary"
                      data-placeholder={t('questionBlock.otherPlaceholder')}
                    />
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="px-3 pb-3 flex items-center justify-between gap-2">
        <span className="text-meta text-fg-tertiary font-mono">
          {questions.length > 1
            ? t('questionBlock.pageHint', { current: active + 1, total: questions.length })
            : t('questionBlock.singleHint')}
        </span>
        <button
          type="button"
          data-testid="question-submit"
          disabled={!allAnswered || submitted}
          onClick={submit}
          className={
            'inline-flex items-center px-3 py-1.5 rounded-sm text-body font-medium outline-none focus-ring-waiting transition-colors duration-150 ease-out ' +
            (allAnswered && !submitted
              ? 'bg-state-waiting/20 text-fg-primary border border-state-waiting/60 hover:bg-state-waiting/30'
              : 'border border-border-subtle text-fg-disabled cursor-not-allowed')
          }
        >
          {submitted ? t('questionBlock.submitted') : t('questionBlock.submit')}
        </button>
      </div>
    </motion.div>
  );
}
