import React from 'react';
import { ChevronDown, Plus } from 'lucide-react';
import { cn } from '../../lib/cn';
import { IconButton } from '../ui/IconButton';
import { Button } from '../ui/Button';
import { useTranslation } from '../../i18n/useTranslation';

export function NewSessionButton({
  onCreateSession,
  cwdPopoverOpen,
  onCwdPopoverOpenChange,
  chevronRef
}: {
  onCreateSession?: () => void;
  cwdPopoverOpen: boolean;
  onCwdPopoverOpenChange: (open: boolean) => void;
  chevronRef: React.RefObject<HTMLButtonElement>;
}) {
  const { t } = useTranslation();
  // The "main" New Session button + "▾" cwd-picker chevron form a single
  // visual cluster: shared raised pill with a hairline divider between the
  // two halves. Each half has its own click target (44x44 hit padding via
  // the buttons' own padding/grid), its own focus ring, and its own aria
  // label. Tooltips help discoverability for the chevron specifically.
  return (
    <div className="flex-1 inline-flex items-stretch h-8" data-sidebar-newsession-cluster>
      <Button
        variant="raised"
        size="md"
        onClick={() => onCreateSession?.()}
        className={cn(
          'flex-1 h-8 text-chrome gap-1.5',
          // Strip the right-side rounded corners so the chevron sits flush.
          '!rounded-r-none border-r-0'
        )}
      >
        <Plus size={14} className="stroke-[1.75]" />
        <span>{t('sidebar.newSession')}</span>
      </Button>
      <IconButton
        ref={chevronRef}
        variant="raised"
        size="md"
        aria-label={t('sidebar.pickCwdAria')}
        aria-expanded={cwdPopoverOpen}
        aria-haspopup="dialog"
        tooltip={t('sidebar.pickCwdTooltip')}
        tooltipSide="bottom"
        onClick={() => onCwdPopoverOpenChange(!cwdPopoverOpen)}
        data-testid="sidebar-newsession-cwd-chevron"
        className={cn(
          'h-8 w-7 shrink-0',
          // Match the cluster: kill left rounding so we sit flush with the
          // main button's right edge, keep right rounding from the cluster
          // wrapper. Subtle inner-left hairline divides the two halves.
          '!rounded-l-none',
          'shadow-[inset_1px_0_0_0_oklch(0_0_0_/_0.35)]'
        )}
      >
        <ChevronDown size={12} className="stroke-[1.75]" />
      </IconButton>
    </div>
  );
}
