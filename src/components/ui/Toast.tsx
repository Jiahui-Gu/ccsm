import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { AlertCircle, Info, X } from 'lucide-react';
import { cn } from '../../lib/cn';
import { StateGlyph } from './StateGlyph';
import { Button } from './Button';
import { useTranslation } from '../../i18n/useTranslation';
import { DURATION_RAW, EASING } from '../../lib/motion';

export type ToastKind = 'info' | 'waiting' | 'error';

export type ToastAction = {
  label: string;
  onClick: () => void;
};

type Toast = {
  id: string;
  kind: ToastKind;
  title: string;
  body?: string;
  action?: ToastAction;
  // When true, the toast stays until explicitly dismissed (no auto-timer).
  persistent?: boolean;
};

type ToastCtx = {
  push: (t: Omit<Toast, 'id'>) => string;
  dismiss: (id: string) => void;
};

const Ctx = createContext<ToastCtx | null>(null);

const MAX = 3;
const TTL_MS = 3000;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation();
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef(new Map<string, number>());

  const dismiss = useCallback((id: string) => {
    setToasts((xs) => xs.filter((t) => t.id !== id));
    const h = timers.current.get(id);
    if (h) {
      window.clearTimeout(h);
      timers.current.delete(id);
    }
  }, []);

  const push = useCallback(
    (t: Omit<Toast, 'id'>) => {
      const id = Math.random().toString(36).slice(2, 10);
      setToasts((xs) => {
        // Drop the oldest when at cap — newest toast always wins a slot so
        // burst events (e.g. many sessions going Waiting) remain visible.
        const next = xs.length >= MAX ? xs.slice(xs.length - MAX + 1) : xs;
        return [...next, { ...t, id }];
      });
      // Persistent toasts stay until explicitly dismissed — used for "update
      // downloaded, restart to apply" where dropping the toast before the
      // user clicks would hide the only affordance.
      if (!t.persistent) {
        const h = window.setTimeout(() => dismiss(id), TTL_MS);
        timers.current.set(id, h);
      }
      return id;
    },
    [dismiss]
  );

  const value = useMemo(() => ({ push, dismiss }), [push, dismiss]);

  // Expose toast push/dismiss on `window` for E2E probes (#298 toast-a11y
  // case in scripts/harness-ui.mjs). Same debug-affordance pattern as
  // `window.__ccsmStore` / `window.__ccsmI18n` — set unconditionally
  // because production builds dead-strip NODE_ENV-gated branches.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    (window as unknown as { __ccsmToast?: ToastCtx }).__ccsmToast = value;
    return () => {
      delete (window as unknown as { __ccsmToast?: ToastCtx }).__ccsmToast;
    };
  }, [value]);

  // Esc dismisses the most recent toast — keyboard parity for users who
  // can't reach the close button via mouse. Only fires when at least one
  // toast is mounted so it doesn't swallow Esc elsewhere in the app.
  useEffect(() => {
    if (toasts.length === 0) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        const newest = toasts[toasts.length - 1];
        if (newest) dismiss(newest.id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toasts, dismiss]);

  // Split error toasts into their own region so we can apply the
  // assertive aria-live politeness without escalating non-error toasts
  // (which would over-announce routine "Saved" / "Connecting…" messages).
  const errors = toasts.filter((x) => x.kind === 'error');
  const others = toasts.filter((x) => x.kind !== 'error');

  return (
    <Ctx.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed bottom-3 right-3 z-[60] flex flex-col gap-2 w-[320px]">
        {/*
         * Two stacked regions:
         *  - role="alert" + aria-live="assertive" for errors (interrupt SR).
         *  - role="status" + aria-live="polite" for info/waiting (queued).
         * Per WAI-ARIA APG, mixing politeness levels in one live region is
         * undefined behavior, so we keep them physically separate.
         */}
        <div role="alert" aria-live="assertive" aria-atomic="false" className="contents">
          <AnimatePresence initial={false}>
            {errors.map((toast) => (
              <ToastItem key={toast.id} toast={toast} onDismiss={dismiss} dismissLabel={t('toast.dismiss')} />
            ))}
          </AnimatePresence>
        </div>
        <div role="status" aria-live="polite" aria-atomic="false" className="contents">
          <AnimatePresence initial={false}>
            {others.map((toast) => (
              <ToastItem key={toast.id} toast={toast} onDismiss={dismiss} dismissLabel={t('toast.dismiss')} />
            ))}
          </AnimatePresence>
        </div>
      </div>
    </Ctx.Provider>
  );
}

function ToastItem({
  toast,
  onDismiss,
  dismissLabel,
}: {
  toast: Toast;
  onDismiss: (id: string) => void;
  dismissLabel: string;
}) {
  return (
    <motion.div
      data-testid={`toast-${toast.kind}`}
      data-toast-id={toast.id}
      layout
      initial={{ opacity: 0, y: 8, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 4, scale: 0.98 }}
      transition={{ duration: DURATION_RAW.ms200, ease: EASING.standard }}
      className={cn(
        'pointer-events-auto relative rounded-md border pl-3 pr-8 py-2.5',
        'bg-bg-elevated surface-highlight surface-elevated',
        toast.kind === 'error'
          ? 'border-state-error/40'
          : toast.kind === 'waiting'
            ? 'border-state-waiting/40'
            : 'border-border-default'
      )}
    >
      <div className="flex items-start gap-2">
        {toast.kind === 'error' && (
          <AlertCircle
            aria-hidden="true"
            className="mt-0.5 shrink-0 text-state-error h-3.5 w-3.5"
          />
        )}
        {toast.kind === 'info' && (
          <Info aria-hidden="true" className="mt-0.5 shrink-0 text-state-running h-3.5 w-3.5" />
        )}
        {toast.kind === 'waiting' && (
          <StateGlyph state="waiting" size="sm" className="mt-0.5 shrink-0" />
        )}
        <div className="min-w-0 flex-1">
          <div className="text-chrome font-medium text-fg-primary leading-tight">{toast.title}</div>
          {toast.body && <div className="mt-0.5 text-meta text-fg-tertiary">{toast.body}</div>}
          {toast.action && (
            <div className="mt-2 flex items-center gap-2">
              <Button
                variant="secondary"
                size="xs"
                onClick={() => {
                  // Caller controls dismiss — they may want the toast to
                  // stay (e.g. "Retry" in flight) or replace it with a
                  // follow-up. We don't auto-dismiss here.
                  toast.action!.onClick();
                }}
              >
                {toast.action.label}
              </Button>
            </div>
          )}
        </div>
      </div>
      {/*
       * Explicit close affordance — replaces the previous "click anywhere
       * on the toast body to dismiss" behavior. Body clicks were risky
       * because they fired through links/text selection; restricting
       * dismiss to this button (and the Esc key) keeps the toast from
       * disappearing under the user's cursor.
       */}
      <button
        type="button"
        aria-label={dismissLabel}
        onClick={(e) => {
          e.stopPropagation();
          onDismiss(toast.id);
        }}
        className={cn(
          'absolute top-1.5 right-1.5 inline-flex h-5 w-5 items-center justify-center',
          'rounded text-fg-tertiary hover:text-fg-primary hover:bg-bg-hover',
          'transition-colors duration-150',
          'focus:outline-none focus-visible:ring-1 focus-visible:ring-border-strong'
        )}
      >
        <X aria-hidden="true" className="h-3 w-3" />
      </button>
    </motion.div>
  );
}

export function useToast() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>');
  return ctx;
}
