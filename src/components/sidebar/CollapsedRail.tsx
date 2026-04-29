import React from 'react';
import { ChevronRight, Download, Plus, Search, Settings } from 'lucide-react';
import { IconButton } from '../ui/IconButton';
import { useTranslation } from '../../i18n/useTranslation';

// Collapsed sidebar rail (48px wide). Pure layout — no state, no derived
// data. Hosts the same six action affordances as the expanded sidebar
// (toggle, new session, search, import, settings) stacked vertically with
// flex-1 spacer to push import/settings to the bottom. Extracted from
// <Sidebar> in Task #735 Phase B; the parent stays a compose layer.
//
// macOS: tighter `py-1` to leave room for the stoplight buttons in the
// drag region above; Windows/Linux: `py-3`.
export function CollapsedRail({
  onToggleSidebar,
  onCreateSession,
  onOpenPalette,
  onOpenImport,
  onOpenSettings
}: {
  onToggleSidebar: () => void;
  onCreateSession?: () => void;
  onOpenPalette?: () => void;
  onOpenImport?: () => void;
  onOpenSettings?: () => void;
}) {
  const { t } = useTranslation();
  const isDarwin = window.ccsm?.window.platform === 'darwin';
  return (
    <div className={`flex flex-col items-center w-full h-full gap-2 ${isDarwin ? 'py-1' : 'py-3'}`}>
      <IconButton
        variant="raised"
        size="md"
        onClick={onToggleSidebar}
        tooltip={t('sidebar.expandSidebarTooltip')}
        tooltipSide="right"
        aria-label={t('sidebar.expandSidebarAria')}
        className="h-8 w-8"
      >
        <ChevronRight size={14} className="stroke-[1.5]" />
      </IconButton>
      <IconButton
        variant="raised"
        size="md"
        onClick={() => onCreateSession?.()}
        tooltip={t('sidebar.newSessionTooltip')}
        tooltipSide="right"
        aria-label={t('sidebar.newSessionAria')}
        className="h-8 w-8"
      >
        <Plus size={14} className="stroke-[1.75]" />
      </IconButton>
      <IconButton
        variant="raised"
        size="md"
        onClick={onOpenPalette}
        tooltip={t('sidebar.searchTooltip')}
        tooltipSide="right"
        aria-label={t('sidebar.searchAriaShort')}
        className="h-8 w-8"
      >
        <Search size={14} className="stroke-[1.5]" />
      </IconButton>
      <div className="flex-1" />
      <IconButton
        variant="raised"
        size="md"
        onClick={onOpenImport}
        tooltip={t('sidebar.importTooltip')}
        tooltipSide="right"
        aria-label={t('sidebar.importAriaShort')}
        className="h-8 w-8"
      >
        <Download size={14} className="stroke-[1.5]" />
      </IconButton>
      <IconButton
        variant="raised"
        size="md"
        onClick={onOpenSettings}
        tooltip={t('sidebar.settingsTooltip')}
        tooltipSide="right"
        aria-label={t('sidebar.settingsAria')}
        className="h-8 w-8"
      >
        <Settings size={14} className="stroke-[1.5]" />
      </IconButton>
    </div>
  );
}
