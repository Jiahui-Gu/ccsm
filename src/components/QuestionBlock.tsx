import React, { useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { Check } from 'lucide-react';
import * as RadioGroup from '@radix-ui/react-radio-group';
import * as Checkbox from '@radix-ui/react-checkbox';
import * as RovingFocusGroup from '@radix-ui/react-roving-focus';
import type { QuestionSpec } from '../types';
import { Button } from './ui/Button';
import { StateGlyph } from './ui/StateGlyph';
import { useTranslation } from '../i18n/useTranslation';

export interface QuestionBlockProps {
  questions: QuestionSpec[];
  onSubmit: (answersText: string) => void;
  /** When false, this widget will not auto-focus its first option on mount. */
  autoFocus?: boolean;
}

export function QuestionBlock({ questions, onSubmit, autoFocus = true }: QuestionBlockProps) {
  const { t } = useTranslation();
  const [picks, setPicks] = useState<Array<Set<number>>>(() =>
    questions.map((q) => {
      // Single-select: pre-select the first option so Radix RadioGroup has a
      // clear initial tab stop and the Submit button is active immediately
      // (matches Claude Desktop behaviour). Multi-select stays empty.
      if (q.multiSelect) return new Set<number>();
      return new Set<number>([0]);
    })
  );
  const [submitted, setSubmitted] = useState(false);
  const submitRef = useRef<HTMLButtonElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const togglePick = (qIdx: number, optIdx: number, multi: boolean) => {
    if (submitted) return;
    setPicks((prev) => {
      const next = prev.slice();
      const set = new Set(next[qIdx]);
      if (multi) {
        if (set.has(optIdx)) set.delete(optIdx);
        else set.add(optIdx);
      } else {
        set.clear();
        set.add(optIdx);
      }
      next[qIdx] = set;
      return next;
    });
  };

  const allAnswered = questions.every((_, i) => picks[i] && picks[i].size > 0);

  const submit = () => {
    if (!allAnswered || submitted) return;
    const lines: string[] = [];
    questions.forEach((q, i) => {
      const labels = Array.from(picks[i]).map((j) => q.options[j]?.label).filter(Boolean);
      lines.push(`Q: ${q.question}`);
      lines.push(`A: ${labels.join(', ')}`);
    });
    setSubmitted(true);
    onSubmit(lines.join('\n'));
  };

  // Auto-focus the first interactive option on mount so the user can press
  // Enter immediately. Only the LATEST mounted question grabs focus (the older
  // ones are already mounted and won't re-fire this effect).
  useEffect(() => {
    if (!autoFocus || submitted) return;
    const root = rootRef.current;
    if (!root) return;
    // Defer to next frame so Radix has wired up roving tabindex.
    const id = requestAnimationFrame(() => {
      const target = root.querySelector<HTMLElement>(
        '[data-question-option][data-question-first="true"]'
      );
      if (!target) return;
      // Don't steal focus if the user has already moved focus to a real
      // interactive element somewhere else (e.g. the InputBar textarea).
      const active = document.activeElement;
      if (active && active !== document.body && !root.contains(active)) return;
      target.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onKeyDownCapture = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (submitted) return;
    if (e.key === 'Enter') {
      const target = e.target as HTMLElement;
      // Only intercept Enter on option buttons. The Submit button handles its
      // own Enter via native click, and we don't want to double-fire.
      if (target.closest('[data-question-option]')) {
        e.preventDefault();
        e.stopPropagation();
        submit();
      }
    } else if (e.key === 'Escape') {
      const active = document.activeElement as HTMLElement | null;
      if (active && rootRef.current?.contains(active)) {
        e.preventDefault();
        active.blur();
      }
    }
  };

  return (
    <motion.div
      ref={rootRef}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22, ease: [0.32, 0.72, 0, 1] }}
      className="relative my-2 rounded-md border border-state-waiting/40 bg-state-waiting/[0.06] surface-highlight surface-elevated pl-4 pr-4 py-3"
      onKeyDownCapture={onKeyDownCapture}
    >
      <span aria-hidden className="absolute left-0 top-0 bottom-0 w-[2px] bg-state-waiting rounded-l-md" />
      <div className="flex items-center gap-2 text-base text-fg-primary font-semibold">
        <StateGlyph state="waiting" size="sm" />
        <span>{t('questionBlock.title')}</span>
      </div>
      <div className="mt-3 space-y-4">
        {questions.map((q, qi) => (
          <QuestionRow
            key={qi}
            q={q}
            qi={qi}
            picks={picks[qi] ?? new Set<number>()}
            submitted={submitted}
            onToggle={togglePick}
            isFirstQuestion={qi === 0}
          />
        ))}
      </div>
      <div className="mt-3 flex justify-end">
        <Button
          ref={submitRef}
          variant="primary"
          size="md"
          disabled={!allAnswered || submitted}
          onClick={submit}
        >
          {submitted ? t('questionBlock.submitted') : t('questionBlock.submit')}
        </Button>
      </div>
    </motion.div>
  );
}

interface QuestionRowProps {
  q: QuestionSpec;
  qi: number;
  picks: Set<number>;
  submitted: boolean;
  onToggle: (qIdx: number, optIdx: number, multi: boolean) => void;
  isFirstQuestion: boolean;
}

function QuestionRow({ q, qi, picks, submitted, onToggle, isFirstQuestion }: QuestionRowProps) {
  const labelClass = (selected: boolean) =>
    'flex items-start gap-2 w-full text-left px-3 py-2 rounded-sm border cursor-pointer transition-colors duration-150 ease-out outline-none focus-within:ring-2 focus-within:ring-state-waiting/60 focus-within:ring-offset-1 focus-within:ring-offset-bg-app ' +
    (selected
      ? 'border-state-waiting/70 bg-state-waiting/10'
      : 'border-border-subtle hover:bg-bg-hover hover:border-border-default active:bg-bg-hover/80') +
    (submitted ? ' cursor-not-allowed opacity-70' : '');

  return (
    <div className="space-y-2">
      {q.header && (
        <div className="font-mono text-mono-sm uppercase tracking-wider text-fg-tertiary">{q.header}</div>
      )}
      <div className="text-sm text-fg-primary">{q.question}</div>
      {q.multiSelect ? (
        <MultiSelectGroup
          q={q}
          qi={qi}
          picks={picks}
          submitted={submitted}
          onToggle={onToggle}
          labelClass={labelClass}
          autoFocusFirst={isFirstQuestion}
        />
      ) : (
        <SingleSelectGroup
          q={q}
          qi={qi}
          picks={picks}
          submitted={submitted}
          onToggle={onToggle}
          labelClass={labelClass}
          autoFocusFirst={isFirstQuestion}
        />
      )}
    </div>
  );
}

interface GroupProps {
  q: QuestionSpec;
  qi: number;
  picks: Set<number>;
  submitted: boolean;
  onToggle: (qIdx: number, optIdx: number, multi: boolean) => void;
  labelClass: (selected: boolean) => string;
  autoFocusFirst: boolean;
}

function SingleSelectGroup({ q, qi, picks, submitted, onToggle, labelClass, autoFocusFirst }: GroupProps) {
  const value = useMemo(() => (picks.size > 0 ? String(Array.from(picks)[0]) : ''), [picks]);
  return (
    <RadioGroup.Root
      value={value}
      onValueChange={(v) => {
        const idx = parseInt(v, 10);
        if (!Number.isNaN(idx)) onToggle(qi, idx, false);
      }}
      disabled={submitted}
      orientation="vertical"
      loop
      className="space-y-1"
      aria-label={q.question}
    >
      {q.options.map((opt, oi) => {
        const selected = picks.has(oi);
        const id = `q${qi}-o${oi}`;
        const isFirst = autoFocusFirst && oi === 0;
        return (
          <motion.label
            key={oi}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.18, delay: oi * 0.02, ease: [0, 0, 0.2, 1] }}
            htmlFor={id}
            className={labelClass(selected)}
          >
            <RadioGroup.Item
              id={id}
              value={String(oi)}
              data-question-option=""
              data-question-first={isFirst ? 'true' : 'false'}
              className="mt-[3px] h-3.5 w-3.5 shrink-0 rounded-full border border-border-strong data-[state=checked]:border-state-waiting outline-none focus-visible:ring-2 focus-visible:ring-state-waiting/60 focus-visible:ring-offset-1 focus-visible:ring-offset-bg-app transition-colors duration-150"
            >
              <RadioGroup.Indicator className="flex items-center justify-center h-full w-full relative after:content-[''] after:block after:h-1.5 after:w-1.5 after:rounded-full after:bg-state-waiting" />
            </RadioGroup.Item>
            <div className="min-w-0 flex-1">
              <div className="text-sm text-fg-primary break-words [overflow-wrap:anywhere]">{opt.label}</div>
              {opt.description && (
                <div className="text-xs text-fg-tertiary mt-0.5 break-words [overflow-wrap:anywhere]">{opt.description}</div>
              )}
            </div>
          </motion.label>
        );
      })}
    </RadioGroup.Root>
  );
}

