import React from 'react';
import { DragRegion, WindowControls } from './WindowControls';
import { AppShell } from './AppShell';

// Pre-hydrate skeleton (#584). The previous implementation rendered an
// empty `<aside>` which painted as a blank white app on first launch
// while sqlite hydration finished. We instead lay out content-shaped
// placeholders that mirror the loaded sidebar surface (260px wide,
// bg-bg-sidebar/80) plus a centered "Loading…" affordance in the main
// pane. The shapes do not need to match the loaded UI exactly — they
// only need to read as "the app is here" rather than "the renderer is
// broken".
//
// Test contract (consumed by harness-ui startup-paints-before-hydrate):
//   - sidebar root: data-testid="sidebar-skeleton", visible bg, width >= 40
//   - sidebar new-session row: data-testid="sidebar-skeleton-newsession"
//   - sidebar session rows: data-testid="sidebar-skeleton-row" (>=1)
//   - main root: data-testid="main-skeleton"
//   - main loading affordance: data-testid="main-skeleton-loading"

const SkelBlock: React.FC<{
  className?: string;
  'data-testid'?: string;
}> = ({ className, ...rest }) => (
  <div
    className={`rounded-md bg-fg-secondary/10 ${className ?? ''}`}
    aria-hidden
    {...rest}
  />
);

export const AppSkeleton: React.FC = () => {
  return (
    <AppShell
      sidebar={
        <aside
          data-testid="sidebar-skeleton"
          aria-busy="true"
          className="relative flex flex-col shrink-0 bg-bg-sidebar/80 backdrop-blur-xl sidebar-edge overflow-hidden h-full animate-pulse"
          style={{ width: 260 }}
        >
          <DragRegion
            className="shrink-0 w-full"
            style={{
              height:
                window.ccsm?.window.platform === 'darwin' ? 40 : 8,
            }}
          />
          <div className="flex flex-col gap-3 px-3 pt-2 pb-3">
            {/* "New session" CTA stub */}
            <SkelBlock
              className="h-9 w-full"
              data-testid="sidebar-skeleton-newsession"
            />
            {/* Search input stub */}
            <SkelBlock className="h-8 w-full" />
          </div>
          {/* Session row stubs */}
          <div className="flex flex-col gap-2 px-3">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                data-testid="sidebar-skeleton-row"
                className="flex items-center gap-2 h-8"
              >
                <SkelBlock className="h-4 w-4 shrink-0" />
                <SkelBlock className="h-3 flex-1" />
              </div>
            ))}
          </div>
          {/* Bottom: settings/import area */}
          <div className="mt-auto flex items-center gap-2 px-3 py-3">
            <SkelBlock className="h-7 w-7" />
            <SkelBlock className="h-7 w-7" />
            <div className="flex-1" />
            <SkelBlock className="h-7 w-7" />
          </div>
        </aside>
      }
      main={
        <main
          className="flex-1 flex flex-col min-w-0 right-pane-frame relative"
          data-testid="main-skeleton"
          aria-busy="true"
        >
          <DragRegion
            className="relative flex items-center justify-end shrink-0"
            style={{ height: 32 }}
          >
            <WindowControls />
          </DragRegion>
          <div className="flex-1 flex items-center justify-center">
            <div
              data-testid="main-skeleton-loading"
              className="text-sm text-fg-secondary/70 select-none"
            >
              Loading…
            </div>
          </div>
        </main>
      }
    />
  );
};
