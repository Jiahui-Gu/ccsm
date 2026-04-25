import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pencil, RotateCw, Copy, Check, Undo2 } from 'lucide-react';
import { Tooltip } from '../../ui/Tooltip';
import type { ImageAttachment } from '../../../types';
import { attachmentToDataUrl, formatSize } from '../../../lib/attachments';
import { useStore } from '../../../stores/store';

// User message block. Hovering anywhere over the block reveals a single-row
// icon group (Edit / Retry / Copy / Rewind) on the right edge of the row.
//
// Upstream `webview/index.js` puts the same intent behind one ⤺ button + a
// popup with three options ("Fork conversation from here", "Rewind code to
// here", "Fork conversation and rewind code"). Per the user's spec we surface
// the four primary verbs as inline icons instead — fewer clicks, no popup,
// and matches the verbs CCSM users actually asked for. Keyboard shortcuts are
// intentionally NOT wired (per user instruction).
//
// Rewind semantics: there's no SDK conversation-rewind RPC today (only the
// `rewind_files` control RPC schema, which reverts file edits, not the
// transcript). So "Rewind from here" is implemented locally via the store's
// `rewindToBlock` action: it truncates the in-memory transcript to the index
// of this user message, drops `resumeSessionId`, clears started/running/queue
// flags, and best-effort-closes the running agent. The next message respawns
// `claude.exe` with no `--resume`, so the model starts fresh from the
// truncation point. The CLI's on-disk JSONL is intentionally untouched —
// matches the rest of CCSM's "we don't rewrite CLI history" policy.
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
    // (use Rewind to truncate). This matches the upstream "Fork conversation
    // from here" verb semantically (new turn from the existing context).
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
      // Mid-turn: queue, just like the InputBar would.
      store.enqueueMessage(sessionId, { text, attachments: [] });
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
    <div
      className="group relative flex gap-3 text-body"
      data-type-scale-role="user-body"
      data-user-block-id={id}
    >
      <span className="text-fg-tertiary select-none w-3 shrink-0 font-mono">&gt;</span>
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
          tab-through doesn't blank the strip. */}
      <div
        data-testid="user-block-actions"
        className="absolute top-0 right-0 flex items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-within:opacity-100"
      >
        <Tooltip content={t('chat.userMsgEdit')} side="top">
          <button
            type="button"
            aria-label={t('chat.userMsgEdit')}
            onClick={handleEdit}
            className="inline-grid place-items-center h-6 w-6 rounded-md text-fg-tertiary hover:bg-bg-hover hover:text-fg-primary focus-visible:bg-bg-hover focus-visible:outline-none transition-colors"
          >
            <Pencil size={13} />
          </button>
        </Tooltip>
        <Tooltip content={t('chat.userMsgRetry')} side="top">
          <button
            type="button"
            aria-label={t('chat.userMsgRetry')}
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
            <Undo2 size={13} />
          </button>
        </Tooltip>
      </div>
    </div>
  );
}
