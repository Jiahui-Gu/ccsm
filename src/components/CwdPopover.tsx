import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Folder, AlertTriangle } from 'lucide-react';
import { cn } from '../lib/cn';
import { useTranslation } from '../i18n/useTranslation';
import { useStore } from '../stores/store';

// Stable id for this popover in the global mutex slot. See
// `openPopoverId` in src/stores/store.ts: opening any popover sets the id
// (closing whatever else was open), so clicking a different chip while the
// cwd popover is open auto-dismisses this one.
const POPOVER_ID = 'cwd';

// Typeahead popover for the StatusBar `cwd` chip.
//
// History: PR #94 introduced a typeahead dropdown inside the (since-removed)
// SessionCreateDialog so users could pick a recent cwd by typing. PR #106
// dropped the dialog in favour of in-place session creation, which also
// dropped the typeahead — leaving the native directory picker as the only
// way to switch cwd. This popover restores the typeahead by mounting it on
// the StatusBar cwd chip and keeps the native picker as a "Browse..." entry
// point at the bottom of the list.
//
// Implementation notes:
//   - We deliberately don't pull in `@radix-ui/react-popover` because the
//     project doesn't have it as a direct dependency and the brief forbids
//     adding new ones. Positioning is a simple absolute layout anchored to
//     the trigger; click-outside + Escape close the popover.
//   - The recent list comes from `window.ccsm.recentCwds()` which the
//     main process eager-scans at boot from `~/.claude/projects` (PR #94).
//     The IPC is best-effort: if it fails or returns empty we render a
//     friendly "no recent cwds" hint and still expose Browse.
//   - Filtering is plain case-insensitive substring — no fuzzy match. The
//     query input starts empty on every open so the Recent list is shown
//     in full; the current cwd is surfaced as the input placeholder so
//     users still see "where they are" without it acting as a filter
//     (regression fix — see PR `fix(cwd-popover)`).

const RECENT_LIMIT = 10;

type Props = {
  /** Current working directory. Used to label the trigger and shown as the input placeholder. */
  cwd: string;
  /** When true, show a dim ⚠ next to the trigger label and explain via tooltip. */
  cwdMissing?: boolean;
  /** Optional async loader override — useful for tests. Defaults to the IPC. */
  loadRecent?: () => Promise<string[]>;
  /** Switch the active session to `path`. */
  onPick: (path: string) => void;
  /** Open the OS folder picker; called when "Browse..." is clicked. */
  onBrowse: () => void;
};

function lastSegment(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  const segs = trimmed.split(/[\\/]/).filter(Boolean);
  return segs[segs.length - 1] ?? path;
}

function truncateMiddle(path: string, max = 56): string {
  if (path.length <= max) return path;
  const head = Math.ceil((max - 1) / 2);
  const tail = Math.floor((max - 1) / 2);
  return `${path.slice(0, head)}…${path.slice(path.length - tail)}`;
}

