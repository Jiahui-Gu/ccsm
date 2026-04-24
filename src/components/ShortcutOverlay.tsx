import React, { useMemo } from 'react';
import { Dialog, DialogContent } from './ui/Dialog';
import { useTranslation } from '../i18n/useTranslation';

// Platform-aware modifier glyph. We detect once on module eval — the platform
// doesn't change during a session. Falls back to "Ctrl" for anything that
// isn't obviously macOS (Windows, Linux, unknown UA).
const IS_MAC =
  typeof navigator !== 'undefined' &&
  /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent || '');

const MOD = IS_MAC ? '\u2318' : 'Ctrl'; // ⌘ on mac, Ctrl elsewhere
const SHIFT = IS_MAC ? '\u21E7' : 'Shift'; // ⇧ on mac

type Row = { keys: string; actionKey: string };
type Group = { titleKey: string; rows: Row[] };

// Shortcuts discovered by grepping the codebase. Keep this list in sync
// with the real handlers — comment next to each row points at the source.
// Platform modifier is resolved at render time so the overlay always
// shows the keys the user actually needs to press.
function buildGroups(): Group[] {
  return [
    {
      titleKey: 'shortcuts.groupChat',
      rows: [
        // InputBar.tsx — Enter (no shift) sends, shift+Enter inserts newline.
        { keys: 'Enter', actionKey: 'shortcuts.actionSend' },
        { keys: `${SHIFT} + Enter`, actionKey: 'shortcuts.actionNewline' },
        // InputBar.tsx — document-level Esc interrupts the running turn.
        { keys: 'Esc', actionKey: 'shortcuts.actionStop' },
        // InputBar.tsx:558 — Esc in slash-command picker dismisses it.
        { keys: 'Esc', actionKey: 'shortcuts.actionDismissPicker' }
      ]
    },
    {
      titleKey: 'shortcuts.groupSidebar',
      rows: [
        // App.tsx:169 — Cmd/Ctrl+B toggles the sidebar.
        { keys: `${MOD} + B`, actionKey: 'shortcuts.actionToggleSidebar' },
        // App.tsx:179 — Cmd/Ctrl+N creates a new session.
        { keys: `${MOD} + N`, actionKey: 'shortcuts.actionNewSession' },
        // App.tsx:175 — Cmd/Ctrl+Shift+N creates a new group.
        { keys: `${MOD} + ${SHIFT} + N`, actionKey: 'shortcuts.actionNewGroup' }
      ]
    },
    {
      titleKey: 'shortcuts.groupNavigation',
      rows: [
        // App.tsx:163 — Cmd/Ctrl+F opens the palette.
        { keys: `${MOD} + F`, actionKey: 'shortcuts.actionSearch' },
        // App.tsx:172 — Cmd/Ctrl+, opens Settings.
        { keys: `${MOD} + ,`, actionKey: 'shortcuts.actionSettings' },
        // This PR — ? or Cmd/Ctrl+/ opens this overlay.
        { keys: `?  ·  ${MOD} + /`, actionKey: 'shortcuts.actionShortcuts' }
      ]
    }
  ];
}

export type ShortcutOverlayProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function ShortcutOverlay({ open, onOpenChange }: ShortcutOverlayProps) {
  const { t } = useTranslation();
  const groups = useMemo(() => buildGroups(), []);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        width="560px"
        title={t('shortcuts.title')}
        description={t('shortcuts.description')}
        data-shortcut-overlay
      >
        <div className="px-5 pb-5 pt-1">
          {groups.map((g, gi) => (
            <section key={g.titleKey} className={gi === 0 ? '' : 'mt-5'}>
              <h3 className="text-meta font-semibold uppercase tracking-wider text-fg-tertiary mb-2">
                {t(g.titleKey)}
              </h3>
              <table className="w-full text-chrome">
                <thead className="sr-only">
                  <tr>
                    <th>{t('shortcuts.colShortcut')}</th>
                    <th>{t('shortcuts.colAction')}</th>
                  </tr>
                </thead>
                <tbody>
                  {g.rows.map((r, ri) => (
                    <tr
                      key={`${g.titleKey}-${ri}`}
                      className="border-t border-border-subtle first:border-t-0"
                    >
                      <td className="py-1.5 pr-4 w-[180px] align-top">
                        <KeyChips combo={r.keys} />
                      </td>
                      <td className="py-1.5 text-fg-secondary align-top">
                        {t(r.actionKey)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Renders a shortcut combo like "Ctrl + Shift + N" as a row of
 * monospace chips separated by a dim "+". Multiple combos can be
 * separated with " · " (middle-dot) and render as distinct chip groups.
 */
function KeyChips({ combo }: { combo: string }) {
  // Split on the middle-dot separator first (multi-binding row),
  // then each binding on " + ".
  const bindings = combo.split(/\s+\u00B7\s+/);
  return (
    <span className="inline-flex items-center gap-2 flex-wrap">
      {bindings.map((binding, bi) => {
        const parts = binding.split(/\s*\+\s*/);
        return (
          <span key={bi} className="inline-flex items-center gap-1">
            {parts.map((p, pi) => (
              <React.Fragment key={pi}>
                {pi > 0 && (
                  <span aria-hidden="true" className="text-fg-tertiary text-meta">
                    +
                  </span>
                )}
                <kbd
                  className={
                    'inline-flex items-center justify-center ' +
                    'min-w-[22px] h-[22px] px-1.5 ' +
                    'rounded border border-border-default bg-bg-elevated ' +
                    'font-mono text-meta leading-none text-fg-primary ' +
                    'shadow-[inset_0_-1px_0_0_oklch(0_0_0_/_0.25)]'
                  }
                >
                  {p}
                </kbd>
              </React.Fragment>
            ))}
            {bi < bindings.length - 1 && (
              <span aria-hidden="true" className="text-fg-tertiary">
                ·
              </span>
            )}
          </span>
        );
      })}
    </span>
  );
}
