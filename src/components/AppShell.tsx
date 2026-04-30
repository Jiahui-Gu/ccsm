import React from 'react';
import { SidebarResizer } from './SidebarResizer';

/**
 * Two-pane shell with a draggable vertical divider.
 *
 * Sidebar width is persisted in pixels (see store.sidebarWidth) — for a fixed-
 * content sidebar, px matches user intuition better than a fraction of the
 * window. The resizer (SidebarResizer) clamps to [200, 480]; double-click
 * resets to the default.
 */
export function AppShell({
  sidebar,
  main,
}: {
  sidebar: React.ReactNode;
  main: React.ReactNode;
}) {
  return (
    <div className="app-shell flex h-full w-full bg-bg-app text-fg-primary">
      {sidebar}
      <SidebarResizer />
      {main}
    </div>
  );
}
