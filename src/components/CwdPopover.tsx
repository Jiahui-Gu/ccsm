import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, AlertTriangle } from 'lucide-react';
import { cn } from '../lib/cn';
import { useTranslation } from '../i18n/useTranslation';
import { useStore } from '../stores/store';
import { useCwdPanelPosition } from './cwd/useCwdPanelPosition';
import { useCwdRecentList } from './cwd/useCwdRecentList';
import { CwdPopoverPanel } from './cwd/CwdPopoverPanel';

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
// Implementation split (#770): three concerns live in `./cwd/`:
//   - useCwdPanelPosition — controlled-mode anchor positioning effect
//   - useCwdRecentList    — recent loader + filter + keyboard nav
//   - CwdPopoverPanel     — presentational panel JSX
// This file is the slim host: prop-mode arbiter + legacy trigger glue.

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
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const anchorRef = isControlled ? (props as ControlledProps).anchorRef : null;
  const panelPos = useCwdPanelPosition(anchorRef, open, isControlled);

  const commit = useCallback(
    (path: string) => {
      setOpen(false);
      onPick(path);
    },
    [onPick, setOpen]
  );

  const { filtered, query, setQuery, active, setActive, onListKeyDown } =
    useCwdRecentList(open, loadRecent, commit);

  // Focus the input on open (deferred to next tick so the panel mounts first).
  useEffect(() => {
    if (!open) return;
    const id = window.setTimeout(() => {
      inputRef.current?.focus();
    }, 0);
    return () => window.clearTimeout(id);
  }, [open, cwd]);

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

  // Legacy-mode chip label. Controlled mode never renders this.
  const hasCwd = !!cwd;
  const triggerLabel = hasCwd ? lastSegment(cwd) : t('chat.cwdChipNoneLabel');

  // Controlled mode requires `panelPos` to be measured BEFORE rendering, so we
  // never paint an unpositioned static block that pushes neighboring layout
  // (e.g. the "+ New session" trigger to its left). Legacy mode positions
  // itself via Tailwind absolute classes on the inline anchor.
  const showPanel = open && (!isControlled || panelPos !== null);
  const panel = showPanel ? (
    <CwdPopoverPanel
      isControlled={isControlled}
      panelPos={panelPos}
      popRef={popRef}
      inputRef={inputRef}
      cwd={cwd}
      query={query}
      setQuery={setQuery}
      active={active}
      setActive={setActive}
      filtered={filtered}
      onListKeyDown={onListKeyDown}
      onCommit={commit}
      onBrowse={onBrowse}
      onClose={() => setOpen(false)}
    />
  ) : null;

  if (isControlled) {
    // Controlled mode: caller renders the trigger; we only output the panel.
    // Portal the panel to document.body so it escapes the sidebar's
    // `backdrop-filter` containing block (which would otherwise trap
    // `position: fixed` descendants and cause clipping by `overflow: hidden`).
    if (!panel) return null;
    if (typeof document === 'undefined') return panel;
    return createPortal(panel, document.body);
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
