import React, { useRef, useState } from 'react';
import { ArrowUp, Square } from 'lucide-react';
import { cn } from '../lib/cn';
import { Button } from './ui/Button';
import { useStore } from '../stores/store';
import { toSdkPermissionMode } from '../agent/permission';

// Per-session draft cache. Survives session switches within a process so
// users don't lose half-typed prompts when they pop into another session.
// Cleared on send. Not persisted to disk by design — drafts are ephemeral.
const draftCache = new Map<string, string>();

function nextLocalId(): string {
  return `u-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export function InputBar({ sessionId }: { sessionId: string }) {
  const [value, setValue] = useState(() => draftCache.get(sessionId) ?? '');
  const session = useStore((s) => s.sessions.find((x) => x.id === sessionId));
  const started = useStore((s) => !!s.startedSessions[sessionId]);
  const running = useStore((s) => !!s.runningSessions[sessionId]);
  const hasMessages = useStore((s) => (s.messagesBySession[sessionId]?.length ?? 0) > 0);
  const permission = useStore((s) => s.permission);
  const model = useStore((s) => s.model);
  const appendBlocks = useStore((s) => s.appendBlocks);
  const markStarted = useStore((s) => s.markStarted);
  const setRunning = useStore((s) => s.setRunning);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  React.useEffect(() => {
    setValue(draftCache.get(sessionId) ?? '');
  }, [sessionId]);

  function update(next: string) {
    setValue(next);
    if (next) draftCache.set(sessionId, next);
    else draftCache.delete(sessionId);
  }

  async function send() {
    const text = value.trim();
    if (!text || running) return;
    const api = window.agentory;
    if (!api || !session) return;

    // Local echo: render the user's turn immediately. We skip the SDK's
    // own user-message echo in sdk-to-blocks to avoid duplicates.
    appendBlocks(sessionId, [{ kind: 'user', id: nextLocalId(), text }]);
    update('');
    setRunning(sessionId, true);

    if (!started) {
      const res = await api.agentStart(sessionId, {
        cwd: session.cwd,
        model,
        permissionMode: toSdkPermissionMode(permission),
        resumeSessionId: session.resumeSessionId
      });
      if (!res.ok) {
        setRunning(sessionId, false);
        appendBlocks(sessionId, [
          { kind: 'error', id: `start-${Date.now().toString(36)}`, text: res.error }
        ]);
        return;
      }
      markStarted(sessionId);
    }

    const ok = await api.agentSend(sessionId, text);
    if (!ok) {
      setRunning(sessionId, false);
      appendBlocks(sessionId, [
        { kind: 'error', id: `send-${Date.now().toString(36)}`, text: 'Failed to deliver message to agent.' }
      ]);
    }
  }

  async function stop() {
    if (!running) return;
    const api = window.agentory;
    if (!api) return;
    await api.agentInterrupt(sessionId);
    // running flag is cleared when the SDK emits its result message.
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
          'focus-within:shadow-[inset_0_1px_0_0_oklch(1_0_0_/_0.04),0_0_0_3px_oklch(0.72_0.14_215_/_0.30)]'
        )}
      >
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => update(e.target.value)}
          onKeyDown={onKeyDown}
          rows={2}
          placeholder={running ? 'Running… (input disabled)' : hasMessages ? 'Reply…' : 'Ask anything…'}
          disabled={running}
          className={cn(
            'block w-full resize-none px-3 pt-2 pb-7 text-base leading-[22px]',
            'bg-transparent text-fg-primary placeholder:text-fg-tertiary',
            'transition-colors duration-150 ease-out',
            running && 'cursor-not-allowed opacity-60'
          )}
          style={{ minHeight: 64, maxHeight: 240 }}
        />
        <div className="absolute right-3 bottom-1.5">
          {running ? (
            <Button
              variant="secondary"
              size="sm"
              aria-label="Stop"
              onClick={stop}
            >
              <Square size={10} className="stroke-[2.25]" />
              <span>Stop</span>
            </Button>
          ) : (
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
          )}
        </div>
      </div>
    </div>
  );
}
