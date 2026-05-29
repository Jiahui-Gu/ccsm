import React, { createContext, useContext } from 'react';

// The five top-level Sidebar action callbacks used to be prop-drilled from
// App.tsx through <Sidebar> into its action buttons / child clusters
// (DEBT.md #7). They're stable App-level handlers that never vary per render
// branch, so a context fits better than threading them as props: it drops
// Sidebar's prop surface from 11 to 6 and lets the leaf consumers
// (e.g. the New Session cluster) read them directly without intermediate
// pass-through. Mirrors the <ToastProvider> / useToast() shape: a nullable
// context + a hook that throws when used outside the provider.
export type SidebarActions = {
  /** Create a new session in-place (home-dir default cwd). */
  onCreateSession?: () => void;
  /** Create a new session in a user-picked working directory. */
  onCreateSessionWithCwd?: (cwd: string) => void;
  onOpenSettings?: () => void;
  onOpenPalette?: () => void;
  onOpenImport?: () => void;
};

const Ctx = createContext<SidebarActions | null>(null);

export function SidebarActionsProvider({
  value,
  children,
}: {
  value: SidebarActions;
  children: React.ReactNode;
}) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSidebarActions() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useSidebarActions must be used inside <SidebarActionsProvider>');
  return ctx;
}
