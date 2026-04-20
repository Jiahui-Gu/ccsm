import React, { useState } from 'react';
import { ArrowUp } from 'lucide-react';
import { cn } from '../lib/cn';
import { Button } from './ui/Button';

// Per-session draft cache. Survives session switches within a process so
// users don't lose half-typed prompts when they pop into another session.
// Cleared on send. Not persisted to disk by design — drafts are ephemeral.
const draftCache = new Map<string, string>();

export function InputBar({ sessionId }: { sessionId: string }) {
  const [value, setValue] = useState(() => draftCache.get(sessionId) ?? '');

  // When sessionId changes, swap the visible draft to that session's cached
  // value. We persist the previous session's draft into the cache via the
  // setter below — onChange writes both state and cache in one step.
  React.useEffect(() => {
    setValue(draftCache.get(sessionId) ?? '');
  }, [sessionId]);

  function update(next: string) {
    setValue(next);
    if (next) draftCache.set(sessionId, next);
    else draftCache.delete(sessionId);
  }

  function send() {
    if (!value.trim()) return;
    update('');
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Skip Enter handling while IME composition is active — otherwise CJK
    // candidate selection accidentally sends the message.
    if (e.nativeEvent.isComposing || (e.nativeEvent as { keyCode?: number }).keyCode === 229) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  return (
    <div className="px-3 pt-2 pb-3">
      <div
        className={cn(
          'relative rounded-md border bg-bg-elevated surface-highlight',
          'transition-[border-color,box-shadow] duration-200',
          '[transition-timing-function:cubic-bezier(0.32,0.72,0,1)]',
          'border-border-default',
          'focus-within:border-border-strong',
          // Apple-blue focus halo (no inner dark inset — that fought the
          // top-edge highlight). Alpha lifted to 0.30 for visibility.
          'focus-within:shadow-[inset_0_1px_0_0_oklch(1_0_0_/_0.04),0_0_0_3px_oklch(0.72_0.14_215_/_0.30)]'
        )}
      >
        <textarea
          value={value}
          onChange={(e) => update(e.target.value)}
          onKeyDown={onKeyDown}
          rows={2}
          placeholder="Reply…"
          className={cn(
            'block w-full resize-none px-3 pt-2 pb-7 text-base leading-[22px]',
            'bg-transparent text-fg-primary placeholder:text-fg-tertiary',
            'transition-colors duration-150 ease-out'
          )}
          style={{ minHeight: 64, maxHeight: 240 }}
        />
        <div className="absolute right-3 bottom-1.5">
          <Button
            variant="primary"
            size="sm"
            aria-label="Send message"
            disabled={!value.trim()}
            onClick={send}
          >
            <ArrowUp size={10} className="stroke-[2.25]" />
            <span>Send</span>
          </Button>
        </div>
      </div>
    </div>
  );
}
