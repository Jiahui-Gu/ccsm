import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { cn } from '../../lib/cn';
import { StateGlyph } from './StateGlyph';
import { useTranslation } from '../../i18n/useTranslation';

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

  return (
    <Ctx.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed bottom-3 right-3 z-[60] flex flex-col gap-2 w-[320px]">
        <AnimatePresence initial={false}>
          {toasts.map((toast) => (
            <motion.div
              key={toast.id}
              layout
              initial={{ opacity: 0, y: 8, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 4, scale: 0.98 }}
              transition={{ duration: 0.2, ease: [0.32, 0.72, 0, 1] }}
              className={cn(
                'pointer-events-auto relative rounded-md border pl-3 pr-3 py-2.5',
                'bg-bg-elevated surface-highlight surface-elevated',
                toast.kind === 'error'
                  ? 'border-state-error/40'
                  : toast.kind === 'waiting'
                    ? 'border-state-waiting/40'
                    : 'border-border-default'
              )}
              onClick={() => {
                // Persistent toasts with an action shouldn't dismiss on a
                // click anywhere — only the action button dismisses (so a
                // stray click on the toast doesn't hide "Restart").
                if (!(toast.persistent && toast.action)) dismiss(toast.id);
              }}
              role="status"
            >
              <div className="flex items-start gap-2">
                {toast.kind === 'waiting' && (
                  <StateGlyph state="waiting" size="sm" className="mt-0.5 shrink-0" />
                )}
                {toast.kind === 'error' && (
                  <StateGlyph state="waiting" size="sm" className="mt-0.5 shrink-0 text-state-error" />
                )}
                {toast.kind === 'info' && (
                  <StateGlyph size="sm" className="mt-0.5 shrink-0 text-state-running" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-fg-primary leading-tight">{toast.title}</div>
                  {toast.body && <div className="mt-0.5 text-xs text-fg-tertiary">{toast.body}</div>}
                  {toast.action && (
                    <div className="mt-2 flex items-center gap-2">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          toast.action!.onClick();
                          dismiss(toast.id);
                        }}
                        className={cn(
                          'text-xs font-medium px-2 py-1 rounded-sm',
                          'bg-bg-app border border-border-default text-fg-primary',
                          'hover:bg-bg-elevated hover:border-border-strong',
                          'active:scale-[0.98]',
                          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                          'transition-colors duration-150'
                        )}
                      >
                        {toast.action.label}
                      </button>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          dismiss(toast.id);
                        }}
                        className={cn(
                          'text-xs px-2 py-1 rounded-sm text-fg-tertiary',
                          'hover:text-fg-secondary hover:bg-bg-app',
                          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                          'transition-colors duration-150'
                        )}
                      >
                        {t('toast.dismiss')}
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </Ctx.Provider>
  );
}

export function useToast() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>');
  return ctx;
}
