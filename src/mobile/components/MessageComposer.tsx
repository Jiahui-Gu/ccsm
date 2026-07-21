// Touch-safe message composer (mobile composer/terminal-sync plan, Task 5;
// approved spec "Phone input model", lines 163-201). A normal controlled
// multiline `<textarea>` — no `onKeyDown` interception of any kind. Return
// always inserts a local newline the same way it would in any other
// textarea; only the explicit Send button ever calls `onSubmit`.
//
// Hard contract (final user override supersedes any older focus-management
// text elsewhere in the plan): this component never calls `focus()` or
// `blur()` on anything, in an event handler or an effect. It doesn't even
// have an effect. Visible submission errors are rendered with
// `role="alert"` so assistive tech announces them without any imperative
// focus move.
//
// The Send button's disabled state is entirely prop-driven
// (`enabled`/`submitting`/draft emptiness) — this component never tracks
// its own "is this submission still in flight" state. That state is owned
// by the store's `pendingSubmission`, passed down as `submitting`.

import type { ChangeEvent } from 'react';

export type MessageComposerProps = {
  draft: string;
  enabled: boolean;
  submitting: boolean;
  error?: string | null;
  onDraftChange?: (text: string) => void;
  onSubmit?: () => void;
};

export function MessageComposer({
  draft,
  enabled,
  submitting,
  error = null,
  onDraftChange,
  onSubmit,
}: MessageComposerProps) {
  const sendDisabled = !enabled || submitting || draft.trim().length === 0;

  function handleChange(event: ChangeEvent<HTMLTextAreaElement>): void {
    onDraftChange?.(event.target.value);
  }

  function handleSend(): void {
    onSubmit?.();
  }

  return (
    <div className="message-composer">
      <textarea
        aria-label="Message"
        className="message-composer__input"
        value={draft}
        onChange={handleChange}
      />
      <button
        type="button"
        className="composer-send"
        onClick={handleSend}
        disabled={sendDisabled}
      >
        Send
      </button>
      {error ? (
        <p role="alert" className="message-composer__error">
          {error}
        </p>
      ) : null}
    </div>
  );
}
