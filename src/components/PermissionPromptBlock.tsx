import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { Loader2, ShieldAlert } from 'lucide-react';
import { Button } from './ui/Button';
import { useTranslation } from '../i18n/useTranslation';
import { DURATION_RAW, EASING } from '../lib/motion';
import { DiffView } from './chat/DiffView';
import { diffFromToolInput } from '../utils/diff';

export interface PermissionPromptBlockProps {
  /** Short human description, e.g. "Bash: ls -la". Used as the fallback summary. */
  prompt: string;
  /** Raw tool name the agent is requesting permission for (e.g. "Bash"). */
  toolName?: string;
  /** Raw tool input arguments for detailed display. */
  toolInput?: Record<string, unknown>;
  onAllow?: () => void;
  onReject?: () => void;
  /** Third option: allow now AND remember for the rest of this app session. */
  onAllowAlways?: () => void;
  /**
   * Per-hunk partial accept (#306). Only invoked for Edit/Write/MultiEdit
   * tool inputs that produce a parsable `DiffSpec`. Receives the array of
   * hunk indices the user wants to apply (always non-empty when called —
   * the empty selection short-circuits to `onReject`).
   */
  onAllowPartial?: (acceptedHunks: number[]) => void;
  /** When false, suppress the auto-focus-on-mount behaviour. */
  autoFocus?: boolean;
}

const PREVIEW_KEYS = ['command', 'file_path', 'path', 'pattern', 'url', 'plan'];

function formatToolInputSummary(
  input: Record<string, unknown> | undefined
): Array<{ key: string; value: string }> {
  if (!input) return [];
  const out: Array<{ key: string; value: string }> = [];
  // Show a curated subset first for predictable ordering, then any remaining
  // keys. Skip giant blobs so the prompt stays one screen — the existing
  // 400-char ellipsis at render time handles overflow.
  const seen = new Set<string>();
  const stringify = (v: unknown): string | null => {
    if (v == null) return String(v);
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      return String(v);
    }
    if (typeof v === 'object') {
      // JSON.stringify never coerces nested values to "[object Object]". Pretty
      // print so the eventual <dd whitespace-pre-wrap> renders the structure
      // legibly. Fallback to bracket notation if the object contains cycles.
      try {
        return JSON.stringify(v, null, 2);
      } catch {
        return Array.isArray(v) ? '[…]' : '{…}';
      }
    }
    return null;
  };
  for (const key of PREVIEW_KEYS) {
    if (key in input) {
      const s = stringify(input[key]);
      if (s !== null) {
        out.push({ key, value: s });
        seen.add(key);
      }
    }
  }
  for (const [key, v] of Object.entries(input)) {
    if (seen.has(key)) continue;
    const s = stringify(v);
    if (s !== null) out.push({ key, value: s });
  }
  return out;
}

