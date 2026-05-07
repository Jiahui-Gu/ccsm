import type { ReactNode } from 'react';

interface AppShellProps {
  sidebar: ReactNode;
  main: ReactNode;
}

// Two-column shell: fixed-width sidebar + flex-fill main. No draggable resizer
// in MVP (DESIGN.md §7 calls one out as future work, T5 ships fixed width).
export function AppShell({ sidebar, main }: AppShellProps) {
  return (
    <div className="app-shell">
      <aside className="app-shell__sidebar" data-testid="app-shell-sidebar">
        {sidebar}
      </aside>
      <main className="app-shell__main" data-testid="app-shell-main">
        {main}
      </main>
    </div>
  );
}
