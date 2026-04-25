import React, { useEffect, useRef } from 'react';
import { FileText } from 'lucide-react';
import { cn } from '../lib/cn';
import type { WorkspaceFile } from '../shared/ipc-types';
import { useTranslation } from '../i18n/useTranslation';

type Props = {
  open: boolean;
  query: string;
  // Already-filtered list (parent runs `filterMentionFiles`) so the picker
  // stays a dumb consumer, mirroring SlashCommandPicker.
  files: WorkspaceFile[];
  activeIndex: number;
  onActiveIndexChange: (i: number) => void;
  onSelect: (f: WorkspaceFile) => void;
};

// In-chat @file mention picker. Anchored above the InputBar by the caller,
// same positioning rules as the slash-command picker.
export function MentionPicker({
  open,
  query,
  files,
  activeIndex,
  onActiveIndexChange,
  onSelect,
}: Props) {
  const { t } = useTranslation();
  const listRef = useRef<HTMLDivElement>(null);
  const rowsRef = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    if (!open) return;
    const row = rowsRef.current[activeIndex];
    if (row && typeof row.scrollIntoView === 'function') {
      row.scrollIntoView({ block: 'nearest' });
    }
  }, [activeIndex, open]);

  if (!open) return null;

  rowsRef.current.length = files.length;

  const activeFile = files[activeIndex];
  const announcement = activeFile
    ? t('mentions.activeAnnouncement', {
        index: activeIndex + 1,
        total: files.length,
        name: activeFile.path,
        defaultValue: `Result ${activeIndex + 1} of ${files.length}: ${activeFile.path}`,
      })
    : '';
  const activeOptionId = activeFile
    ? `mention-option-${activeFile.path.replace(/[^a-zA-Z0-9]/g, '-')}`
    : undefined;

  return (
    <div
      role="listbox"
      aria-label={t('mentions.pickerTitle')}
      aria-activedescendant={activeOptionId}
      className={cn(
        'absolute left-0 right-0 bottom-full mb-1.5 z-30',
        'rounded-md border border-border-default bg-bg-elevated',
        'surface-highlight shadow-[var(--surface-shadow)]',
        'text-chrome text-fg-secondary overflow-hidden',
        'animate-[menuIn_140ms_cubic-bezier(0.32,0.72,0,1)]'
      )}
    >
      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {announcement}
      </div>
      <div ref={listRef} className="max-h-[320px] overflow-y-auto py-1">
        {files.length === 0 ? (
          <div className="px-3 py-2 text-fg-tertiary text-mono-md leading-[16px]">
            {query ? t('mentions.noMatch', { query }) : t('mentions.empty')}
          </div>
        ) : (
          files.map((f, idx) => {
            const active = idx === activeIndex;
            // Render basename bold, dim parent path so the user can scan
            // names without reading the full slash chain.
            const slash = f.path.lastIndexOf('/');
            const dir = slash === -1 ? '' : f.path.slice(0, slash + 1);
            const base = slash === -1 ? f.path : f.path.slice(slash + 1);
            return (
              <button
                key={f.path}
                id={`mention-option-${f.path.replace(/[^a-zA-Z0-9]/g, '-')}`}
                ref={(el) => {
                  rowsRef.current[idx] = el;
                }}
                role="option"
                aria-selected={active}
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  onSelect(f);
                }}
                onMouseEnter={() => onActiveIndexChange(idx)}
                className={cn(
                  'w-full flex items-center gap-2.5 h-8 pl-3 pr-3',
                  'text-left select-none outline-none',
                  'transition-[background-color,box-shadow,border-color] duration-150',
                  '[transition-timing-function:cubic-bezier(0.32,0.72,0,1)]',
                  'border-l-2 border-transparent',
                  active
                    ? 'bg-bg-hover text-fg-primary border-l-accent shadow-[inset_0_1px_0_0_oklch(1_0_0_/_0.05)]'
                    : 'hover:bg-bg-hover/60'
                )}
              >
                <FileText
                  size={14}
                  className={cn(
                    'shrink-0 stroke-[1.75]',
                    active ? 'text-accent' : 'text-fg-tertiary'
                  )}
                />
                <span className="font-mono text-mono-md text-fg-primary truncate">
                  {dir ? <span className="text-fg-tertiary">{dir}</span> : null}
                  <span>{base}</span>
                </span>
              </button>
            );
          })
        )}
      </div>
      <div className="px-3 py-1.5 border-t border-border-subtle text-mono-sm text-fg-tertiary flex items-center gap-3 select-none bg-bg-panel/40">
        <span>
          <kbd className="font-mono">↑↓</kbd> {t('mentions.navigate')}
        </span>
        <span>
          <kbd className="font-mono">Enter</kbd> {t('mentions.select')}
        </span>
        <span>
          <kbd className="font-mono">Esc</kbd> {t('mentions.close')}
        </span>
      </div>
    </div>
  );
}
