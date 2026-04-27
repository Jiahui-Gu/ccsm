import type { TodoItem } from '../../../types';
import { useTranslation } from '../../../i18n/useTranslation';

export function TodoBlock({ todos }: { todos: TodoItem[] }) {
  const { t } = useTranslation();
  const total = todos.length;
  const done = todos.filter((t) => t.status === 'completed').length;
  return (
    <div className="my-1 pl-3 pr-2 font-mono text-chrome">
      <div className="flex items-baseline justify-between mb-1">
        <span className="font-mono text-mono-xs uppercase tracking-wider text-fg-tertiary">{t('chat.todoLabel')}</span>
        <span className="font-mono text-mono-xs text-fg-tertiary">
          {done}/{total}
        </span>
      </div>
      <ul className="space-y-0.5">
        {todos.map((t, i) => {
          const inProgress = t.status === 'in_progress';
          const completed = t.status === 'completed';
          return (
            <li key={i} className="flex items-start gap-2 text-chrome">
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
