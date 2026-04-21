import React, { useMemo, useRef, useState } from 'react';
import { ArrowUp, Square } from 'lucide-react';
import { cn } from '../lib/cn';
import { Button } from './ui/Button';
import { useStore } from '../stores/store';
import { toSdkPermissionMode } from '../agent/permission';
import { SlashCommandPicker } from './SlashCommandPicker';
import {
  SLASH_COMMANDS,
  detectSlashTrigger,
  filterSlashCommands,
  type SlashCommand
} from '../slash-commands/registry';

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
  const defaultEndpointId = useStore((s) => s.defaultEndpointId);
  const appendBlocks = useStore((s) => s.appendBlocks);
  const markStarted = useStore((s) => s.markStarted);
  const setRunning = useStore((s) => s.setRunning);
  const resetWatchdogCount = useStore((s) => s.resetWatchdogCount);
  const markInterrupted = useStore((s) => s.markInterrupted);
  const focusInputNonce = useStore((s) => s.focusInputNonce);
  // True iff there's a pending permission/plan/question prompt for this
  // session — those blocks auto-focus their own primary control (see the
  // setTimeout(..., 150) in WaitingBlock/PlanBlock/QuestionBlock). We let
  // them win and skip stealing focus into the textarea.
  const hasPendingWaiting = useStore((s) =>
    (s.messagesBySession[sessionId] ?? []).some((b) => b.kind === 'waiting')
  );
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Skip the very first observation of focusInputNonce so app mount doesn't
  // steal focus from wherever the user (or some other auto-focus) put it.
  const focusNonceSeenRef = useRef<number | null>(null);

  // --- Slash-command picker state --------------------------------------
  // We derive picker openness from (value, caret) rather than storing a
  // separate `open` flag, so the picker cannot drift out of sync with the
  // textarea content. `caret` is updated on every keyup/click/select.
  const [caret, setCaret] = useState(0);
  // `dismissed` lets the user Esc-out of the picker without needing to
  // change the textarea content. Any edit re-arms it.
  const [pickerDismissed, setPickerDismissed] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

  const trigger = useMemo(() => detectSlashTrigger(value, caret), [value, caret]);
  const filtered = useMemo<SlashCommand[]>(
    () => (trigger.active ? filterSlashCommands(SLASH_COMMANDS, trigger.query) : []),
    [trigger]
  );
  const pickerOpen = trigger.active && !pickerDismissed && !running;
  // Clamp activeIndex whenever the filtered list shrinks.
  React.useEffect(() => {
    if (!pickerOpen) return;
    if (activeIndex >= filtered.length) setActiveIndex(Math.max(0, filtered.length - 1));
  }, [pickerOpen, filtered.length, activeIndex]);

  React.useEffect(() => {
    setValue(draftCache.get(sessionId) ?? '');
  }, [sessionId]);

  React.useEffect(() => {
    if (focusNonceSeenRef.current === null) {
      focusNonceSeenRef.current = focusInputNonce;
      return;
    }
    if (focusNonceSeenRef.current === focusInputNonce) return;
    focusNonceSeenRef.current = focusInputNonce;
    if (hasPendingWaiting) return;
    // Don't yank focus out of another text-entry surface the user is
    // actively typing in (e.g. the inline-rename input on a session row,
    // a settings dialog field, etc.). Sidebar clicks land focus on the
    // session <li> (role="option"), which is fine to override.
    const ae = document.activeElement as HTMLElement | null;
    if (ae && ae !== textareaRef.current) {
      const tag = ae.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || ae.isContentEditable) return;
    }
    textareaRef.current?.focus();
  }, [focusInputNonce, hasPendingWaiting]);

  function update(next: string) {
    setValue(next);
    // Any edit re-arms the picker (so the user can dismiss with Esc, then
    // keep typing to reopen it if they're still in the `/...` prefix).
    setPickerDismissed(false);
    setActiveIndex(0);
    // Keep caret in sync with the edit — textarea may not have fired
    // onSelect/onKeyUp yet when onChange lands (and programmatic fills
    // from Playwright skip those entirely).
    const el = textareaRef.current;
    if (el) setCaret(el.selectionStart ?? next.length);
    else setCaret(next.length);
    if (next) draftCache.set(sessionId, next);
    else draftCache.delete(sessionId);
  }

  function commitSlashCommand(cmd: SlashCommand) {
    const next = `/${cmd.name} `;
    setValue(next);
    draftCache.set(sessionId, next);
    setCaret(next.length);
    setPickerDismissed(true);
    setActiveIndex(0);
    // Restore caret to end after React re-renders the textarea.
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(next.length, next.length);
    });
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
    // A real human turn resets the autopilot counter.
    resetWatchdogCount(sessionId);

    if (!started) {
      const endpointId = session.endpointId ?? defaultEndpointId ?? undefined;
      const res = await api.agentStart(sessionId, {
        cwd: session.cwd,
        model: session.model || undefined,
        permissionMode: toSdkPermissionMode(permission),
        resumeSessionId: session.resumeSessionId,
        endpointId
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
    // Flag the session BEFORE the IPC call so the upcoming
    // `result { error_during_execution }` frame is rendered as a neutral
    // "Interrupted" banner instead of an error block.
    markInterrupted(sessionId);
    await api.agentInterrupt(sessionId);
    // running flag is cleared when the SDK emits its result message.
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Skip Enter handling while IME composition is active — otherwise CJK
    // candidate selection accidentally sends the message.
    if (e.nativeEvent.isComposing || (e.nativeEvent as { keyCode?: number }).keyCode === 229) return;

    // Slash picker navigation takes precedence when open.
    if (pickerOpen && filtered.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIndex((i) => (i + 1) % filtered.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIndex((i) => (i - 1 + filtered.length) % filtered.length);
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        const cmd = filtered[activeIndex];
        if (cmd) {
          // Tab = complete-in-place, keep picker open so user can keep
          // browsing. Insert `/<name>` without trailing space.
          const next = `/${cmd.name}`;
          setValue(next);
          draftCache.set(sessionId, next);
          setCaret(next.length);
          requestAnimationFrame(() => {
            const el = textareaRef.current;
            if (!el) return;
            el.setSelectionRange(next.length, next.length);
          });
        }
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        const cmd = filtered[activeIndex];
        if (cmd) commitSlashCommand(cmd);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setPickerDismissed(true);
        return;
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  function syncCaret() {
    const el = textareaRef.current;
    if (!el) return;
    setCaret(el.selectionStart ?? 0);
  }

  return (
    <div className="px-3 pt-2 pb-3">
      <div
        className={cn(
          'relative rounded-md border bg-bg-elevated surface-highlight',
          'transition-[border-color] duration-200',
          '[transition-timing-function:cubic-bezier(0.32,0.72,0,1)]',
          'border-border-default',
          'focus-within:border-accent'
        )}
      >
        <SlashCommandPicker
          open={pickerOpen}
          query={trigger.active ? trigger.query : ''}
          activeIndex={activeIndex}
          onActiveIndexChange={setActiveIndex}
          onSelect={commitSlashCommand}
        />
        <textarea
          ref={textareaRef}
          data-input-bar
          value={value}
          onChange={(e) => update(e.target.value)}
          onKeyDown={onKeyDown}
          onKeyUp={syncCaret}
          onClick={syncCaret}
          onSelect={syncCaret}
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
