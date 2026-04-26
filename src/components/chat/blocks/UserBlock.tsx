import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pencil, RotateCw, Copy, Check, Scissors } from 'lucide-react';
import { Tooltip } from '../../ui/Tooltip';
import type { ImageAttachment } from '../../../types';
import { attachmentToDataUrl, formatSize } from '../../../lib/attachments';
import { useStore } from '../../../stores/store';
import { getDraft } from '../../../stores/drafts';

// User message block. Hovering anywhere over the block reveals a single-row
// icon group (Edit / Retry / Copy / Truncate) on the right edge of the row.
//
// Upstream `webview/index.js` puts the same intent behind one ⤺ button + a
// popup with three options ("Fork conversation from here", "Rewind code to
// here", "Fork conversation and rewind code"). Per the user's spec we surface
// the four primary verbs as inline icons instead — fewer clicks, no popup,
// and matches the verbs CCSM users actually asked for. Keyboard shortcuts are
// intentionally NOT wired (per user instruction).
//
// Truncate semantics (renamed from "Rewind" to avoid colliding with the
// upstream SDK's `canRewind` control RPC, which actually reverts FILE edits):
// the store's `rewindToBlock` action drops the in-memory transcript at the
// chosen user message, drops `resumeSessionId`, clears started/running/queue
// flags, and best-effort-closes the running agent. The next message respawns
// `claude.exe` with no `--resume`, so the model starts fresh from the
// truncation point. The CLI's on-disk JSONL is intentionally untouched —
// matches the rest of CCSM's "we don't rewrite CLI history" policy. To keep
// the truncation alive across a ccsm restart (which re-hydrates the JSONL)
// the action also persists a `{ blockId, truncatedAt }` marker via
// `truncation:set`; `loadMessages` consults it after projecting frames and
// re-applies the cut. The internal action name `rewindToBlock` is kept for
// API stability; only the user-facing label changed.
export function UserBlock({
  id,
  text,
  images,
  sessionId
}: {
  id: string;
  text: string;
  images?: ImageAttachment[];
  sessionId: string;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  // Two short-lived flash states: Edit-stashed-draft toast + Retry-queued
  // toast. Both use the action button's tooltip surface for feedback so we
  // don't add new chat blocks for a transient signal.
  const [draftStashed, setDraftStashed] = useState(false);
  const [queued, setQueued] = useState(false);
  // Track the visibility timers so unmount mid-flash doesn't try to setState
  // on a torn-down component.
  const draftStashedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queuedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (draftStashedTimer.current) clearTimeout(draftStashedTimer.current);
      if (queuedTimer.current) clearTimeout(queuedTimer.current);
    };
  }, []);

  async function handleCopy() {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — silently no-op rather than spam a toast */
    }
  }

  function handleEdit() {
    // Load the original message back into the composer; the user tweaks and
    // hits send. We do NOT delete the existing turn — Edit is non-destructive
    // (use Truncate to drop the turn). This matches the upstream "Fork
    // conversation from here" verb semantically (new turn from existing
    // context).
    //
    // Reviewer Fix #3: if the composer already has a draft, blindly injecting
    // would silently obliterate it. Stash the draft into ↑/↓ recall first so
    // the user can get it back with one keystroke. Brief on-button toast
    // confirms the stash so the action isn't completely silent.
    const liveDraft = getDraft(sessionId);
    if (liveDraft && liveDraft.trim().length > 0 && liveDraft !== text) {
      useStore.getState().pushStashedDraft(sessionId, liveDraft);
      setDraftStashed(true);
      if (draftStashedTimer.current) clearTimeout(draftStashedTimer.current);
      draftStashedTimer.current = setTimeout(() => setDraftStashed(false), 1500);
    }
    useStore.getState().injectComposerText(text);
  }

  async function handleRetry() {
    if (!text) return;
    // Re-send the same prompt as a brand-new turn. Mirrors the InputBar send
    // path's local-echo-then-IPC pattern (see InputBar.tsx send()).
    const api = window.ccsm;
    if (!api) return;
    const store = useStore.getState();
    const running = !!store.runningSessions[sessionId];
    if (running) {
      // Mid-turn: queue, just like the InputBar would. Reviewer Fix #4: the
      // chat had no visible response to a queued click, leaving users unsure
      // whether anything happened. Mirror the InputBar's queueChip with a
      // brief "Queued" tooltip flash on the Retry button itself.
      store.enqueueMessage(sessionId, { text, attachments: [] });
      setQueued(true);
      if (queuedTimer.current) clearTimeout(queuedTimer.current);
      queuedTimer.current = setTimeout(() => setQueued(false), 1500);
      return;
    }
    // Local echo so the user sees their re-send instantly.
    const newId = `local-retry-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    store.appendBlocks(sessionId, [{ kind: 'user', id: newId, text }]);
    store.setRunning(sessionId, true);
    const ok = await api.agentSend(sessionId, text);
    if (!ok) {
      store.setRunning(sessionId, false);
      store.appendBlocks(sessionId, [
        { kind: 'error', id: `retry-fail-${Date.now().toString(36)}`, text: t('chat.sendFailedToDeliver') }
      ]);
    }
  }

  function handleRewind() {
    useStore.getState().rewindToBlock(sessionId, id);
  }

  return (
    // Dogfood feedback (#345): user vs assistant blocks weren't visually
    // distinct enough when scrolling — both used the same flat layout with
    // only a one-step fg-color delta and a mono prefix glyph (`>` vs `●`)
    // that read as roughly the same weight. To restore quick scannability
    // without breaking the CLI-density philosophy (no chat bubbles, no
    // strong fill colors), the user row now wears a 2px accent-quiet rail
    // on its left edge plus a saturated, semibold `>` glyph in the same
    // accent-quiet hue. The accent-quiet token is the low-chroma, "won't
    // fatigue over 8h" sibling of --color-accent (see global.css), so the
    // rail reads as "input prompt" the way a shell `$` rail reads, not as
    // a colored callout. Body text stays at fg-secondary so the assistant's
    // fg-primary still wins the brightness contest for the answer surface.
    <div
      className="group relative flex gap-3 pl-2 border-l-2 border-accent-quiet/60 text-body"
      data-type-scale-role="user-body"
      data-user-block-id={id}
    >
      <span className="text-accent-quiet select-none w-3 shrink-0 font-mono font-semibold">&gt;</span>
      <div className="min-w-0 flex-1 flex flex-col gap-1.5">
        {images && images.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {images.map((img) => (
              <a
                key={img.id}
                href={attachmentToDataUrl(img)}
                target="_blank"
                rel="noreferrer"
                title={`${img.name} · ${formatSize(img.size)}`}
                className="group/img relative block overflow-hidden rounded-sm border border-border-subtle hover:border-border-strong transition-colors duration-150 ease-out"
              >
                <img
                  src={attachmentToDataUrl(img)}
                  alt={img.name}
                  className="h-20 w-20 object-cover transition-transform duration-200 ease-out group-hover/img:scale-[1.02]"
                  draggable={false}
                />
              </a>
            ))}
          </div>
        )}
        {text && <span className="text-fg-secondary whitespace-pre-wrap">{text}</span>}
      </div>
      {/* Hover-only action row. opacity-0 by default, fades in on parent hover.
          focus-within keeps it visible while a button is keyboard-focused so
          tab-through doesn't blank the strip. While a transient flash state
          (draftStashed / queued) is active we force the row visible too so
          the toast can actually be read after the cursor moves away. */}
      <div
        data-testid="user-block-actions"
        data-flash={draftStashed || queued ? 'true' : 'false'}
        className={
          'absolute top-0 right-0 flex items-center gap-0.5 transition-opacity duration-150 group-hover:opacity-100 focus-within:opacity-100 ' +
          (draftStashed || queued ? 'opacity-100' : 'opacity-0')
        }
      >
        <Tooltip
          content={draftStashed ? t('chat.userMsgEditDraftStashed') : t('chat.userMsgEdit')}
          side="top"
        >
          <button
            type="button"
            aria-label={t('chat.userMsgEdit')}
            data-draft-stashed={draftStashed ? 'true' : 'false'}
            onClick={handleEdit}
            className="inline-grid place-items-center h-6 w-6 rounded-md text-fg-tertiary hover:bg-bg-hover hover:text-fg-primary focus-visible:bg-bg-hover focus-visible:outline-none transition-colors"
          >
            <Pencil size={13} />
          </button>
        </Tooltip>
        <Tooltip
          content={queued ? t('chat.userMsgRetryQueued') : t('chat.userMsgRetry')}
          side="top"
        >
          <button
            type="button"
            aria-label={t('chat.userMsgRetry')}
            data-queued={queued ? 'true' : 'false'}
            onClick={handleRetry}
            className="inline-grid place-items-center h-6 w-6 rounded-md text-fg-tertiary hover:bg-bg-hover hover:text-fg-primary focus-visible:bg-bg-hover focus-visible:outline-none transition-colors"
          >
            <RotateCw size={13} />
          </button>
        </Tooltip>
        <Tooltip content={copied ? t('chat.userMsgCopied') : t('chat.userMsgCopy')} side="top">
          <button
            type="button"
            aria-label={copied ? t('chat.userMsgCopied') : t('chat.userMsgCopy')}
            data-copied={copied ? 'true' : 'false'}
            onClick={handleCopy}
            className="inline-grid place-items-center h-6 w-6 rounded-md text-fg-tertiary hover:bg-bg-hover hover:text-fg-primary focus-visible:bg-bg-hover focus-visible:outline-none transition-colors"
          >
            {copied ? <Check size={13} /> : <Copy size={13} />}
          </button>
        </Tooltip>
        <Tooltip content={t('chat.userMsgRewind')} side="top">
          <button
            type="button"
            aria-label={t('chat.userMsgRewind')}
            onClick={handleRewind}
            className="inline-grid place-items-center h-6 w-6 rounded-md text-fg-tertiary hover:bg-bg-hover hover:text-fg-primary focus-visible:bg-bg-hover focus-visible:outline-none transition-colors"
          >
            {/* Scissors (vs the previous Undo2 arrow) makes the destructive,
                non-undoable nature visually distinct from Retry's RotateCw and
                signals "cut the conversation here" — matches the renamed
                "Truncate from here" label. */}
            <Scissors size={13} />
          </button>
        </Tooltip>
      </div>
    </div>
  );
}
