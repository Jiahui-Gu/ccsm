// Focused coverage for SidebarActionsContext (DEBT.md #7): the 5 sidebar
// action callbacks moved off props onto a context. Assert the hook throws
// outside a provider (the guard that surfaces a forgotten provider as a clear
// error rather than a silent undefined-callback no-op) and returns the exact
// callbacks inside one.
import React from 'react';
import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import {
  SidebarActionsProvider,
  useSidebarActions,
  type SidebarActions,
} from '../../src/components/sidebar/SidebarActionsContext';

describe('useSidebarActions', () => {
  it('throws when used outside a SidebarActionsProvider', () => {
    expect(() => renderHook(() => useSidebarActions())).toThrow(
      /must be used inside <SidebarActionsProvider>/
    );
  });

  it('returns the provided callbacks inside a provider', () => {
    const value: SidebarActions = {
      onCreateSession: () => {},
      onCreateSessionWithCwd: () => {},
      onOpenSettings: () => {},
      onOpenPalette: () => {},
      onOpenImport: () => {},
    };
    const { result } = renderHook(() => useSidebarActions(), {
      wrapper: ({ children }) => (
        <SidebarActionsProvider value={value}>{children}</SidebarActionsProvider>
      ),
    });
    expect(result.current).toBe(value);
    expect(result.current.onCreateSession).toBe(value.onCreateSession);
    expect(result.current.onOpenSettings).toBe(value.onOpenSettings);
  });
});
