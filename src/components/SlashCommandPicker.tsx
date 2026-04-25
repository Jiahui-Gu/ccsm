import React, { useEffect, useMemo, useRef } from 'react';
import { cn } from '../lib/cn';
import {
  filterSlashCommands,
  groupSlashCommands,
  type SlashCommand,
  type SlashCommandSource,
} from '../slash-commands/registry';
import { useTranslation } from '../i18n/useTranslation';
import { MetaLabel } from './ui/MetaLabel';
import { useStore } from '../stores/store';

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
  skill: 'slashCommands.groupSkill',
  agent: 'slashCommands.groupAgent',
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

  // Snapshot the current session's thinking state so the `/think` row's
  // trailing Switch reflects the live toggle (off vs default_on). Read here
  // rather than threaded through props so the picker stays a self-contained
  // listbox the caller can drop in without rewiring on every store-shape
  // change. Selectors are narrow so unrelated store updates don't re-render
  // the picker.
  const activeSessionId = useStore((s) => s.activeId);
  const thinkingLevel = useStore(
    (s) => s.thinkingLevelBySession[s.activeId] ?? s.globalThinkingDefault,
  );
  // Suppress unused-var warning — kept around so future trailing slots can
  // key off the active session id without re-plumbing a selector.
  void activeSessionId;

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
        'text-chrome text-fg-secondary overflow-hidden',
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
              <MetaLabel className="block px-3 pt-1.5 pb-1">
                {t(GROUP_LABEL_KEY[group.source])}
              </MetaLabel>
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
                    {(() => {
                      // Trailing slot: renders right-aligned. Built-in
                      // `/think` gets a live Switch reflecting the current
                      // session's thinking level (off vs default_on).
                      // Mirrors upstream extension v2.1.120's "Thinking"
                      // Command Palette row, which uses the same Switch
                      // affordance. The Switch is purely indicative — Enter
                      // / click selects the row, which dispatches the toggle
                      // through the same path as keyboard activation.
                      // pointer-events disabled so a click on the thumb
                      // still bubbles to the row's onMouseDown.
                      const isThink =
                        cmd.source === 'built-in' && cmd.name === 'think';
                      // Visual-only Switch facsimile. We can't drop the real
                      // <Switch> (Radix renders a <button>) inside the row
                      // <button> — invalid DOM nesting trips React's
                      // validateDOMNesting in strict-mode and breaks
                      // hit-testing on real browsers. The matching aria
                      // semantics live on the row itself (selecting the row
                      // toggles the level), so the trailing slot is purely
                      // an indicator. Sized to match `<Switch>` (h-4 w-7
                      // track, h-3 w-3 thumb) so the look is identical.
                      const isOn = thinkingLevel === 'default_on';
                      const trailing = isThink ? (
                        <span
                          aria-hidden="true"
                          data-testid="slash-think-switch"
                          data-state={isOn ? 'checked' : 'unchecked'}
                          className={cn(
                            'relative inline-flex h-4 w-7 shrink-0 items-center rounded-full',
                            'transition-colors duration-150',
                            isOn ? 'bg-accent' : 'bg-border-strong'
                          )}
                        >
                          <span
                            className={cn(
                              'block h-3 w-3 rounded-full bg-white shadow-sm',
                              'transition-transform duration-150 ease-out',
                              isOn ? 'translate-x-[14px]' : 'translate-x-0.5'
                            )}
                          />
                        </span>
                      ) : (
                        cmd.trailingComponent ?? null
                      );
                      return trailing ? (
                        <span
                          className={cn(
                            'shrink-0 flex items-center',
                            !cmd.argumentHint && 'ml-auto'
                          )}
                        >
                          {trailing}
                        </span>
                      ) : null;
                    })()}
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
          <kbd className="font-mono">Tab</kbd> {t('slashCommands.section')}
        </span>
        <span>
          <kbd className="font-mono">Esc</kbd> {t('slashCommands.close')}
        </span>
      </div>
    </div>
  );
}
