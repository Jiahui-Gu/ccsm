import type { QuestionSpec } from '../../../types';
import { useTranslation } from '../../../i18n/useTranslation';

/**
 * Compact summary row left in the timeline AFTER the user submits or
 * rejects an AskUserQuestion prompt. Mirrors the upstream Claude VS Code
 * extension behavior of "card 出队 / timeline 留 ToolBlock result row":
 * the live sticky widget vanishes the moment the user commits, but the
 * chat retains a scrollable trace of what was asked and what was sent
 * back so the conversation history reads naturally on scrollback.
 */
export function QuestionAnsweredRow({
  questions,
  answers,
  rejected
}: {
  questions: QuestionSpec[];
  answers?: Record<string, string>;
  rejected: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div
      data-testid="question-answered-row"
      data-rejected={rejected ? 'true' : 'false'}
      role="status"
      className="relative my-1.5 rounded-md border border-border-subtle bg-bg-elevated/60 pl-3 pr-3 py-1.5 text-meta text-fg-tertiary"
    >
      <span aria-hidden className="absolute left-0 top-0 bottom-0 w-[2px] rounded-l-md bg-border-strong" />
      <div className="flex items-baseline gap-2 mb-0.5">
        <span className="font-mono uppercase tracking-wider text-mono-xs text-fg-tertiary">
          {t('questionBlock.timelineLabel')}
        </span>
        <span className="text-fg-secondary">
          {rejected ? t('questionBlock.timelineRejected') : t('questionBlock.timelineAnswered')}
        </span>
      </div>
      {!rejected && answers && (
        <ul className="mt-1 space-y-0.5">
          {questions.map((q, i) => {
            const a = answers[q.question];
            if (!a) return null;
            // Render multi-line "Other" answers cleanly: replace the upstream
            // join separator ("\n ") with a comma for the compact summary.
            const compact = a.replace(/\n\s*/g, ', ');
            return (
              <li key={i} className="text-fg-secondary break-words [overflow-wrap:anywhere]">
                <span className="text-fg-tertiary">{q.question} </span>
                <span className="text-fg-primary">→ {compact}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
