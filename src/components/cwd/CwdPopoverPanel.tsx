import React from 'react';
import { Folder } from 'lucide-react';
import { cn } from '../../lib/cn';
import { useTranslation } from '../../i18n/useTranslation';
import type { PanelPosition } from './useCwdPanelPosition';

export function truncateMiddle(path: string, max = 56): string {
  if (path.length <= max) return path;
  const head = Math.ceil((max - 1) / 2);
  const tail = Math.floor((max - 1) / 2);
  return `${path.slice(0, head)}…${path.slice(path.length - tail)}`;
}

export type CwdPopoverPanelProps = {
  /** Whether the panel is rendered in controlled (anchored) mode. Affects
   *  positioning classes + the inline `position: fixed` style. */
  isControlled: boolean;
  /** Measured fixed-position anchor coords (controlled mode only). */
  panelPos: PanelPosition | null;
  popRef: React.MutableRefObject<HTMLDivElement | null>;
  inputRef: React.MutableRefObject<HTMLInputElement | null>;
  cwd: string;
  query: string;
  setQuery: (q: string) => void;
  setActive: (a: number | ((prev: number) => number)) => void;
  active: number;
  filtered: string[];
  onListKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  onCommit: (path: string) => void;
  onBrowse: () => void;
  onClose: () => void;
};

/**
 * Presentational panel JSX for {@link CwdPopover}. Pure props in / JSX out;
 * owns no state. Both legacy (inline anchor) and controlled (fixed-portal)
 * modes render the same panel, only the outer wrapper styling differs.
 */
export function CwdPopoverPanel(props: CwdPopoverPanelProps) {
  const {
    isControlled,
    panelPos,
    popRef,
    inputRef,
    cwd,
    query,
    setQuery,
    setActive,
    active,
    filtered,
    onListKeyDown,
    onCommit,
    onBrowse,
    onClose,
  } = props;
  const { t } = useTranslation();

  return (
    <div
      ref={popRef}
      role="dialog"
      aria-label={t('statusBar.workingDirectory')}
      style={
        isControlled && panelPos
          ? { position: 'fixed', top: panelPos.top, left: panelPos.left }
          : undefined
      }
      className={cn(
        isControlled
          ? 'z-50 min-w-[320px] max-w-[480px]'
          : 'absolute left-0 bottom-full mb-1 z-40 min-w-[320px] max-w-[480px]',
        'rounded-md border border-border-default bg-bg-elevated',
        'surface-highlight shadow-[var(--surface-shadow)]',
        'text-chrome text-fg-secondary overflow-hidden',
        'animate-[menuIn_140ms_cubic-bezier(0.32,0.72,0,1)]'
      )}
      data-testid="cwd-popover-panel"
    >
      <div className="px-2 pt-2 pb-1.5 border-b border-border-subtle">
        <input
          ref={inputRef}
          type="text"
          value={query}
          spellCheck={false}
          autoComplete="off"
          placeholder={cwd ? truncateMiddle(cwd, 48) : t('cwdPopover.placeholder')}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={onListKeyDown}
          className={cn(
            'w-full h-7 px-2 rounded-sm bg-bg-panel border border-border-subtle',
            'font-mono text-mono-md text-fg-primary placeholder:text-fg-tertiary',
            'outline-none focus:border-border-strong'
          )}
        />
      </div>

      <span className="block px-3 pt-1.5 pb-1 font-mono text-mono-sm text-fg-tertiary select-none">
        {t('cwdPopover.recent')}
      </span>
      <ul className="max-h-[260px] overflow-y-auto pb-1" role="listbox">
        {filtered.length === 0 ? (
          <li className="px-3 py-2 text-fg-tertiary text-mono-md leading-[16px]">
            {t('cwdPopover.empty')}
          </li>
        ) : (
          filtered.map((path, i) => {
            const isActive = i === active;
            return (
              <li
                key={path}
                role="option"
                aria-selected={isActive}
                onMouseEnter={() => setActive(i)}
                // onMouseDown so the input doesn't blur first and close us.
                onMouseDown={(e) => {
                  e.preventDefault();
                  onCommit(path);
                }}
                title={path}
                className={cn(
                  'flex items-center h-7 px-3 mx-1 rounded-sm cursor-pointer select-none',
                  'transition-colors duration-120 ease-out',
                  isActive
                    ? 'bg-bg-hover text-fg-primary'
                    : 'text-fg-secondary hover:bg-bg-hover/60'
                )}
              >
                <span className="font-mono text-mono-md truncate">
                  {truncateMiddle(path)}
                </span>
              </li>
            );
          })
        )}
      </ul>

      <div className="border-t border-border-subtle px-1 py-1">
        <button
          type="button"
          onMouseDown={(e) => {
            e.preventDefault();
            onClose();
            onBrowse();
          }}
          className={cn(
            'w-full flex items-center gap-2 h-7 px-2 mx-0 rounded-sm',
            'text-fg-secondary hover:bg-bg-hover hover:text-fg-primary',
            'outline-none focus-ring',
            'transition-colors duration-120 ease-out text-left text-mono-md'
          )}
        >
          <Folder size={12} className="stroke-[1.75] text-fg-tertiary" />
          <span>{t('cwdPopover.browse')}</span>
        </button>
      </div>
    </div>
  );
}
