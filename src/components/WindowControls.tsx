import React, { useEffect, useState } from 'react';
import { Minus, Square, Copy, X } from 'lucide-react';
import { cn } from '../lib/cn';
import { useTranslation } from '../i18n/useTranslation';

// Cross-platform window chrome pieces.
//
// The app window is frameless on win/linux and `hiddenInset` on macOS, so
// we self-draw everything except the macOS traffic lights. We expose two
// small primitives so the shell can place them per-pane:
//
//   - `<DragRegion />` — a transparent strip with `-webkit-app-region: drag`
//     you can drop anywhere (sidebar top, right-pane top) to make that area
//     behave like a native title bar (drag, double-click maximize).
//   - `<WindowControls />` — the three Windows/Linux buttons (min / max-or-
//     restore / close). On macOS this renders nothing (the OS draws the
//     traffic lights in the `hiddenInset` reserved region).
//
// Keeping these separate means the right pane can own the controls while
// the sidebar still participates in window dragging — the old global
// TitleBar that stretched across both panes is gone.

export function DragRegion({
  className,
  children,
  style
}: {
  className?: string;
  children?: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <div
      aria-hidden
      className={cn('select-none relative', className)}
      style={{ WebkitAppRegion: 'drag', ...style } as React.CSSProperties}
    >
      {children}
    </div>
  );
}

export function NoDragRegion({
  className,
  children,
  style,
  ...rest
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      {...rest}
      className={className}
      style={{ WebkitAppRegion: 'no-drag', ...style } as React.CSSProperties}
    >
      {children}
    </div>
  );
}

function TitleButton({
  children,
  onClick,
  danger,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { danger?: boolean }) {
  return (
    <button
      {...rest}
      onClick={onClick}
      className={cn(
        'flex h-full items-center justify-center text-fg-tertiary',
        'transition-colors duration-120 [transition-timing-function:var(--ease-spring)]',
        'hover:text-fg-primary focus:outline-none',
        'focus-ring',
        // Danger branch can't lean on `.focus-ring`'s cyan accent outline
        // alone — its hover bg = focus bg = saturated state-error, which
        // swallows the outline. Keyboard users can't tell hover from focus
        // (audit top-10 #9). Add an inset translucent-cyan halo on focus
        // only; `--color-focus-ring` is calibrated to read against red.
        danger
          ? 'hover:bg-state-error hover:text-state-error-fg focus-visible:bg-state-error focus-visible:text-state-error-fg focus-visible:shadow-[inset_0_0_0_2px_var(--color-focus-ring)]'
          : 'hover:bg-bg-hover focus-visible:bg-bg-hover'
      )}
      style={{ width: 46 }}
    >
      {children}
    </button>
  );
}

export function WindowControls({ className }: { className?: string }) {
  const api = window.ccsm;
  const platform = api?.window.platform ?? 'win32';
  const isMac = platform === 'darwin';
  const [isMax, setIsMax] = useState(false);
  const { t } = useTranslation('window');

  useEffect(() => {
    if (!api) return;
    api.window.isMaximized().then(setIsMax);
    return api.window.onMaximizedChanged(setIsMax);
  }, [api]);

  // macOS: nothing to draw. Traffic lights are reserved/drawn by the OS in
  // the top-left via `titleBarStyle: 'hiddenInset'`. Consumers should use
  // `<MacTrafficLightSpacer />` to keep layout aligned.
  if (isMac) return null;

  return (
    <NoDragRegion className={cn('flex h-full items-stretch shrink-0', className)}>
      <TitleButton onClick={() => api?.window.minimize()} aria-label={t('minimize')}>
        <Minus size={12} className="stroke-[1.75]" />
      </TitleButton>
      <TitleButton
        onClick={() => api?.window.toggleMaximize()}
        aria-label={isMax ? t('restore') : t('maximize')}
      >
        {isMax ? (
          <Copy size={11} className="stroke-[1.75] -scale-x-100" />
        ) : (
          <Square size={11} className="stroke-[1.75]" />
        )}
      </TitleButton>
      <TitleButton onClick={() => api?.window.close()} aria-label={t('close')} danger>
        <X size={13} className="stroke-[1.75]" />
      </TitleButton>
    </NoDragRegion>
  );
}

// Reserves the 78px the OS uses for traffic lights on macOS `hiddenInset`
// windows. On other platforms, collapses to zero width.
export function MacTrafficLightSpacer() {
  const platform = window.ccsm?.window.platform ?? 'win32';
  if (platform !== 'darwin') return null;
  return <div aria-hidden className="w-[78px] shrink-0" />;
}

export function isMacPlatform(): boolean {
  return (window.ccsm?.window.platform ?? 'win32') === 'darwin';
}
