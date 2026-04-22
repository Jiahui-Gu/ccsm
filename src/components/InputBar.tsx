import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { AlertCircle, ArrowUp, ImagePlus, Square, X } from 'lucide-react';
import { cn } from '../lib/cn';
import { Button } from './ui/Button';
import { useStore } from '../stores/store';
import { mergeRules } from '../agent/permission-presets';
import { SlashCommandPicker } from './SlashCommandPicker';
import {
  SLASH_COMMANDS,
  detectSlashTrigger,
  dispatchSlashCommand,
  filterSlashCommands,
  type SlashCommand
} from '../slash-commands/registry';
import type { ImageAttachment } from '../types';
import {
  attachmentToDataUrl,
  buildUserContentBlocks,
  formatSize,
  intakeFiles,
  MAX_IMAGE_BYTES,
  MAX_IMAGES_PER_MESSAGE,
  SUPPORTED_IMAGE_TYPES,
  type AttachmentRejection
} from '../lib/attachments';
import { useTranslation } from '../i18n/useTranslation';

// Per-session draft cache. Survives session switches within a process so
// users don't lose half-typed prompts when they pop into another session.
// Cleared on send. Not persisted to disk by design — drafts are ephemeral.
const draftCache = new Map<string, string>();

// Per-session attachment cache. Same rationale as the text draft: stays in
// memory across session switches, cleared on send. Data URLs are ephemeral
// too — users can always re-drop if the process restarts.
const attachmentCache = new Map<string, ImageAttachment[]>();

