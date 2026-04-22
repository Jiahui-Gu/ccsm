import React, { useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import { ShieldAlert } from 'lucide-react';
import { Button } from './ui/Button';
import { useTranslation } from '../i18n/useTranslation';

export interface PermissionPromptBlockProps {
  /** Short human description, e.g. "Bash: ls -la". Used as the fallback summary. */
  prompt: string;
  /** Raw tool name the agent is requesting permission for (e.g. "Bash"). */
  toolName?: string;
  /** Raw tool input arguments for detailed display. */
  toolInput?: Record<string, unknown>;
  onAllow?: () => void;
  onReject?: () => void;
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
  autoFocus = true
}: PermissionPromptBlockProps) {
  const { t } = useTranslation();
  const rootRef = useRef<HTMLDivElement>(null);
  const allowRef = useRef<HTMLButtonElement>(null);
  const rejectRef = useRef<HTMLButtonElement>(null);

  // Focus Reject on mount — safer default. Never steal focus away from an
  // input the user is already typing in.
  //
  // Timing note: a single rAF is enough in dev (unbundled, fast paint) but
  // races Framer Motion's transform/opacity transition under the prod bundle
  // — the button is briefly non-focusable during the enter animation. Use
  // double-rAF + setTimeout(0) fallback so we land after layout AND after
  // animation start. As a final safety net, observe the root for a beat in
  // case the button mounts late (rare under StrictMode double-invoke).
  useEffect(() => {
    if (!autoFocus) return;
    let cancelled = false;
    const raf1: number[] = [];
    const timers: ReturnType<typeof setTimeout>[] = [];
    let observer: MutationObserver | null = null;

    const shouldSkip = () => {
      const active = document.activeElement;
      if (!(active instanceof HTMLElement)) return false;
      if (active === document.body) return false;
      if (rootRef.current?.contains(active)) return false;
      const isTextEntry =
        active.tagName === 'INPUT' ||
        active.tagName === 'TEXTAREA' ||
        active.isContentEditable ||
        active.getAttribute('role') === 'combobox' ||
        active.getAttribute('role') === 'textbox';
      if (!isTextEntry) return false;
      // Only refuse to steal focus when the user has actually typed something
      // — an empty textarea (e.g. the composer freshly re-focused by our own
      // focusInputNonce bump after resolving a previous prompt) shouldn't
      // block the new prompt's autoFocus. Otherwise sequential prompts strand
      // focus in the empty composer and the second Reject never gets it.
      const value =
        active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement
          ? active.value
          : active.textContent ?? '';
      return value.trim().length > 0;
    };

    const tryFocus = () => {
      if (cancelled) return false;
      if (shouldSkip()) return true; // treat as resolved — don't keep retrying
      const btn = rejectRef.current;
      if (!btn) return false;
      btn.focus({ preventScroll: true });
      return document.activeElement === btn;
    };

    // 1st rAF -> 2nd rAF -> setTimeout(0) -> setTimeout(50). Each step retries
    // if the previous didn't actually land focus. Cheap; resolves on first hit.
    const r1 = requestAnimationFrame(() => {
      if (tryFocus()) return;
      const r2 = requestAnimationFrame(() => {
        if (tryFocus()) return;
        timers.push(
          setTimeout(() => {
            if (tryFocus()) return;
            timers.push(
              setTimeout(() => {
                if (tryFocus()) return;
                // Final safety: watch for late mount/layout via MutationObserver
                // for up to 500ms.
                if (!rootRef.current) return;
                observer = new MutationObserver(() => {
                  if (tryFocus()) observer?.disconnect();
                });
                observer.observe(rootRef.current, { childList: true, subtree: true, attributes: true });
                timers.push(setTimeout(() => observer?.disconnect(), 500));
              }, 50)
            );
          }, 0)
        );
      });
      raf1.push(r2);
    });
    raf1.push(r1);

    return () => {
      cancelled = true;
      for (const id of raf1) cancelAnimationFrame(id);
      for (const t of timers) clearTimeout(t);
      observer?.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Global-ish Y/N hotkeys, scoped to this prompt: we only listen while
  // mounted and only fire if the user isn't currently typing into an input /
  // textarea / contenteditable.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const active = document.activeElement;
      const typing =
        active instanceof HTMLElement &&
        (active.tagName === 'INPUT' ||
          active.tagName === 'TEXTAREA' ||
          active.isContentEditable);
      // If typing AND focus is outside our prompt, don't hijack.
      if (typing && !rootRef.current?.contains(active)) return;
      const key = e.key.toLowerCase();
      if (key === 'y') {
        e.preventDefault();
        onAllow?.();
      } else if (key === 'n') {
        e.preventDefault();
        onReject?.();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onAllow, onReject]);

  const summary = formatToolInputSummary(toolInput);

  return (
    <motion.div
      ref={rootRef}
      role="alertdialog"
      aria-modal="false"
      aria-labelledby="perm-title"
      aria-describedby="perm-desc"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22, ease: [0.32, 0.72, 0, 1] }}
      className="relative my-2 rounded-md border border-accent/50 bg-accent/[0.06] surface-highlight surface-elevated pl-4 pr-4 py-3"
    >
      <span
        aria-hidden
        className="absolute left-0 top-0 bottom-0 w-[2px] bg-accent rounded-l-md"
      />
      <div
        id="perm-title"
        className="flex items-center gap-2 text-base text-fg-primary font-semibold"
      >
        <ShieldAlert size={14} className="text-accent" aria-hidden />
        <span>{t('permissionPrompt.title')}</span>
        {toolName && (
          <span className="font-mono text-xs text-fg-tertiary uppercase tracking-wider">
            {toolName}
          </span>
        )}
      </div>
      <div id="perm-desc" className="mt-2 font-mono text-sm text-fg-secondary whitespace-pre-wrap break-words">
        {prompt}
      </div>
      {summary.length > 0 && (
        <dl className="mt-2 rounded-sm border border-border-subtle bg-bg-app/40 px-3 py-2 font-mono text-xs text-fg-secondary">
          {summary.map(({ key, value }) => (
            <div key={key} className="flex gap-2 py-0.5">
              <dt className="text-fg-tertiary shrink-0">{key}</dt>
              <dd className="min-w-0 break-words whitespace-pre-wrap text-fg-primary">
                {value.length > 400 ? value.slice(0, 400) + '…' : value}
              </dd>
            </div>
          ))}
        </dl>
      )}
      <div className="mt-3 flex items-center justify-end gap-2">
        <Button
          ref={rejectRef}
          variant="secondary"
          size="md"
          data-perm-action="reject"
          onClick={onReject}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              onReject?.();
            }
          }}
        >
          {t('permissionPrompt.rejectBtn')}
        </Button>
        <Button
          ref={allowRef}
          variant="primary"
          size="md"
          data-perm-action="allow"
          onClick={onAllow}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              onAllow?.();
            }
          }}
        >
          {t('permissionPrompt.allowBtn')}
        </Button>
      </div>
    </motion.div>
  );
}