function MultiSelectGroup({ q, qi, picks, submitted, onToggle, labelClass, autoFocusFirst }: GroupProps) {
  return (
    <RovingFocusGroup.Root
      asChild
      orientation="vertical"
      loop
    >
      <div className="space-y-1" role="group" aria-label={q.question}>
        {q.options.map((opt, oi) => {
          const selected = picks.has(oi);
          const id = `q${qi}-o${oi}`;
          const isFirst = autoFocusFirst && oi === 0;
          return (
            <motion.label
              key={oi}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.18, delay: oi * 0.02, ease: [0, 0, 0.2, 1] }}
              htmlFor={id}
              className={labelClass(selected)}
            >
              <RovingFocusGroup.Item asChild focusable={!submitted} active={isFirst}>
                <Checkbox.Root
                  id={id}
                  checked={selected}
                  disabled={submitted}
                  onCheckedChange={() => onToggle(qi, oi, true)}
                  data-question-option=""
                  data-question-first={isFirst ? 'true' : 'false'}
                  className="mt-[3px] h-3.5 w-3.5 shrink-0 rounded-sm border border-border-strong data-[state=checked]:bg-state-waiting data-[state=checked]:border-state-waiting outline-none focus-visible:ring-2 focus-visible:ring-state-waiting/60 focus-visible:ring-offset-1 focus-visible:ring-offset-bg-app transition-colors duration-150"
                >
                  <Checkbox.Indicator className="flex items-center justify-center text-bg-app">
                    <Check size={10} strokeWidth={3} />
                  </Checkbox.Indicator>
                </Checkbox.Root>
              </RovingFocusGroup.Item>
              <div className="min-w-0 flex-1">
                <div className="text-sm text-fg-primary break-words [overflow-wrap:anywhere]">{opt.label}</div>
                {opt.description && (
                  <div className="text-xs text-fg-tertiary mt-0.5 break-words [overflow-wrap:anywhere]">{opt.description}</div>
                )}
              </div>
            </motion.label>
          );
        })}
      </div>
    </RovingFocusGroup.Root>
  );
}
