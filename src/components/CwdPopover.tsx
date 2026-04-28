import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Folder, AlertTriangle } from 'lucide-react';
import { cn } from '../lib/cn';
import { useTranslation } from '../i18n/useTranslation';
import { useStore } from '../stores/store';

// Stable id for this popover in the global mutex slot. See
// `openPopoverId` in src/stores/store.ts: opening any popover sets the id
// (closing whatever else was open), so clicking a different chip while the
// cwd popover is open auto-dismisses this one.
const POPOVER_ID_LEGACY = 'cwd';

// Typeahead popover for picking a working directory.
//
// Two operating modes share one component:
//
//   1. LEGACY (uncontrolled, embedded trigger). When neither `open` nor
//      `onOpenChange` is provided, the popover renders its own trigger button
//      (the "cwd chip") and owns its open state via the global mutex slot.
//      This is the original behaviour used by tests/cwd-popover.test.tsx.
//
//   2. CONTROLLED (external anchor). When `open` + `onOpenChange` are
//      provided, the component renders ONLY the popover panel, anchored
//      below the DOM element passed in via `anchorRef`. Used by Sidebar
//      for the new chevron-next-to-`+` cwd picker (task #552). No trigger
//      button is rendered; the caller owns trigger UI + open state.
//
// History: PR #94 introduced the typeahead inside SessionCreateDialog; PR
// #106 dropped the dialog and moved it to the StatusBar cwd chip. The
// StatusBar was later removed (direct-xterm refactor), leaving the legacy
// embedded-trigger mode dormant in production but still tested. Task #552
// resurrects the popover anchored to a sidebar chevron.
//
// Implementation notes:
//   - We deliberately don't pull in `@radix-ui/react-popover` because the
//     project doesn't have it as a direct dependency. Positioning is a
//     simple absolute layout anchored to the trigger / external anchor;
//     click-outside + Escape close the popover.
//   - The recent list comes from `window.ccsm.recentCwds()` which the
//     main process eager-scans at boot from `~/.claude/projects` (PR #94).
//     The IPC is best-effort: if it fails or returns empty we render a
//     friendly "no recent cwds" hint and still expose Browse.

const RECENT_LIMIT = 10;

type CommonProps = {
  /** Switch the active session to `path`. */
  onPick: (path: string) => void;
  /** Open the OS folder picker; called when "Browse..." is clicked. */
  onBrowse: () => void;
  /** Optional async loader override — useful for tests. Defaults to the IPC. */
  loadRecent?: () => Promise<string[]>;
  /** Current working directory. Used for placeholder + (legacy) trigger label. */
  cwd?: string;
  /** When true (legacy mode only), show a dim ⚠ next to the trigger. */
  cwdMissing?: boolean;
};

type LegacyProps = CommonProps & {
  open?: undefined;
  onOpenChange?: undefined;
  anchorRef?: undefined;
};

type ControlledProps = CommonProps & {
  /** Controlled open state. When provided, the embedded trigger is NOT rendered. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** DOM element to anchor the popover panel against. The panel positions
   *  itself below the anchor's bottom edge, left-aligned to its left edge. */
  anchorRef: React.RefObject<HTMLElement> | React.RefObject<HTMLElement | null>;
};

type Props = LegacyProps | ControlledProps;

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

export function CwdPopover(props: Props) {
  const isControlled = props.open !== undefined && props.onOpenChange !== undefined;
  const { t } = useTranslation();

  // Legacy open state lives on the store mutex slot; controlled mode
  // delegates to the caller. We compute `open` via a single source of truth
  // so the rest of the component is mode-agnostic.
  const legacyOpen = useStore((s) => s.openPopoverId === POPOVER_ID_LEGACY);
  const openPopover = useStore((s) => s.openPopover);
  const closePopover = useStore((s) => s.closePopover);
  const open = isControlled ? (props.open as boolean) : legacyOpen;
  const setOpen = useCallback(
    (next: boolean) => {
      if (isControlled) {
        (props.onOpenChange as (o: boolean) => void)(next);
      } else if (next) {
        openPopover(POPOVER_ID_LEGACY);
      } else {
        closePopover(POPOVER_ID_LEGACY);
      }
    },
    [isControlled, props, openPopover, closePopover]
  );

  const { onPick, onBrowse, loadRecent, cwd: cwdProp = '', cwdMissing } = props;
  const cwd = cwdProp;
  const [query, setQuery] = useState('');
  const [recent, setRecent] = useState<string[]>([]);
  const [active, setActive] = useState(0);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Controlled-mode panel positioning. We compute screen coords from the
  // external anchor's bounding rect on every open + on resize/scroll while
  // open, mounting the panel via a fixed-position wrapper so it escapes
  // any clipping ancestors (the sidebar uses overflow:hidden).
  const [panelPos, setPanelPos] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    if (!isControlled || !open) return;
    const anchor = (props as ControlledProps).anchorRef.current;
    if (!anchor) return;
    const recompute = () => {
      const r = anchor.getBoundingClientRect();
      setPanelPos({ top: r.bottom + 4, left: r.left });
    };
    recompute();
    window.addEventListener('resize', recompute);
    window.addEventListener('scroll', recompute, true);
    return () => {
      window.removeEventListener('resize', recompute);
      window.removeEventListener('scroll', recompute, true);
    };
  }, [isControlled, open, props]);

  // task328: discoverability — pulse a faint accent ring on the FIRST hover
  // after mount so brand-new users notice the (legacy) chip is interactive.
  // Only meaningful for the embedded-trigger mode; controlled mode hosts the
  // trigger externally and doesn't need this.
  const [hoverHintShown, setHoverHintShown] = useState(false);
  const [hoverHintActive, setHoverHintActive] = useState(false);
  const triggerOnHoverHint = useCallback(() => {
    if (hoverHintShown) return;
    setHoverHintShown(true);
    setHoverHintActive(true);
  }, [hoverHintShown]);
  useEffect(() => {
    if (!hoverHintActive) return;
    const id = window.setTimeout(() => setHoverHintActive(false), 600);
    return () => window.clearTimeout(id);
  }, [hoverHintActive]);
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

  // Lazy-load recent cwds on each open.
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

  // Click-outside / Escape both close the popover. In controlled mode the
  // outside-click check must also exclude the EXTERNAL anchor so a click
  // on the chevron toggles, not closes-then-reopens.
  useEffect(() => {
    if (!open) return;
    const externalAnchor = isControlled
      ? (props as ControlledProps).anchorRef.current
      : null;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (popRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      if (externalAnchor && externalAnchor.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, isControlled, props, setOpen]);

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
      setOpen(false);
      onPick(path);
    },
    [onPick, setOpen]
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

  // Legacy-mode chip label. Controlled mode never renders this.
  const hasCwd = !!cwd;
  const triggerLabel = hasCwd ? lastSegment(cwd) : t('chat.cwdChipNoneLabel');

  // The popover panel — shared between modes, but positioning differs.
  const panel = open ? (
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
            setOpen(false);
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
  ) : null;

  if (isControlled) {
    // Controlled mode: caller renders the trigger; we only output the panel.
    return panel;
  }

  return (
    <span className="relative inline-flex">
      <button
        ref={triggerRef}
        type="button"
        data-cwd-chip
        data-hover-hint={hoverHintActive ? 'on' : undefined}
        title={cwdMissing ? t('cwdPopover.cwdMissingTooltip', { cwd }) : (hasCwd ? cwd : undefined)}
        onClick={() => setOpen(!open)}
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
          // task328: first-hover discoverability pulse.
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

      {panel}
    </span>
  );
}