function nextLocalId(): string {
  return `u-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function AttachmentChip({
  attachment,
  onRemove
}: {
  attachment: ImageAttachment;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const url = useMemo(() => attachmentToDataUrl(attachment), [attachment]);
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 4, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -2, scale: 0.96 }}
      transition={{ duration: 0.18, ease: [0.32, 0.72, 0, 1] }}
      className="group relative flex items-center gap-2 rounded-md border border-border-subtle bg-bg-elevated/80 pl-1 pr-2 py-1 hover:border-border-strong transition-colors duration-150 ease-out"
    >
      <img
        src={url}
        alt={attachment.name}
        className="h-12 w-12 shrink-0 rounded-sm object-cover"
        draggable={false}
      />
      <div className="min-w-0 flex flex-col">
        <span className="text-xs text-fg-primary truncate max-w-[180px]" title={attachment.name}>
          {attachment.name}
        </span>
        <span className="text-[10px] text-fg-tertiary font-mono uppercase tracking-wider">
          {attachment.mediaType.replace('image/', '')} · {formatSize(attachment.size)}
        </span>
      </div>
      <button
        type="button"
        onClick={onRemove}
        aria-label={t('chat.removeAttachment', { name: attachment.name })}
        className="ml-1 inline-flex h-5 w-5 items-center justify-center rounded-full text-fg-tertiary hover:text-fg-primary hover:bg-bg-hover active:scale-95 transition-all duration-150 ease-out outline-none focus-visible:ring-1 focus-visible:ring-border-strong"
      >
        <X size={12} className="stroke-[2.25]" />
      </button>
    </motion.div>
  );
}

function DropOverlay({ show }: { show: boolean }) {
  const { t } = useTranslation();
  return (
    <AnimatePresence>
      {show && (
        <motion.div
          key="drop-overlay"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.14, ease: [0, 0, 0.2, 1] }}
          className="pointer-events-none absolute inset-2 z-10 rounded-lg border-2 border-dashed border-accent bg-accent/[0.08] backdrop-blur-[1px] flex flex-col items-center justify-center gap-2"
          aria-hidden
        >
          <ImagePlus size={28} className="text-accent" />
          <span className="font-mono text-sm text-accent tracking-wide">{t('chat.dropImageHint')}</span>
          <span className="font-mono text-[10px] uppercase tracking-wider text-accent/70">
            {t('chat.attachmentFormatsHint', { size: formatSize(MAX_IMAGE_BYTES) })}
          </span>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function hasDraggedFiles(e: DragEvent): boolean {
  // `types` is the cross-browser way to peek at DataTransfer during dragover
  // without reading `files` (which browsers intentionally blank until drop).
  const types = e.dataTransfer?.types;
  if (!types) return false;
  // In Chromium, file drags include a 'Files' entry.
  for (let i = 0; i < types.length; i++) {
    if (types[i] === 'Files') return true;
  }
  return false;
}

export function InputBar({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation();
  const [value, setValue] = useState(() => draftCache.get(sessionId) ?? '');
  const [attachments, setAttachments] = useState<ImageAttachment[]>(
    () => attachmentCache.get(sessionId) ?? []
  );
  const [rejections, setRejections] = useState<AttachmentRejection[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const session = useStore((s) => s.sessions.find((x) => x.id === sessionId));
  const started = useStore((s) => !!s.startedSessions[sessionId]);
  const running = useStore((s) => !!s.runningSessions[sessionId]);
  const hasMessages = useStore((s) => (s.messagesBySession[sessionId]?.length ?? 0) > 0);
  const permission = useStore((s) => s.permission);
  const permissionRules = useStore((s) => s.permissionRules);
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
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Skip the very first observation of focusInputNonce so app mount doesn't
  // steal focus from wherever the user (or some other auto-focus) put it.
  const focusNonceSeenRef = useRef<number | null>(null);
  // Counts nested dragenter/dragleave events at window level so sub-element
  // drags don't flicker the overlay off before the user drops.
  const dragDepthRef = useRef(0);

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
  useEffect(() => {
    if (!pickerOpen) return;
    if (activeIndex >= filtered.length) setActiveIndex(Math.max(0, filtered.length - 1));
  }, [pickerOpen, filtered.length, activeIndex]);

  useEffect(() => {
    setValue(draftCache.get(sessionId) ?? '');
    setAttachments(attachmentCache.get(sessionId) ?? []);
    setRejections([]);
  }, [sessionId]);

  useEffect(() => {
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
    // Client-handled commands that take no arguments (all current ones —
    // /pr, /clear, /cost, /config, /model, /help, /compact) should run
    // immediately on commit rather than leaving `/name<space>` parked in
    // the textarea waiting for another Enter press. Dispatch handles the
    // per-command logic (openSettings, triggerPrFlow, etc.).
    if (cmd.clientHandler) {
      void dispatchSlashCommand(`/${cmd.name}`, { sessionId, args: '' });
      setValue('');
      draftCache.delete(sessionId);
      setCaret(0);
      setPickerDismissed(true);
      setActiveIndex(0);
      return;
    }
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

  function setAttachmentsAndCache(next: ImageAttachment[]): void {
    setAttachments(next);
    if (next.length > 0) attachmentCache.set(sessionId, next);
    else attachmentCache.delete(sessionId);
  }

  const intake = useCallback(
    async (files: File[]): Promise<void> => {
      if (files.length === 0) return;
      const current = attachmentCache.get(sessionId) ?? [];
      const { accepted, rejected } = await intakeFiles(files, current.length);
      if (accepted.length > 0) {
        const next = [...current, ...accepted];
        setAttachmentsAndCache(next);
      }
      if (rejected.length > 0) {
        setRejections(rejected);
        // Auto-clear rejection banner after 6s so it doesn't pile up if the
        // user drags another batch.
        window.setTimeout(() => setRejections([]), 6000);
      }
    },
    // setAttachmentsAndCache is stable across renders (closes over setAttachments),
    // and attachmentCache is a module singleton. sessionId is the only real dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessionId]
  );

  // Window-level drag tracking so the overlay lights up as soon as the user
  // drags a file anywhere over the app, not only when they hover the input.
  useEffect(() => {
    function onDragEnter(e: DragEvent) {
      if (!hasDraggedFiles(e)) return;
      dragDepthRef.current += 1;
      setIsDragging(true);
    }
    function onDragLeave(e: DragEvent) {
      if (!hasDraggedFiles(e)) return;
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
      if (dragDepthRef.current === 0) setIsDragging(false);
    }
    function onDragOver(e: DragEvent) {
      if (!hasDraggedFiles(e)) return;
      e.preventDefault(); // allow drop
    }
    function onDrop(e: DragEvent) {
      dragDepthRef.current = 0;
      setIsDragging(false);
      if (!hasDraggedFiles(e)) return;
      e.preventDefault();
      const files = e.dataTransfer?.files;
      if (!files || files.length === 0) return;
      void intake(Array.from(files));
    }
    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('drop', onDrop);
    };
  }, [intake]);

  async function onPaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const items = e.clipboardData?.items;
    if (!items || items.length === 0) return;
    const files: File[] = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.kind === 'file' && it.type.startsWith('image/')) {
        const f = it.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length === 0) return;
    // Stop the browser from also pasting the filename / blob URL as text.
    e.preventDefault();
    await intake(files);
  }

  async function onPickFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files ? Array.from(e.target.files) : [];
    if (files.length === 0) return;
    // Let the user pick the same file twice in a row if they want.
    e.target.value = '';
    await intake(files);
  }

  function removeAttachment(id: string) {
    const next = attachments.filter((a) => a.id !== id);
    setAttachmentsAndCache(next);
  }

  async function send() {
    const text = value.trim();
    const imgs = attachments;
    if (running) return;
    // Valid turns: text with or without images, OR images with no text. Empty
    // text + no images is a no-op (same as before).
    if (!text && imgs.length === 0) return;

    // Slash-command fast path: if the whole message is `/<name> [args]` and
    // a client-side handler is registered, run it locally and return. This
    // runs BEFORE the agentory/IPC guard so commands like `/help` still work
    // in a browser-only probe harness where no Electron preload exists.
    // Only trigger when there are no image attachments — a slash command with
    // pasted images is almost certainly prose, not a bare invocation.
    if (text.startsWith('/') && imgs.length === 0) {
      const outcome = await dispatchSlashCommand(text, { sessionId, args: '' });
      if (outcome === 'handled') {
        update('');
        return;
      }
      // 'pass-through' and 'unknown' fall through to the normal send path.
    }

    const api = window.agentory;
    if (!api || !session) return;

    // Local echo: render the user's turn immediately. We skip the SDK's
    // own user-message echo in sdk-to-blocks to avoid duplicates.
    appendBlocks(sessionId, [
      {
        kind: 'user',
        id: nextLocalId(),
        text,
        ...(imgs.length > 0 ? { images: imgs } : {})
      }
    ]);
    update('');
    setAttachmentsAndCache([]);
    setRejections([]);
    setRunning(sessionId, true);
    // A real human turn resets the autopilot counter.
    resetWatchdogCount(sessionId);

    if (!started) {
      const endpointId = session.endpointId ?? defaultEndpointId ?? undefined;
      // Merge global rules with any per-session override; pass empty arrays
      // as undefined so the spawner omits the flag entirely.
      const mergedRules = mergeRules(permissionRules, session.permissionRules);
      const res = await api.agentStart(sessionId, {
        cwd: session.cwd,
        model: session.model || undefined,
        permissionMode: permission,
        resumeSessionId: session.resumeSessionId,
        endpointId,
        allowedTools:
          mergedRules.allowedTools.length > 0 ? mergedRules.allowedTools : undefined,
        disallowedTools:
          mergedRules.disallowedTools.length > 0 ? mergedRules.disallowedTools : undefined
      });
      if (!res.ok) {
        setRunning(sessionId, false);
        if (res.errorCode === 'CLAUDE_NOT_FOUND') {
          // Don't surface this as a chat-level error — flip global state so
          // the wizard takes over. Also rewind the user's local-echo so they
          // can retry immediately once the CLI is configured.
          useStore.getState().setCliMissing(res.searchedPaths ?? []);
          return;
        }
        if (res.errorCode === 'CWD_MISSING') {
          // The session's working directory was deleted between runs (often
          // an old worktree path). Mark it on the session so the Sidebar can
          // dim the row, then surface a chat-level hint pointing the user at
          // the StatusBar cwd chip — that's how they repick.
          useStore.getState().markSessionCwdMissing(sessionId, true);
          appendBlocks(sessionId, [
            {
              kind: 'error',
              id: `cwd-missing-${Date.now().toString(36)}`,
              text: t('chat.cwdMissing', { cwd: session.cwd }),
            },
          ]);
          return;
        }
        appendBlocks(sessionId, [
          { kind: 'error', id: `start-${Date.now().toString(36)}`, text: res.error }
        ]);
        return;
      }
      markStarted(sessionId);
    }

    let ok: boolean;
    if (imgs.length > 0) {
      const content = buildUserContentBlocks(text, imgs);
      ok = await api.agentSendContent(sessionId, content);
    } else {
      ok = await api.agentSend(sessionId, text);
    }
    if (!ok) {
      setRunning(sessionId, false);
      appendBlocks(sessionId, [
        { kind: 'error', id: `send-${Date.now().toString(36)}`, text: t('chat.sendFailedToDeliver') }
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

  const sendDisabled = !value.trim() && attachments.length === 0;
  const remainingSlots = Math.max(0, MAX_IMAGES_PER_MESSAGE - attachments.length);

  return (
    <div className="relative px-3 pt-2 pb-3">
      <DropOverlay show={isDragging} />

      <AnimatePresence>
        {rejections.length > 0 && (
          <motion.div
            key="rejections"
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -2 }}
            transition={{ duration: 0.18, ease: [0.32, 0.72, 0, 1] }}
            role="alert"
            className="mb-2 rounded-md border border-state-error/40 bg-state-error-soft/60 px-3 py-2 text-xs text-state-error-fg"
          >
            <div className="flex items-start gap-2">
              <AlertCircle size={12} className="text-state-error mt-0.5 shrink-0" />
              <div className="flex-1 min-w-0 space-y-0.5">
                {rejections.map((r, i) => (
                  <div key={i} className="truncate" title={r.detail}>
                    {r.detail}
                  </div>
                ))}
              </div>
              <button
                type="button"
                onClick={() => setRejections([])}
                aria-label={t('common.dismiss')}
                className="shrink-0 text-state-error/70 hover:text-state-error transition-colors duration-150 ease-out"
              >
                <X size={12} />
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div
        className={cn(
          'relative rounded-md border bg-bg-elevated surface-highlight',
          'transition-[border-color,box-shadow] duration-200',
          '[transition-timing-function:cubic-bezier(0.32,0.72,0,1)]',
          isDragging
            ? 'border-accent shadow-[0_0_0_3px_oklch(0.62_0.14_258_/_0.15)]'
            : 'border-border-default',
          !isDragging && 'focus-within:border-accent'
        )}
      >
        <SlashCommandPicker
          open={pickerOpen}
          query={trigger.active ? trigger.query : ''}
          activeIndex={activeIndex}
          onActiveIndexChange={setActiveIndex}
          onSelect={commitSlashCommand}
        />
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-2 pt-2">
            <AnimatePresence initial={false}>
              {attachments.map((a) => (
                <AttachmentChip
                  key={a.id}
                  attachment={a}
                  onRemove={() => removeAttachment(a.id)}
                />
              ))}
            </AnimatePresence>
          </div>
        )}
        <textarea
          ref={textareaRef}
          data-input-bar
          value={value}
          onChange={(e) => update(e.target.value)}
          onKeyDown={onKeyDown}
          onKeyUp={syncCaret}
          onClick={syncCaret}
          onSelect={syncCaret}
          onPaste={onPaste}
          rows={2}
          placeholder={running ? t('chat.runningPlaceholder') : hasMessages ? t('chat.inputPlaceholder') : t('chat.askPlaceholder')}
          disabled={running}
          className={cn(
            'block w-full resize-none px-3 pt-2 pb-7 text-base leading-[22px]',
            'bg-transparent text-fg-primary placeholder:text-fg-tertiary',
            'transition-colors duration-150 ease-out',
            running && 'cursor-not-allowed opacity-60'
          )}
          style={{ minHeight: 64, maxHeight: 240 }}
        />
        <div className="absolute left-2 bottom-1.5 flex items-center gap-1">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={SUPPORTED_IMAGE_TYPES.join(',')}
            className="hidden"
            onChange={onPickFiles}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={running || remainingSlots === 0}
            aria-label={t('chat.attachImage')}
            title={
              remainingSlots === 0
                ? t('chat.attachCapReached', { max: MAX_IMAGES_PER_MESSAGE })
                : t('chat.attachImageTitle')
            }
            className={cn(
              'inline-flex h-6 w-6 items-center justify-center rounded-sm text-fg-tertiary',
              'hover:text-fg-primary hover:bg-bg-hover active:scale-95',
              'disabled:opacity-40 disabled:pointer-events-none',
              'transition-all duration-150 ease-out outline-none focus-visible:ring-1 focus-visible:ring-border-strong'
            )}
          >
            <ImagePlus size={14} className="stroke-[2.25]" />
          </button>
          {attachments.length > 0 && (
            <span className="font-mono text-[10px] uppercase tracking-wider text-fg-tertiary">
              {attachments.length}/{MAX_IMAGES_PER_MESSAGE}
            </span>
          )}
        </div>
        <div className="absolute right-3 bottom-1.5">
          {running ? (
            <Button
              variant="secondary"
              size="sm"
              aria-label={t('chat.stopAria')}
              onClick={stop}
            >
              <Square size={10} className="stroke-[2.25]" />
              <span>{t('chat.stopBtn')}</span>
            </Button>
          ) : (
            <Button
              variant="primary"
              size="sm"
              aria-label={t('chat.sendMessage')}
              disabled={sendDisabled}
              onClick={send}
            >
              <ArrowUp size={10} className="stroke-[2.25]" />
              <span>{t('chat.sendButton')}</span>
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
