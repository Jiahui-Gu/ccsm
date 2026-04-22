import React from 'react';
import { Group, Panel, Separator, type PanelSize } from 'react-resizable-panels';
import { useStore } from '../stores/store';
import { useTranslation } from '../i18n/useTranslation';

/**
 * Two-pane shell with a draggable vertical divider.
 *
 * react-resizable-panels 4.x accepts size strings like `"220px"` / `"22%"`,
 * so we can express sidebar constraints in the units that matter:
 *   - min 220px, max 480px for the sidebar
 *   - min 480px for the chat pane (it's the content-dense side)
 *
 * We persist the sidebar width as a *fraction* of the group width so the
 * layout adapts when the window resizes — on a 1920px monitor, 22% gives
 * the user more sidebar than on 1280px, which matches user expectation
 * (more real estate → more room to see everything).
 *
 * On drag we receive both `inPixels` and `asPercentage` — we store the %
 * value. The library debounces onResize internally; the persist layer
 * (store → schedulePersist) adds another 250ms coalesce.
 */
export function AppShell({
  sidebar,
  main,
}: {
  sidebar: React.ReactNode;
  main: React.ReactNode;
}) {
  const sidebarWidthPct = useStore((s) => s.sidebarWidthPct);
  const setSidebarWidthPct = useStore((s) => s.setSidebarWidthPct);
  const { t } = useTranslation();

  // Percent value as a string, which is what the library's defaultSize prop
  // expects when we want percentage semantics. Clamp to a sane range so a
  // corrupted persisted state can't wedge the UI at 0%.
  const defaultSidebarPct = Math.round(
    Math.max(12, Math.min(40, sidebarWidthPct * 100))
  );

  return (
    <Group
      orientation="horizontal"
      className="app-shell flex h-full w-full bg-bg-app text-fg-primary"
    >
      <Panel
        id="sidebar"
        defaultSize={`${defaultSidebarPct}%`}
        minSize="220px"
        maxSize="480px"
        onResize={(size: PanelSize) => {
          // asPercentage ∈ [0..100]; we normalize to the 0..1 fraction our
          // store uses. Setter clamps again so we never persist an out-of-
          // range value even if the library miscalculates on edge resizes.
          setSidebarWidthPct(size.asPercentage / 100);
        }}
        className="flex"
      >
        {sidebar}
      </Panel>
      <Separator
        className="pane-resize-handle"
        aria-label={t('appShell.resizeSidebar')}
      />
      <Panel
        id="main"
        defaultSize={`${100 - defaultSidebarPct}%`}
        minSize="480px"
        className="flex"
      >
        {main}
      </Panel>
    </Group>
  );
}
