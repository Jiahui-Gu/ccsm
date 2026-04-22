// In-chat model picker. Opened by `/model` (via the slash-command UI bridge)
// or programmatically. Lists every model the renderer has discovered from
// `~/.claude/settings.json` + env (see store.loadModels) and writes the
// selection back through `setModel`, which also notifies the running agent.
//
// Visually a roving Radix Dialog: arrow keys move the highlight, Enter
// commits, Escape closes. Non-destructive — closing without picking leaves
// the current model untouched.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Cpu, Check } from 'lucide-react';
import { Dialog, DialogContent } from './ui/Dialog';
import { useStore } from '../stores/store';
import { cn } from '../lib/cn';
import { useTranslation } from '../i18n/useTranslation';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function ModelPickerDialog({ open, onOpenChange }: Props) {
  const { t } = useTranslation();
  const models = useStore((s) => s.models);
  const modelsLoaded = useStore((s) => s.modelsLoaded);
  const sessions = useStore((s) => s.sessions);
  const activeId = useStore((s) => s.activeId);
  const fallbackModel = useStore((s) => s.model);
  const setModel = useStore((s) => s.setModel);

  const active = useMemo(
    () => sessions.find((s) => s.id === activeId),
    [sessions, activeId]
  );
  const currentModel = active?.model || fallbackModel;

  // Highlight starts on the current model when known, else first row.
  const initialIndex = useMemo(() => {
    if (!currentModel) return 0;
    const i = models.findIndex((m) => m.id === currentModel);
    return i === -1 ? 0 : i;
  }, [models, currentModel]);

  const [activeIndex, setActiveIndex] = useState(initialIndex);
  useEffect(() => {
    if (open) setActiveIndex(initialIndex);
  }, [open, initialIndex]);

  // Each row gets a ref so we can scroll the highlighted one into view.
  const rowRefs = useRef<Array<HTMLButtonElement | null>>([]);
  useEffect(() => {
    if (!open) return;
    rowRefs.current[activeIndex]?.scrollIntoView({ block: 'nearest' });
  }, [open, activeIndex]);

  function commit(id: string) {
    setModel(id);
    onOpenChange(false);
  }

  function onKey(e: React.KeyboardEvent<HTMLDivElement>) {
    if (models.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % models.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => (i - 1 + models.length) % models.length);
    } else if (e.key === 'Home') {
      e.preventDefault();
      setActiveIndex(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setActiveIndex(models.length - 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const m = models[activeIndex];
      if (m) commit(m.id);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={t('modelPicker.title')}
        description={t('modelPicker.description')}
        width="520px"
        // Keep keyboard focus on the dialog content so arrow keys / Enter work
        // immediately without a per-row tab dance.
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          // Defer so the dialog is mounted before we focus it.
          requestAnimationFrame(() => {
            const el = document.querySelector<HTMLElement>(
              '[data-model-picker-listbox]'
            );
            el?.focus();
          });
        }}
      >
        <div
          role="listbox"
          aria-label={t('modelPicker.title')}
          tabIndex={0}
          data-model-picker-listbox
          onKeyDown={onKey}
          className="max-h-[360px] overflow-y-auto px-2 pb-3 outline-none"
        >
          {!modelsLoaded && (
            <div className="px-3 py-6 text-sm text-fg-tertiary text-center">
              {t('statusBar.loading')}
            </div>
          )}
          {modelsLoaded && models.length === 0 && (
            <div className="px-3 py-6 text-sm text-fg-tertiary text-center">
              {t('statusBar.noModelsHint')}
            </div>
          )}
          {modelsLoaded &&
            models.map((m, i) => {
              const selected = m.id === currentModel;
              const highlighted = i === activeIndex;
              return (
                <button
                  key={m.id}
                  ref={(el) => {
                    rowRefs.current[i] = el;
                  }}
                  type="button"
                  role="option"
                  aria-selected={highlighted}
                  data-current={selected || undefined}
                  onMouseEnter={() => setActiveIndex(i)}
                  onClick={() => commit(m.id)}
                  className={cn(
                    'w-full flex items-center gap-2 px-3 py-2 rounded-sm',
                    'text-left text-sm font-mono',
                    'transition-colors duration-120 ease-out outline-none',
                    highlighted
                      ? 'bg-bg-hover text-fg-primary'
                      : 'text-fg-secondary hover:bg-bg-hover'
                  )}
                >
                  <Cpu
                    size={13}
                    className="stroke-[1.75] shrink-0 text-fg-tertiary"
                  />
                  <span className="flex-1 truncate">{m.id}</span>
                  <span className="text-[11px] text-fg-disabled font-mono shrink-0">
                    {m.source}
                  </span>
                  {selected && (
                    <Check
                      size={13}
                      className="stroke-[2] shrink-0 text-state-success"
                      aria-label={t('modelPicker.current')}
                    />
                  )}
                </button>
              );
            })}
        </div>
      </DialogContent>
    </Dialog>
  );
}