async function defaultLoadRecent(): Promise<string[]> {
  type Bridge = { recentCwds?: () => Promise<string[]> };
  const bridge = (typeof window !== 'undefined'
    ? (window as unknown as { ccsm?: Bridge }).ccsm
    : undefined);
  try {
    const list = await bridge?.recentCwds?.();
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export function CwdPopover({ cwd, cwdMissing, loadRecent, onPick, onBrowse }: Props) {
  const { t } = useTranslation();
  // Open state is owned by the store so opening any other popover (or this
  // one's trigger again) flips us shut without local listeners. The mousedown
  // fallback below still calls closePopover for outside clicks that don't
  // hit another mutex-aware trigger (e.g. blank chrome).
  const open = useStore((s) => s.openPopoverId === POPOVER_ID);
  const openPopover = useStore((s) => s.openPopover);
  const closePopover = useStore((s) => s.closePopover);
  const [query, setQuery] = useState('');
  const [recent, setRecent] = useState<string[]>([]);
  const [active, setActive] = useState(0);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // task328: discoverability — pulse a faint accent ring on the FIRST hover
  // after mount so brand-new users notice the chip is interactive. Sticky:
  // once shown (or once the popover is opened by any path), we never replay
  // for the lifetime of this mount. Keyed off mount, not session id, so
  // switching between sessions in the same lifetime doesn't re-pulse.
  const [hoverHintShown, setHoverHintShown] = useState(false);
  const [hoverHintActive, setHoverHintActive] = useState(false);
  const triggerOnHoverHint = useCallback(() => {
    if (hoverHintShown) return;
    setHoverHintShown(true);
    setHoverHintActive(true);
    // Pulse duration matches the menuIn ease (~600ms). After it expires we
    // detach the class so subsequent renders are clean.
    window.setTimeout(() => setHoverHintActive(false), 600);
  }, [hoverHintShown]);
  // Opening the popover (via click, keyboard, whatever) also retires the
  // hint — the user has discovered the chip.
  useEffect(() => {
    if (open && !hoverHintShown) {
      setHoverHintShown(true);
      setHoverHintActive(false);
    }
  }, [open, hoverHintShown]);

  // Reset query each time we re-open so the Recent list shows in full;
  // the current cwd is surfaced as the input placeholder instead.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActive(0);
    const id = window.setTimeout(() => {
      inputRef.current?.focus();
    }, 0);
    return () => window.clearTimeout(id);
  }, [open, cwd]);

  // Lazy-load recent cwds on first open. We refetch every open so newly-used
  // cwds show up without forcing the user to restart the app — the IPC is
  // cheap (returns from an in-memory cache).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const loader = loadRecent ?? defaultLoadRecent;
    void loader().then((list) => {
      if (cancelled) return;
      setRecent(list.slice(0, RECENT_LIMIT));
    });
    return () => {
      cancelled = true;
    };
  }, [open, loadRecent]);

  // Click-outside / Escape both close the popover. We use mousedown so the
  // popover collapses before any click handlers on background controls fire,
  // matching the SlashCommandPicker pattern elsewhere in the app.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (popRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      closePopover(POPOVER_ID);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        closePopover(POPOVER_ID);
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, closePopover]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return recent;
    return recent.filter((p) => p.toLowerCase().includes(needle));
  }, [recent, query]);

  // Clamp active row whenever the filtered list shrinks.
  useEffect(() => {
    if (active >= filtered.length) setActive(0);
  }, [filtered.length, active]);

  const commit = useCallback(
    (path: string) => {
      closePopover(POPOVER_ID);
      onPick(path);
    },
    [onPick, closePopover]
  );

  const onListKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, Math.max(0, filtered.length - 1)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const choice = filtered[active] ?? (query.trim() ? query.trim() : null);
      if (choice) commit(choice);
    }
  };

  // task328: when the active session has no cwd (empty string), surface a
  // muted `(none)` placeholder instead of letting `lastSegment('')` fall back
  // to the raw input — and skip auto-opening the popover (corner case: only
  // happens when there's no CLI history AND no per-group prior cwd).
  const hasCwd = !!cwd;
  const triggerLabel = hasCwd ? lastSegment(cwd) : t('chat.cwdChipNoneLabel');

  return (
    <span className="relative inline-flex">
      <button
        ref={triggerRef}
        type="button"
        data-cwd-chip
        data-hover-hint={hoverHintActive ? 'on' : undefined}
        title={cwdMissing ? t('cwdPopover.cwdMissingTooltip', { cwd }) : (hasCwd ? cwd : undefined)}
        onClick={() => (open ? closePopover(POPOVER_ID) : openPopover(POPOVER_ID))}
        onMouseEnter={triggerOnHoverHint}
        onFocus={triggerOnHoverHint}
        aria-haspopup="dialog"
        aria-expanded={open}
        className={cn(
          'inline-flex items-center gap-1 h-5 px-1.5 rounded-sm',
          cwdMissing
            ? 'text-state-warning hover:text-state-warning-text hover:bg-state-warning-soft'
            : !hasCwd
            ? 'text-fg-tertiary italic hover:text-fg-secondary hover:bg-bg-hover'
            : 'text-fg-tertiary hover:text-fg-secondary hover:bg-bg-hover',
          'outline-none focus-ring',
          // task328: first-hover discoverability pulse. Uses the existing
          // --color-focus-ring token so we don't introduce a new color.
          hoverHintActive &&
            'shadow-[0_0_0_2px_var(--color-focus-ring)] transition-shadow duration-300',
          'transition-colors duration-120 ease-out'
        )}
      >
        <span>{triggerLabel}</span>
        {cwdMissing ? (
          <AlertTriangle
            size={10}
            className="stroke-[1.75] opacity-80"
            aria-label={t('cwdPopover.cwdMissingShort')}
          />
        ) : null}
        <ChevronDown size={10} className="stroke-[1.75] opacity-70" />
      </button>

      {open ? (
        <div
          ref={popRef}
          role="dialog"
          aria-label={t('statusBar.workingDirectory')}
          // Anchor above the chip — StatusBar lives at the bottom of the
          // window so a top-aligned popover would collide with the input
          // bar above it. `bottom-full` puts us above the trigger; `mb-1`
          // matches the breathing room used by the slash-command picker.
          className={cn(
            'absolute left-0 bottom-full mb-1 z-40 min-w-[320px] max-w-[480px]',
            'rounded-md border border-border-default bg-bg-elevated',
            'surface-highlight shadow-[var(--surface-shadow)]',
            'text-chrome text-fg-secondary overflow-hidden',
            'animate-[menuIn_140ms_cubic-bezier(0.32,0.72,0,1)]'
          )}
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
                      commit(path);
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
                closePopover(POPOVER_ID);
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
      ) : null}
    </span>
  );
}
