import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { cn } from '../../lib/cn';
import { StateGlyph } from './StateGlyph';

export type ToastKind = 'info' | 'waiting' | 'error';

type Toast = {
  id: string;
  kind: ToastKind;
  title: string;
  body?: string;
};

type ToastCtx = {
  push: (t: Omit<Toast, 'id'>) => string;
  dismiss: (id: string) => void;
};

const Ctx = createContext<ToastCtx | null>(null);

const MAX = 3;
const TTL_MS = 3000;

export function ToastProvider({ children }: { children: React.ReactNode }) {
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
      const h = window.setTimeout(() => dismiss(id), TTL_MS);
      timers.current.set(id, h);
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
          {toasts.map((t) => (
            <motion.div
              key={t.id}
              layout
              initial={{ opacity: 0, y: 8, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 4, scale: 0.98 }}
              transition={{ duration: 0.2, ease: [0.32, 0.72, 0, 1] }}
              className={cn(
                'pointer-events-auto relative rounded-md border pl-3 pr-3 py-2.5',
                'bg-bg-elevated surface-highlight surface-elevated',
                t.kind === 'error'
                  ? 'border-state-error/40'
                  : t.kind === 'waiting'
                    ? 'border-state-waiting/40'
                    : 'border-border-default'
              )}
              onClick={() => dismiss(t.id)}
              role="status"
            >
              <div className="flex items-start gap-2">
                {t.kind === 'waiting' && (
                  <StateGlyph state="waiting" size="sm" className="mt-0.5 shrink-0" />
                )}
                {t.kind === 'error' && (
                  <StateGlyph state="waiting" size="sm" className="mt-0.5 shrink-0 text-state-error" />
                )}
                {t.kind === 'info' && (
                  <StateGlyph size="sm" className="mt-0.5 shrink-0 text-state-running" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-fg-primary leading-tight">{t.title}</div>
                  {t.body && <div className="mt-0.5 text-xs text-fg-tertiary">{t.body}</div>}
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
