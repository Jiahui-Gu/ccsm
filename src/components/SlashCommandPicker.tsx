import React, { useEffect, useMemo, useRef } from 'react';
import { cn } from '../lib/cn';
import { SLASH_COMMANDS, filterSlashCommands, type SlashCommand } from '../slash-commands/registry';
import { useTranslation } from '../i18n/useTranslation';

type Props = {
  open: boolean;
  query: string;
  // Controlled highlighted index into the FILTERED list. The parent owns
  // this so keyboard navigation fired in the textarea's onKeyDown can
  // update it without going through focus.
  activeIndex: number;
  onActiveIndexChange: (i: number) => void;
  // Called when user clicks a row — parent then commits the selection
  // (replace textarea value with `/<name> `).
  onSelect: (cmd: SlashCommand) => void;
  onFilteredChange?: (cmds: SlashCommand[]) => void;
};

// In-chat slash-command picker. Anchored visually above the InputBar by
// the caller; the component itself is position-relative and fills parent
// width. Uses no new runtime deps.
export function SlashCommandPicker({
  open,
  query,
  activeIndex,
  onActiveIndexChange,
  onSelect,
  onFilteredChange
}: Props) {
  const { t } = useTranslation();
  const listRef = useRef<HTMLDivElement>(null);
  const rowsRef = useRef<Array<HTMLButtonElement | null>>([]);

  const filtered = useMemo(() => filterSlashCommands(SLASH_COMMANDS, query), [query]);

  useEffect(() => {
    onFilteredChange?.(filtered);
  }, [filtered, onFilteredChange]);

  // Auto-scroll the highlighted row into view when navigation moves
  // outside the visible window.
  useEffect(() => {
    if (!open) return;
    const row = rowsRef.current[activeIndex];
    if (row && typeof row.scrollIntoView === 'function') {
      row.scrollIntoView({ block: 'nearest' });
    }
  }, [activeIndex, open]);

  if (!open) return null;

  return (
    <div
      role="listbox"
      aria-label={t('slashCommands.pickerTitle')}
      className={cn(
        'absolute left-0 right-0 bottom-full mb-1.5 z-30',
        'rounded-md border border-border-default bg-bg-elevated',
        'surface-highlight shadow-[var(--surface-shadow)]',
        'text-sm text-fg-secondary overflow-hidden',
        'animate-[menuIn_140ms_cubic-bezier(0.32,0.72,0,1)]'
      )}
    >
      <div
        ref={listRef}
        className="max-h-[300px] overflow-y-auto py-1"
      >
        {filtered.length === 0 ? (
          <div className="px-3 py-2 text-fg-tertiary text-[12px] leading-[16px]">
            {t('slashCommands.noneHint')}
          </div>
        ) : (
          filtered.map((cmd, i) => {
            const Icon = cmd.icon;
            const active = i === activeIndex;
            return (
              <button
                key={cmd.name}
                ref={(el) => { rowsRef.current[i] = el; }}
                role="option"
                aria-selected={active}
                type="button"
                // Use onMouseDown so the textarea doesn't blur before we
                // get the click — prevents the picker from closing on
                // focus-out before onSelect fires.
                onMouseDown={(e) => {
                  e.preventDefault();
                  onSelect(cmd);
                }}
                onMouseEnter={() => onActiveIndexChange(i)}
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
                {Icon ? (
                  <Icon
                    size={14}
                    className={cn(
                      'shrink-0 stroke-[1.75]',
                      active ? 'text-accent' : 'text-fg-tertiary'
                    )}
                  />
                ) : (
                  <span className="w-[14px] shrink-0" />
                )}
                <span className="font-mono text-[12.5px] text-fg-primary shrink-0">
                  /{cmd.name}
                </span>
                <span className="text-fg-tertiary text-[12px] leading-[16px] truncate">
                  {cmd.description}
                </span>
                {cmd.clientHandler ? (
                  <span
                    className="ml-auto shrink-0 text-[10px] uppercase tracking-wider text-accent/80 px-1.5 py-0.5 rounded-sm border border-accent/40"
                    title={t('slashCommands.runsLocally')}
                  >
                    {t('slashCommands.clientTag')}
                  </span>
                ) : cmd.category && cmd.category !== 'built-in' ? (
                  <span className="ml-auto shrink-0 text-[10px] uppercase tracking-wider text-fg-tertiary px-1.5 py-0.5 rounded-sm border border-border-subtle">
                    {cmd.category}
                  </span>
                ) : null}
              </button>
            );
          })
        )}
      </div>
      <div className="px-3 py-1.5 border-t border-border-subtle text-[11px] text-fg-tertiary flex items-center gap-3 select-none bg-bg-panel/40">
        <span><kbd className="font-mono">↑↓</kbd> {t('slashCommands.navigate')}</span>
        <span><kbd className="font-mono">Enter</kbd> {t('slashCommands.select')}</span>
        <span><kbd className="font-mono">Tab</kbd> {t('slashCommands.complete')}</span>
        <span><kbd className="font-mono">Esc</kbd> {t('slashCommands.close')}</span>
      </div>
    </div>
  );
}