export function PermissionPromptBlock({
  prompt,
  toolName,
  toolInput,
  onAllow,
  onReject,
  onAllowAlways,
  onAllowPartial,
  autoFocus = true
}: PermissionPromptBlockProps) {
  const { t } = useTranslation();
  const reactId = useId();
  const titleId = `perm-title-${reactId}`;
  const descId = `perm-desc-${reactId}`;
  const rootRef = useRef<HTMLDivElement>(null);
  const allowRef = useRef<HTMLButtonElement>(null);
  const allowAlwaysRef = useRef<HTMLButtonElement>(null);
  const rejectRef = useRef<HTMLButtonElement>(null);

  // Edit/Write/MultiEdit -> derive a DiffSpec so we can render per-hunk
  // checkboxes (#306). For all other tools the spec stays null and we keep
  // the legacy flat key/value summary path. `useMemo` so reference stays
  // stable across re-renders driven by selection toggles.
  const diffSpec = useMemo(
    () => (toolName ? diffFromToolInput(toolName, toolInput) : null),
    [toolName, toolInput]
  );
  const hunkCount = diffSpec?.hunks.length ?? 0;
  const hasHunkSelection = hunkCount > 0 && !!onAllowPartial;
  const [selection, setSelection] = useState<Set<number>>(() => {
    // Default: all hunks selected. Matches today's whole-allow behavior on
    // first interaction so a user who clicks Allow without touching the
    // checkboxes gets the same outcome as before.
    return new Set(Array.from({ length: hunkCount }, (_, i) => i));
  });
  // If the toolInput shape changes mid-prompt (rare but defensive), reseed
  // selection to "all" so we don't leave stale indices.
  useEffect(() => {
    if (!hasHunkSelection) return;
    setSelection(new Set(Array.from({ length: hunkCount }, (_, i) => i)));
  }, [hasHunkSelection, hunkCount]);
  const [resolving, setResolving] = useState(false);

  // Focus Reject on mount — safer default. Never steal focus away from any
  // text-entry surface the user is currently in (input / textarea /
  // contenteditable / combobox / textbox role).
  //
  // EXCEPTIONS:
  // 1. Sequential prompts are handled at the source: store.resolvePermission
  //    skips bumping focusInputNonce when another wait block is still
  //    pending, so the composer never steals focus between prompt #1 resolve
  //    and prompt #2 mount.
  // 2. The chat composer textarea (marked [data-input-bar]) is part of the
  //    same chat surface as this prompt. When the prompt arrives and the
  //    composer is focused but EMPTY (e.g. session-select bumped focus to a
  //    fresh composer before the wait block landed), we steal focus to
  //    Reject — the user hasn't started typing, so there's nothing to
  //    interrupt. If the composer has typed content, we leave focus alone
  //    (the user is mid-message; the prompt is still rendered, they'll act
  //    on it after they finish typing).
  // External text entries (rename input, dialog field, IME composition,
  // settings textarea) are always respected.
  useEffect(() => {
    if (!autoFocus) return;
    const raf = requestAnimationFrame(() => {
      const active = document.activeElement;
      if (active instanceof HTMLElement && active !== document.body && !rootRef.current?.contains(active)) {
        const isTextEntry =
          active.tagName === 'INPUT' ||
          active.tagName === 'TEXTAREA' ||
          active.isContentEditable ||
          active.getAttribute('role') === 'combobox' ||
          active.getAttribute('role') === 'textbox';
        if (isTextEntry) {
          const isComposer = active.hasAttribute('data-input-bar');
          if (!isComposer) return;
          // Composer-specific: only steal when it's empty.
          const value =
            active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement
              ? active.value
              : active.textContent ?? '';
          if (value.trim().length > 0) return;
        }
      }
      rejectRef.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Resolve helpers — also flip the local `resolving` flag so the buttons
  // turn into "Applying…" spinners. The wait block usually unmounts on the
  // next render after the store mutation lands, so the spinner is mostly a
  // belt-and-suspenders against double-clicks (and gives the user a beat of
  // visual feedback if the IPC path is slow).
  const guarded = (fn?: () => void) => () => {
    if (!fn || resolving) return;
    setResolving(true);
    fn();
  };
  const handleAllowPartial = () => {
    if (resolving || !onAllowPartial) return;
    const indices = Array.from(selection).sort((a, b) => a - b);
    if (indices.length === 0) {
      // 0 selected → degrade to deny. Mirrors the IPC contract where
      // acceptedHunks=[] means "deny", but using onReject keeps the trace
      // text consistent with the user's intent.
      if (onReject) {
        setResolving(true);
        onReject();
      }
      return;
    }
    if (indices.length === hunkCount && onAllow) {
      // All hunks selected → fall through to the simpler whole-allow IPC.
      // Saves the main-process `updatedInput` reconstruction for the common
      // case where the user didn't actually deselect anything.
      setResolving(true);
      onAllow();
      return;
    }
    setResolving(true);
    onAllowPartial(indices);
  };

  // Global-ish Y/N hotkeys, scoped to this prompt: we only listen while
  // mounted and only fire if the user isn't currently typing into an input /
  // textarea / contenteditable. Also wires Esc -> reject and a minimal focus
  // trap (Tab cycles only between the prompt's own buttons while focus is
  // already inside the prompt — doesn't lock focus globally so the user can
  // still click back into the composer).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const root = rootRef.current;
      if (!root) return;
      const active = document.activeElement;
      const focusInside =
        active instanceof HTMLElement && root.contains(active);

      // Focus trap: Tab cycling between Reject / Allow always / Allow while
      // focus is inside the prompt. Plain `.focus()` is enough — the buttons
      // share DOM order (Reject -> [Allow always] -> Allow).
      if (e.key === 'Tab' && focusInside && !e.ctrlKey && !e.altKey) {
        const focusables = [rejectRef.current, allowAlwaysRef.current, allowRef.current].filter(
          (b): b is HTMLButtonElement => !!b
        );
        if (focusables.length > 0) {
          const idx = focusables.indexOf(active as HTMLButtonElement);
          if (idx !== -1) {
            e.preventDefault();
            const nextIdx = e.shiftKey
              ? (idx - 1 + focusables.length) % focusables.length
              : (idx + 1) % focusables.length;
            focusables[nextIdx]?.focus({ preventScroll: true });
            return;
          }
        }
      }

      // Esc -> reject (standard alertdialog dismiss).
      if (e.key === 'Escape' && !e.ctrlKey && !e.altKey) {
        if (focusInside) {
          e.preventDefault();
          onReject?.();
          return;
        }
      }

      if (e.ctrlKey || e.altKey) return;
      const typing =
        active instanceof HTMLElement &&
        (active.tagName === 'INPUT' ||
          active.tagName === 'TEXTAREA' ||
          active.isContentEditable);
      // If typing AND focus is outside our prompt, don't hijack.
      if (typing && !focusInside) return;
      const key = e.key.toLowerCase();
      if (key === 'y') {
        e.preventDefault();
        // Y honours the per-hunk selection: same path as clicking the
        // primary button. Falls back to whole-allow when there's no diff.
        if (hasHunkSelection) handleAllowPartial();
        else onAllow?.();
      } else if (key === 'n') {
        e.preventDefault();
        onReject?.();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
    // handleAllowPartial closes over selection/resolving — keep it out of
    // the dep array intentionally (we rebuild on every keydown anyway via
    // the latest closure). onAllow/onReject identity is the meaningful dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onAllow, onReject, hasHunkSelection]);

  const summary = formatToolInputSummary(toolInput);
  const selectedCount = selection.size;
  const allSelected = hasHunkSelection && selectedCount === hunkCount;
  const noneSelected = hasHunkSelection && selectedCount === 0;
  const primaryLabel = noneSelected
    ? t('permissionPrompt.rejectAll')
    : hasHunkSelection
      ? t('permissionPrompt.allowSelected', { selected: selectedCount, total: hunkCount })
      : t('permissionPrompt.allowBtn');

  // Per-tool title — mirrors the upstream CLI's wording so users get a
  // concrete question instead of a generic "Permission required". Falls
  // back to the legacy generic title for tools we haven't enumerated yet
  // (anything outside the small set below: Bash / WebFetch / WebSearch /
  // Edit-family / Skill).
  const titleByTool = (() => {
    const name = (toolName ?? '').toLowerCase();
    if (name === 'bash') return t('permissionPrompt.titleByTool.bash');
    if (name === 'webfetch') return t('permissionPrompt.titleByTool.webFetch');
    if (name === 'websearch') return t('permissionPrompt.titleByTool.webSearch');
    if (name === 'edit' || name === 'write' || name === 'multiedit' || name === 'notebookedit') {
      return t('permissionPrompt.titleByTool.edit');
    }
    if (name === 'skill') return t('permissionPrompt.titleByTool.skill');
    return t('permissionPrompt.titleByTool.fallback');
  })();

  return (
    <motion.div
      ref={rootRef}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={descId}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: DURATION_RAW.ms220, ease: EASING.standard }}
      className="relative my-1 pl-3 pr-2 py-1.5 font-mono text-chrome"
    >
      <span
        aria-hidden
        className="absolute left-0 top-0 bottom-0 w-[2px] bg-accent rounded-l-sm"
      />
      <div
        id={titleId}
        className="flex items-baseline gap-2"
      >
        <ShieldAlert size={12} className="text-accent self-center shrink-0" aria-hidden />
        <span className="font-mono tracking-wider text-mono-xs text-accent">
          {titleByTool}
        </span>
        {toolName && (
          <span className="font-mono text-mono-xs text-fg-tertiary">
            {toolName}
          </span>
        )}
      </div>
      <div id={descId} className="mt-1 font-mono text-chrome text-fg-secondary whitespace-pre-wrap break-words">
        {prompt}
      </div>
      {hasHunkSelection && diffSpec ? (
        <div className="mt-1" data-perm-diff="">
          <div className="ml-6 mb-1 flex items-center gap-2 font-mono text-mono-xs text-fg-tertiary">
            <span>{t('permissionPrompt.allowSelected', { selected: selectedCount, total: hunkCount })}</span>
            <span aria-hidden className="text-fg-tertiary/60">·</span>
            <button
              type="button"
              data-perm-select-all=""
              disabled={resolving || allSelected}
              onClick={() =>
                setSelection(new Set(Array.from({ length: hunkCount }, (_, i) => i)))
              }
              className="px-1.5 py-0.5 rounded-sm border border-border-subtle hover:border-accent/60 hover:text-fg-secondary active:bg-bg-hover transition-colors duration-150 disabled:opacity-40 disabled:cursor-not-allowed outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              {t('permissionPrompt.selectAll')}
            </button>
            <button
              type="button"
              data-perm-select-none=""
              disabled={resolving || noneSelected}
              onClick={() => setSelection(new Set())}
              className="px-1.5 py-0.5 rounded-sm border border-border-subtle hover:border-accent/60 hover:text-fg-secondary active:bg-bg-hover transition-colors duration-150 disabled:opacity-40 disabled:cursor-not-allowed outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              {t('permissionPrompt.selectNone')}
            </button>
          </div>
          <DiffView
            diff={diffSpec}
            selection={selection}
            onSelectionChange={setSelection}
            disabled={resolving}
          />
        </div>
      ) : (
        summary.length > 0 && (
          <dl className="mt-1 border-l border-border-subtle pl-2 font-mono text-meta text-fg-secondary">
            {summary.map(({ key, value }) => (
              <div key={key} className="flex gap-2 py-0.5">
                <dt className="text-fg-tertiary shrink-0">{key}</dt>
                <dd className="min-w-0 break-words whitespace-pre-wrap text-fg-primary">
                  {value.length > 400 ? value.slice(0, 400) + '…' : value}
                </dd>
              </div>
            ))}
          </dl>
        )
      )}
      <div className="mt-2 flex items-center justify-end gap-2">
        <Button
          ref={rejectRef}
          variant="secondary"
          size="sm"
          data-perm-action="reject"
          disabled={resolving}
          onClick={guarded(onReject)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              guarded(onReject)();
            }
          }}
        >
          {t('permissionPrompt.rejectBtn')}
        </Button>
        {onAllowAlways && (
          <Button
            ref={allowAlwaysRef}
            variant="secondary"
            size="sm"
            data-perm-action="allow-always"
            // Native tooltip — quickest way to give the user the full scope
            // story without crowding the inline label. The visible label is
            // already scope-explicit; this just expands on the lifetime.
            title={
              toolName
                ? t('permissionPrompt.allowAlwaysHint', { tool: toolName })
                : t('permissionPrompt.allowAlwaysHintFallback')
            }
            disabled={resolving}
            onClick={guarded(onAllowAlways)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                guarded(onAllowAlways)();
              }
            }}
          >
            {toolName
              ? t('permissionPrompt.allowAlwaysBtn', { tool: toolName })
              : t('permissionPrompt.allowAlwaysBtnFallback')}
          </Button>
        )}
        <Button
          ref={allowRef}
          variant="primary"
          size="sm"
          data-perm-action="allow"
          disabled={resolving}
          onClick={hasHunkSelection ? handleAllowPartial : guarded(onAllow)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              if (hasHunkSelection) handleAllowPartial();
              else guarded(onAllow)();
            }
          }}
        >
          {resolving ? (
            <span className="inline-flex items-center gap-1.5">
              <Loader2 size={12} className="animate-spin" aria-hidden />
              {t('permissionPrompt.applying')}
            </span>
          ) : (
            primaryLabel
          )}
        </Button>
      </div>
    </motion.div>
  );
}
