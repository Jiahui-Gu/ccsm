import React from 'react';
import { useStore } from '../stores/store';
import { SidebarResizer } from './SidebarResizer';

/**
 * Two-pane shell with a draggable vertical divider.
 *
 * Sidebar width is persisted in pixels (see store.sidebarWidth) — for a fixed-
 * content sidebar, px matches user intuition better than a fraction of the
 * window. The resizer (SidebarResizer) clamps to [200, 480]; double-click
 * resets to the default. Hidden when the sidebar is collapsed.
 */
export function AppShell({
  sidebar,
  main,
}: {
  sidebar: React.ReactNode;
  main: React.ReactNode;
}) {
  const sidebarCollapsed = useStore((s) => s.sidebarCollapsed);

  return (
    <div className="app-shell flex h-full w-full bg-bg-app text-fg-primary">
      {sidebar}
      {!sidebarCollapsed && <SidebarResizer />}
      {main}
    </div>
  );
}
