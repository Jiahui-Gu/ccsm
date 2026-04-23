import React, { useEffect, useMemo, useRef } from 'react';
import { cn } from '../lib/cn';
import {
  filterSlashCommands,
  groupSlashCommands,
  type SlashCommand,
  type SlashCommandSource,
} from '../slash-commands/registry';
import { useTranslation } from '../i18n/useTranslation';

type Props = {
  open: boolean;
  query: string;
  /**
   * The full command list (built-ins ⊕ disk-discovered) the parent
   * maintains. We re-filter here against `query` so the picker stays a
   * dumb consumer.
   */
  commands: SlashCommand[];
  // Controlled highlighted index into the FILTERED list (flat, not grouped).
  activeIndex: number;
  onActiveIndexChange: (i: number) => void;
  // Called when user clicks a row.
  onSelect: (cmd: SlashCommand) => void;
  onFilteredChange?: (cmds: SlashCommand[]) => void;
};

const GROUP_LABEL_KEY: Record<SlashCommandSource, string> = {
  'built-in': 'slashCommands.groupBuiltIn',
  user: 'slashCommands.groupUser',
  project: 'slashCommands.groupProject',
  plugin: 'slashCommands.groupPlugin',
};

// In-chat slash-command picker. Anchored visually above the InputBar by
// the caller. Now renders results in source-grouped sections (built-in /
// user / project / plugin) with sticky headings.
export function SlashCommandPicker({
  open,
  query,
  commands,
  activeIndex,
  onActiveIndexChange,
  onSelect,
  onFilteredChange,
}: Props) {
  const { t } = useTranslation();
  const listRef = useRef<HTMLDivElement>(null);
  const rowsRef = useRef<Array<HTMLButtonElement | null>>([]);

  const filtered = useMemo(
    () => filterSlashCommands(commands, query),
    [commands, query]
  );
  const groups = useMemo(() => groupSlashCommands(filtered), [filtered]);

  useEffect(() => {
    onFilteredChange?.(filtered);
  }, [filtered, onFilteredChange]);

  useEffect(() => {
    if (!open) return;
    const row = rowsRef.current[activeIndex];
    if (row && typeof row.scrollIntoView === 'function') {
      row.scrollIntoView({ block: 'nearest' });
    }
  }, [activeIndex, open]);

  if (!open) return null;

  // Keep the rowsRef array sized to the number of filtered commands so
  // stale refs from previous renders don't leak into scrollIntoView.
  rowsRef.current.length = filtered.length;

  // Walk groups and assign each row its index into the FLAT filtered list,
  // so highlight + keyboard nav work uniformly across groups.
  let flatIdx = 0;

  const activeCmd = filtered[activeIndex];
  // a11y: build a "Result N of M: /name" string the SR will speak whenever
  // activeIndex changes. Kept in a separate live region so the listbox
  // itself stays uncluttered. When there are no matches we leave the live
  // region empty (the visible empty-state copy already conveys the state).
  const announcement = activeCmd
    ? t('slashCommands.activeAnnouncement', {
        index: activeIndex + 1,
        total: filtered.length,
        name: activeCmd.name,
        defaultValue: `Result ${activeIndex + 1} of ${filtered.length}: /${activeCmd.name}`
      })
    : '';
  const activeOptionId = activeCmd
    ? `slash-cmd-option-${activeCmd.name}`
    : undefined;

  return (
    <div
      role="listbox"
      aria-label={t('slashCommands.pickerTitle')}
      aria-activedescendant={activeOptionId}
      className={cn(
        'absolute left-0 right-0 bottom-full mb-1.5 z-30',
        'rounded-md border border-border-default bg-bg-elevated',
        'surface-highlight shadow-[var(--surface-shadow)]',
        'text-sm text-fg-secondary overflow-hidden',
        'animate-[menuIn_140ms_cubic-bezier(0.32,0.72,0,1)]'
      )}
    >
      {/* Off-screen polite live region announcing the highlighted result. */}
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        {announcement}
      </div>
      <div ref={listRef} className="max-h-[320px] overflow-y-auto py-1">
        {filtered.length === 0 ? (
          <div className="px-3 py-2 text-fg-tertiary text-mono-md leading-[16px]">
            {t('slashCommands.noneHint')}
          </div>
        ) : (
          groups.map((group) => (
            <div key={group.source} className="py-0.5">
              <div className="px-3 pt-1.5 pb-1 font-mono text-mono-xs uppercase tracking-wider text-fg-tertiary select-none">
                {t(GROUP_LABEL_KEY[group.source])}
              </div>
              {group.commands.map((cmd) => {
                const myIdx = flatIdx++;
                const Icon = cmd.icon;
                const active = myIdx === activeIndex;
                return (
                  <button
                    key={`${group.source}:${cmd.name}`}
                    id={`slash-cmd-option-${cmd.name}`}
                    ref={(el) => {
                      rowsRef.current[myIdx] = el;
                    }}
                    role="option"
                    aria-selected={active}
                    type="button"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      onSelect(cmd);
                    }}
                    onMouseEnter={() => onActiveIndexChange(myIdx)}
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
                    <span className="font-mono text-mono-md text-fg-primary shrink-0">
                      /{cmd.name}
                    </span>
                    {cmd.description ? (
                      <span className="text-fg-tertiary text-mono-md leading-[16px] truncate">
                        {cmd.description}
                      </span>
                    ) : null}
                    {cmd.argumentHint ? (
                      <span
                        className="ml-auto shrink-0 text-mono-xs uppercase tracking-wider text-fg-tertiary px-1.5 py-0.5 rounded-sm border border-border-subtle font-mono"
                        title={cmd.argumentHint}
                      >
                        {cmd.argumentHint}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          ))
        )}
      </div>
      <div className="px-3 py-1.5 border-t border-border-subtle text-mono-sm text-fg-tertiary flex items-center gap-3 select-none bg-bg-panel/40">
        <span>
          <kbd className="font-mono">↑↓</kbd> {t('slashCommands.navigate')}
        </span>
        <span>
          <kbd className="font-mono">Enter</kbd> {t('slashCommands.select')}
        </span>
        <span>
          <kbd className="font-mono">Tab</kbd> {t('slashCommands.complete')}
        </span>
        <span>
          <kbd className="font-mono">Esc</kbd> {t('slashCommands.close')}
        </span>
      </div>
    </div>
  );
}
