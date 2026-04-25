import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { AlertCircle, ArrowUp, ImagePlus, Square, X } from 'lucide-react';
import { cn } from '../lib/cn';
import { Button } from './ui/Button';
import { MetaLabel } from './ui/MetaLabel';
import { useStore } from '../stores/store';
import { serializeDiffCommentsForPrompt } from '../stores/store';
import { DURATION, EASING } from '../lib/motion';
import { useShallow } from 'zustand/react/shallow';
import { SlashCommandPicker } from './SlashCommandPicker';
import {
  BUILT_IN_COMMANDS,
  detectSlashTrigger,
  dispatchSlashCommand,
  filterSlashCommands,
  loadDynamicCommands,
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
import { runningPlaceholderForMode } from '../lib/runningPlaceholder';

// Per-session text drafts persist across session switches AND across app
// restarts (see ../stores/drafts). Cleared on send. Image attachments stay
// in-memory only — they're large and re-droppable.
import { getDraft, setDraft, clearDraft } from '../stores/drafts';
import { startSessionAndReconcile } from '../agent/startSession';

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
      transition={{ duration: DURATION.standard, ease: EASING.standard }}
      className="group relative flex items-center gap-2 rounded-md border border-border-subtle bg-bg-elevated/80 pl-1 pr-2 py-1 hover:border-border-strong transition-colors duration-150 ease-out"
    >
      <img
        src={url}
        alt={attachment.name}
        className="h-12 w-12 shrink-0 rounded-sm object-cover"
        draggable={false}
      />
      <div className="min-w-0 flex flex-col">
        <span className="text-meta text-fg-primary truncate max-w-[180px]" title={attachment.name}>
          {attachment.name}
        </span>
        <span className="text-meta text-fg-tertiary">
          {attachment.mediaType.replace('image/', '')} · {formatSize(attachment.size)}
        </span>
      </div>
      <button
        type="button"
        onClick={onRemove}
        aria-label={t('chat.removeAttachment', { name: attachment.name })}
        className="ml-1 inline-flex h-5 w-5 items-center justify-center rounded-full text-fg-tertiary hover:text-fg-primary hover:bg-bg-hover active:scale-95 transition-all duration-150 ease-out outline-none focus-ring"
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
          transition={{ duration: DURATION.fast, ease: EASING.enter }}
          className="pointer-events-none absolute inset-2 z-10 rounded-lg border-2 border-dashed border-accent bg-accent/[0.08] backdrop-blur-[1px] flex flex-col items-center justify-center gap-2"
          aria-hidden
        >
          <ImagePlus size={28} className="text-accent" />
          <span className="font-mono text-chrome text-accent tracking-wide">{t('chat.dropImageHint')}</span>
          <span className="text-meta text-accent/70">
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
  const [value, setValue] = useState(() => getDraft(sessionId));
  const [attachments, setAttachments] = useState<ImageAttachment[]>(
    () => attachmentCache.get(sessionId) ?? []
  );
  const [rejections, setRejections] = useState<AttachmentRejection[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  // Perf: subscribe to all reactive per-session signals via useShallow so this
  // component only re-renders when one of these specific values changes
  // (instead of once per any store mutation, like an appendBlocks chunk).
  const { session, started, running, queueLength, hasMessages, hasPendingWaiting, permission, focusInputNonce, pendingDiffCommentsCount, lastTurnEnd } = useStore(
    useShallow((s) => ({
      session: s.sessions.find((x) => x.id === sessionId),
      started: !!s.startedSessions[sessionId],
      running: !!s.runningSessions[sessionId],
      queueLength: s.messageQueues[sessionId]?.length ?? 0,
      hasMessages: (s.messagesBySession[sessionId]?.length ?? 0) > 0,
      // True iff there's a pending permission/plan/question prompt for this
      // session — those blocks auto-focus their own primary control (see the
      // setTimeout(..., 150) in WaitingBlock/PlanBlock/QuestionBlock). We let
      // them win and skip stealing focus into the textarea.
      hasPendingWaiting: (s.messagesBySession[sessionId] ?? []).some((b) => b.kind === 'waiting'),
      permission: s.permission,
      focusInputNonce: s.focusInputNonce,
      // Count of pending per-line diff comments queued up to ride the next
      // user prompt as `<diff-feedback>` blocks (#303). Drives the "N diff
      // comments will be sent" indicator + lets the send path skip the
      // serialization round-trip when there are none.
      pendingDiffCommentsCount: Object.keys(s.pendingDiffComments[sessionId] ?? {}).length,
      // task322: 'interrupted' iff the last turn for this session ended via
      // user-initiated stop. Drives the continue-hint affordance below.
      lastTurnEnd: s.lastTurnEnd[sessionId] ?? null,
    }))
  );
  // Action references are stable across renders in Zustand v5, so reading them
  // via getState() avoids registering listeners that would never fire anyway.
  const { appendBlocks, markStarted, setRunning, markInterrupted, enqueueMessage, clearQueue, bumpComposerFocus, clearDiffComments, clearLastTurnEnd } =
    useStore.getState();
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

  // Disk-discovered commands (user / project / plugin). Reload whenever
  // the session or its cwd changes so project-level commands track the
  // active workspace, and again on textarea focus so a user dropping a new
  // .md file in mid-session sees it without reloading the app.
  const cwd = session?.cwd ?? null;
  const [dynamicCommands, setDynamicCommands] = useState<SlashCommand[]>([]);
  const refreshDynamic = useCallback(async () => {
    const next = await loadDynamicCommands(cwd);
    setDynamicCommands(next);
  }, [cwd]);
  useEffect(() => {
    void refreshDynamic();
  }, [refreshDynamic]);

  const allCommands = useMemo<SlashCommand[]>(
    () => [...BUILT_IN_COMMANDS, ...dynamicCommands],
    [dynamicCommands]
  );

  const trigger = useMemo(() => detectSlashTrigger(value, caret), [value, caret]);
  const filtered = useMemo<SlashCommand[]>(
    () => (trigger.active ? filterSlashCommands(allCommands, trigger.query) : []),
    [trigger, allCommands]
  );
  const pickerOpen = trigger.active && !pickerDismissed;
  // Clamp activeIndex whenever the filtered list shrinks.
  useEffect(() => {
    if (!pickerOpen) return;
    if (activeIndex >= filtered.length) setActiveIndex(Math.max(0, filtered.length - 1));
  }, [pickerOpen, filtered.length, activeIndex]);

  // Wire the slash picker into the global popover mutex (id: 'slash'). When
  // the user opens any other popover (cwd / model chip / permission chip),
  // openPopoverId moves off 'slash' and we dismiss the picker so it can't
  // visually overlap a sibling. Conversely, opening the picker claims the
  // slot, which auto-closes whichever popover was previously open.
  const openPopoverId = useStore((s) => s.openPopoverId);
  const openPopover = useStore((s) => s.openPopover);
  const closePopover = useStore((s) => s.closePopover);
  useEffect(() => {
    if (pickerOpen) openPopover('slash');
    else closePopover('slash');
  }, [pickerOpen, openPopover, closePopover]);
  useEffect(() => {
    if (pickerOpen && openPopoverId !== null && openPopoverId !== 'slash') {
      setPickerDismissed(true);
    }
  }, [openPopoverId, pickerOpen]);

  useEffect(() => {
    setValue(getDraft(sessionId));
    setAttachments(attachmentCache.get(sessionId) ?? []);
    setRejections([]);
  }, [sessionId]);

  // task322: continue-after-interrupt — show a one-line hint above the
  // composer after the user stops a turn, telling them they can press Enter
  // (with empty composer) to send the literal `continue`. Gate conditions:
  //   (a) last turn ended via interrupt (store: lastTurnEnd === 'interrupted')
  //   (b) composer is empty (no draft, no attachments)
  //   (c) user hasn't typed anything since the interrupt (typedSinceInterrupt
  //       latches true on the first keystroke, resets on a fresh interrupt)
  //   (d) agent is not currently running
  // The hint dismisses when any of (b)/(c)/(d) flips, when the user sends a
  // message (clearLastTurnEnd in `send()`), or when a new turn starts
  // (setRunning(true) clears lastTurnEnd in the store).
  const [typedSinceInterrupt, setTypedSinceInterrupt] = useState(false);
  // Reset the typed-since-interrupt latch every time we observe a new
  // 'interrupted' transition. The session-id change effect above also resets
  // this implicitly (component unmount/remount), but session switches reuse
  // the same component instance — so we re-arm explicitly here.
  const lastSeenInterruptRef = useRef<string | null>(null);
  useEffect(() => {
    const key = `${sessionId}:${lastTurnEnd ?? 'none'}`;
    if (lastSeenInterruptRef.current === key) return;
    lastSeenInterruptRef.current = key;
    if (lastTurnEnd === 'interrupted') setTypedSinceInterrupt(false);
  }, [sessionId, lastTurnEnd]);
  const showContinueHint =
    lastTurnEnd === 'interrupted' &&
    !running &&
    value === '' &&
    attachments.length === 0 &&
    !typedSinceInterrupt;

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
    // task322: any keystroke (even one that lands an empty string back —
    // e.g. paste-then-undo) counts as user activity that dismisses the
    // continue-after-interrupt hint. We only flip the latch when the value
    // actually has content; pure deletions back to "" leave the hint armed
    // (the user might still hit Enter to continue).
    if (next !== '') setTypedSinceInterrupt(true);
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
    if (next) setDraft(sessionId, next);
    else clearDraft(sessionId);
  }

  function commitSlashCommand(cmd: SlashCommand) {
    // Built-in client-handled commands (currently just /clear) run
    // immediately on commit rather than parking `/name<space>` in the
    // textarea waiting for another Enter press. Dynamic / pass-through
    // commands ALSO run immediately when they have no `argument-hint` —
    // they're meant to be one-shots. When an argument hint exists we
    // insert `/name ` and let the user type the args before sending.
    if (cmd.clientHandler) {
      void dispatchSlashCommand(`/${cmd.name}`, allCommands, { sessionId, args: '' });
      setValue('');
      clearDraft(sessionId);
      setCaret(0);
      setPickerDismissed(true);
      setActiveIndex(0);
      return;
    }
    if (!cmd.argumentHint) {
      // Pass-through one-shot: forward `/name` as a real send so the CLI
      // sees it. Mirror the normal send path's draft cleanup.
      void send(`/${cmd.name}`);
      setValue('');
      clearDraft(sessionId);
      setCaret(0);
      setPickerDismissed(true);
      setActiveIndex(0);
      return;
    }
    const next = `/${cmd.name} `;
    setValue(next);
    setDraft(sessionId, next);
    setCaret(next.length);
    setPickerDismissed(true);
    setActiveIndex(0);
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

  // Global Esc → stop running turn. Intentionally listens at the document
  // level so the shortcut works regardless of which surface has focus
  // (composer, chat scroll area, sidebar). Yields to:
  //   - Open Radix dialogs (settings, command palette, CLI-missing) — they
  //     manage their own Esc-to-close inside `[role="dialog"]`.
  //   - The slash-command picker when it's open and the textarea has focus —
  //     the inline Esc handler in `onKeyDown` dismisses the picker first.
  useEffect(() => {
    function onDocKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      if (!running) return;
      // Some other modal owns Escape right now.
      if (document.querySelector('[role="dialog"]')) return;
      const ae = document.activeElement as HTMLElement | null;
      // Defer to the picker's own dismissal when it's the active surface.
      if (ae === textareaRef.current && pickerOpen) return;
      e.preventDefault();
      void stop();
    }
    document.addEventListener('keydown', onDocKeyDown);
    return () => document.removeEventListener('keydown', onDocKeyDown);
    // `stop` closes over running + sessionId; both are dependencies via
    // `running` and the implicit re-render when sessionId changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, pickerOpen, sessionId]);

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

  async function send(override?: string) {
    const text = (override ?? value).trim();
    const imgs = override !== undefined ? [] : attachments;
    // Valid turns: text with or without images, OR images with no text. Empty
    // text + no images is a no-op (same as before).
    if (!text && imgs.length === 0) return;
    // task322: any send dismisses the continue-after-interrupt hint
    // synchronously. setRunning(true) below would also clear it via the
    // store, but doing it here covers the queued-while-running branch (which
    // doesn't flip running) and avoids a one-frame flash of the hint.
    clearLastTurnEnd(sessionId);

    // Slash-command fast path: if the whole message is `/<name> [args]` and
    // a client-side handler is registered, run it locally and return. This
    // runs BEFORE the agentory/IPC guard so commands like `/help` still work
    // in a browser-only probe harness where no Electron preload exists.
    // Only trigger when there are no image attachments — a slash command with
    // pasted images is almost certainly prose, not a bare invocation.
    //
    // Slash commands are intentionally NOT queued. Client handlers are
    // immediate side-effects (`/clear` wipes context, `/config` opens
    // settings) — deferring them until the next turn ends would be confusing.
    // Pass-through slashes also bypass the queue so they reach claude.exe in
    // the order the user typed them, not interleaved with queued prose.
    if (text.startsWith('/') && imgs.length === 0) {
      const outcome = await dispatchSlashCommand(text, allCommands, { sessionId, args: '' });
      if (outcome === 'handled') {
        update('');
        return;
      }
      // 'pass-through' and 'unknown' fall through to the normal send path.
    }

    // #303: bake any pending per-line diff comments into the outgoing prompt
    // body BEFORE the user text. Comments are session-scoped; we serialize
    // and clear in one shot so the same comments can never ride two turns.
    // Done here (before the queueing branch) so a turn enqueued during a
    // running session captures exactly the comments visible at the moment
    // the user pressed Enter — not whatever is left over when the queue
    // eventually drains. Override (slash-command pass-through, command
    // panel) skips comments: an override is a programmatic send, not a
    // user composing in the textarea.
    let outgoingText = text;
    if (override === undefined) {
      const { pendingDiffComments } = useStore.getState();
      const prefix = serializeDiffCommentsForPrompt(pendingDiffComments[sessionId]);
      if (prefix) {
        // Two newlines between prefix and user text so a markdown-rendering
        // model treats them as separate paragraphs even if it ignores the
        // structured tag.
        outgoingText = `${prefix}\n\n${text}`;
        clearDiffComments(sessionId);
      }
    }

    // Queue non-slash messages while a turn is in flight. The drain happens
    // in agent/lifecycle.ts when `result` arrives. Clear the composer so the
    // user can keep typing the next thought immediately.
    if (running) {
      enqueueMessage(sessionId, { text: outgoingText, attachments: imgs });
      update('');
      setAttachmentsAndCache([]);
      setRejections([]);
      return;
    }

    const api = window.ccsm;
    if (!api || !session) return;

    // Local echo: render the user's turn immediately. We skip the SDK's
    // own user-message echo in sdk-to-blocks to avoid duplicates.
    appendBlocks(sessionId, [
      {
        kind: 'user',
        id: nextLocalId(),
        text: outgoingText,
        ...(imgs.length > 0 ? { images: imgs } : {})
      }
    ]);
    update('');
    setAttachmentsAndCache([]);
    setRejections([]);
    setRunning(sessionId, true);

    if (!started) {
      const ok = await startSessionAndReconcile(sessionId);
      if (!ok) {
        // All failure branches (CLAUDE_NOT_FOUND → CLI wizard,
        // CWD_MISSING → inline error + sidebar dim, generic →
        // sessionInitFailures banner) are reconciled inside the helper.
        // We just flip running off and bail out of the send path.
        setRunning(sessionId, false);
        return;
      }
    }

    let ok: boolean;
    if (imgs.length > 0) {
      const content = buildUserContentBlocks(outgoingText, imgs);
      ok = await api.agentSendContent(sessionId, content);
    } else {
      ok = await api.agentSend(sessionId, outgoingText);
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
    const api = window.ccsm;
    if (!api) return;
    // Flag the session BEFORE the IPC call so the upcoming
    // `result { error_during_execution }` frame is rendered as a neutral
    // "Interrupted" banner instead of an error block.
    markInterrupted(sessionId);
    // Match CLI Ctrl+C behavior: interrupting also drops everything the user
    // queued during this turn. Otherwise the next turn would auto-send work
    // the user just decided to abandon.
    clearQueue(sessionId);
    await api.agentInterrupt(sessionId);
    // Return focus to the composer so the user can type immediately
    // (matches CLI Ctrl+C behavior). The InputBar focus useEffect picks
    // this up via the bumped nonce and applies the standard focus guards
    // (skips if user is mid-typing in another text surface).
    bumpComposerFocus();
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
          setDraft(sessionId, next);
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
      // task322: empty composer + active continue-hint → send literal
      // 'continue' through the normal send path. This is the affordance the
      // hint advertises; without it, empty-Enter would no-op as before.
      if (showContinueHint) {
        void send('continue');
        return;
      }
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

  // Auto-resize the textarea: grow from ~2 lines up to ~10 lines, then scroll.
  // useLayoutEffect so the height is corrected before the browser paints,
  // avoiding a one-frame flicker on every keystroke. Matches the line-height
  // declared on the <textarea> (22px) and the composer's vertical padding
  // (pt-2 = 8px, pb-7 = 28px) so min/max map cleanly to "N lines of text".
  const MIN_LINES = 2;
  const MAX_LINES = 10;
  const LINE_HEIGHT = 22;
  const VPAD = 8 + 28; // pt-2 + pb-7
  const MIN_HEIGHT = MIN_LINES * LINE_HEIGHT + VPAD; // 80
  const MAX_HEIGHT = MAX_LINES * LINE_HEIGHT + VPAD; // 256
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    // Reset first so shrinking (after deleting lines) actually takes effect —
    // scrollHeight is always >= current height.
    el.style.height = 'auto';
    const next = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, el.scrollHeight));
    el.style.height = `${next}px`;
  }, [value, attachments.length, MIN_HEIGHT, MAX_HEIGHT]);

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
            transition={{ duration: DURATION.standard, ease: EASING.standard }}
            role="alert"
            className="mb-2 rounded-md border border-state-error/40 bg-state-error-soft/60 px-3 py-2 text-meta text-state-error-fg"
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
                className="shrink-0 inline-flex items-center justify-center rounded-sm text-state-error/70 hover:text-state-error transition-colors duration-150 ease-out outline-none focus-ring-destructive"
              >
                <X size={12} />
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* task322: continue-after-interrupt hint. One-line muted row above
          the composer; empty-Enter while it's visible sends `continue`. */}
      {showContinueHint && (
        <div
          data-testid="continue-after-interrupt-hint"
          className="mb-1 px-1 text-meta text-fg-tertiary select-none"
          aria-live="polite"
        >
          {t('chat.continueAfterInterruptHint')}
        </div>
      )}

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
          commands={allCommands}
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
          onFocus={() => {
            // Re-scan disk commands on focus so newly-dropped .md files
            // surface in the picker without reloading the app.
            void refreshDynamic();
          }}
          onPaste={onPaste}
          rows={2}
          placeholder={running ? runningPlaceholderForMode(t, permission) : hasMessages ? t('chat.inputPlaceholder') : t('chat.askPlaceholder')}
          className={cn(
            'block w-full resize-none px-3 pt-2 pb-7 text-body leading-[22px]',
            'bg-transparent text-fg-primary placeholder:text-fg-tertiary',
            'transition-colors duration-150 ease-out',
            'overflow-y-auto'
          )}
          style={{ minHeight: MIN_HEIGHT, maxHeight: MAX_HEIGHT }}
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
            disabled={remainingSlots === 0}
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
              'transition-all duration-150 ease-out outline-none focus-ring'
            )}
          >
            <ImagePlus size={14} className="stroke-[2.25]" />
          </button>
          {attachments.length > 0 && (
            <MetaLabel>
              {attachments.length}/{MAX_IMAGES_PER_MESSAGE}
            </MetaLabel>
          )}
        </div>
        <div className="absolute right-3 bottom-1.5 flex items-center gap-2">
          {pendingDiffCommentsCount > 0 && (
            <Button
              variant="ghost"
              size="xs"
              title={t('task303.diffCommentsPendingChip', { count: pendingDiffCommentsCount })}
              onClick={() => {
                // Locate the first pending diff comment for this session
                // (sorted by file path asc, then line asc, then createdAt asc —
                // matches the deterministic order used by
                // serializeDiffCommentsForPrompt) and scroll the chip into
                // view. If the chip isn't currently mounted (chat scrolled
                // away, file collapsed, etc.) we silently no-op rather than
                // log — there's no useful action the user could take.
                const bucket = useStore.getState().pendingDiffComments[sessionId];
                if (!bucket) return;
                const list = Object.values(bucket);
                if (list.length === 0) return;
                list.sort((a, b) => {
                  if (a.file !== b.file) return a.file < b.file ? -1 : 1;
                  if (a.line !== b.line) return a.line - b.line;
                  return a.createdAt - b.createdAt;
                });
                const first = list[0];
                const el = document.querySelector(
                  `[data-diff-comment-id="${first.id}"]`
                ) as HTMLElement | null;
                if (!el) return;
                el.scrollIntoView({ behavior: 'smooth', block: 'center' });
              }}
              className="font-mono text-mono-xs tracking-wider text-fg-tertiary"
            >
              {t('task303.diffCommentsPendingChip', { count: pendingDiffCommentsCount })}
            </Button>
          )}
          {queueLength > 0 && (
            <MetaLabel title={t('chat.queueChip', { count: queueLength })}>
              {t('chat.queueChip', { count: queueLength })}
            </MetaLabel>
          )}
          {running ? (
            <>
              {!sendDisabled && (
                <Button
                  variant="secondary"
                  size="sm"
                  aria-label={t('chat.queueAria')}
                  onClick={() => void send()}
                >
                  <ArrowUp size={10} className="stroke-[2.25]" />
                  <span>{t('chat.queueButton')}</span>
                </Button>
              )}
              <Button
                variant="danger"
                size="sm"
                aria-label={t('chat.stopAria')}
                onClick={stop}
              >
                <Square size={10} className="stroke-[2.25]" />
                <span>{t('chat.stopBtn')}</span>
              </Button>
            </>
          ) : (
            <Button
              variant="primary"
              size="sm"
              aria-label={t('chat.sendMessage')}
              disabled={sendDisabled}
              onClick={() => void send()}
            >
              <ArrowUp size={10} className="stroke-[2.25]" />
              <span>{t('chat.sendButton')}</span>
            </Button>
          )}
        </div>
      </div>

      {/* Shortcut hints — one terse muted line below the composer. Swaps to
          "Esc to stop" while a turn is running so the user always sees the
          most relevant shortcut for the current state. */}
      <div
        className="mt-1 px-1 font-mono text-mono-xs text-fg-disabled select-none"
        aria-hidden
      >
        {running ? t('chat.escToStop') : t('chat.enterToSend')}
      </div>
    </div>
  );
}
