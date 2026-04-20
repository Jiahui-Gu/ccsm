import React, { useEffect, useState } from 'react';
import { Minus, Square, Copy, X } from 'lucide-react';
import { cn } from '../lib/cn';

// macOS uses `hiddenInset` — traffic lights are rendered by the OS.
// We reserve space for them via a left spacer. On win32/linux we self-draw
// the three controls on the right to match the Electron frameless window.
export function TitleBar() {
  const api = window.agentory;
  const platform = api?.window.platform ?? 'win32';
  const isMac = platform === 'darwin';
  const [isMax, setIsMax] = useState(false);

  useEffect(() => {
    if (!api) return;
    api.window.isMaximized().then(setIsMax);
    return api.window.onMaximizedChanged(setIsMax);
  }, [api]);

  return (
    <div
      className="relative flex shrink-0 select-none items-center bg-bg-app"
      style={{ WebkitAppRegion: 'drag', height: 32 } as React.CSSProperties}
    >
      {isMac ? <div className="w-20" /> : <div className="w-2" />}
      <div className="flex-1" />
      {!isMac && (
        <div
          className="flex h-full items-stretch"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          <TitleButton onClick={() => api?.window.minimize()} aria-label="Minimize">
            <Minus size={12} className="stroke-[1.75]" />
          </TitleButton>
          <TitleButton onClick={() => api?.window.toggleMaximize()} aria-label={isMax ? 'Restore' : 'Maximize'}>
            {isMax ? <Copy size={11} className="stroke-[1.75] -scale-x-100" /> : <Square size={11} className="stroke-[1.75]" />}
          </TitleButton>
          <TitleButton onClick={() => api?.window.close()} aria-label="Close" danger>
            <X size={13} className="stroke-[1.75]" />
          </TitleButton>
        </div>
      )}
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
        'flex h-full items-center justify-center text-fg-secondary',
        'transition-colors duration-100 ease-out',
        'hover:text-fg-primary',
        danger ? 'hover:bg-[oklch(0.55_0.22_27)] hover:text-white' : 'hover:bg-bg-hover',
        'focus:outline-none focus-visible:bg-bg-hover'
      )}
      style={{ width: 46 }}
    >
      {children}
    </button>
  );
}
