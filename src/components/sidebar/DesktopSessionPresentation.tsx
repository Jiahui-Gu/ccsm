// Desktop-side adapter for the shared session-navigator presentation
// (src/shared/sessionNavigator). SessionRow/GroupRow keep full ownership of
// their DOM structure, dnd-kit wiring, context menus, rename, and
// selection/crash state; they only borrow the shared typography/cwd/state
// glyph bodies (SessionNavigatorItemBody / SessionGroupHeaderBody) for the
// row/group content. See docs/superpowers/plans/2026-07-21-mobile-remote-shared-ui.md
// Task 4.
import '../../shared/sessionNavigator/sessionNavigator.css';
import type { Session } from '../../types';
import type { SessionNavigatorSession } from '../../shared/sessionNavigator/presentation';

// Desktop density matches the shared "desktop" row/group min-height token
// (36px) used by SessionNavigatorItem/SessionGroupHeader when rendered at
// full density, as opposed to the touch-optimized 44px density used by the
// mobile/remote navigator.
export const DESKTOP_NAVIGATOR_DENSITY = 'desktop' as const;

/**
 * Deterministically maps a desktop `Session` (2-state `idle`/`waiting`
 * renderer model, see src/types.ts) plus the row's `active`/`crashed`
 * booleans onto the shared 4-state `SessionNavigatorSession` used by the
 * shared presentation primitives:
 *   - crashed session       -> 'exited'
 *   - active (non-crashed)  -> 'active'
 *   - otherwise             -> session.state ('idle' | 'waiting')
 *
 * `cwd` and `name` are preserved verbatim; `order` is not meaningful for a
 * single-row mapping (desktop ordering is owned by dnd-kit/SortableContext)
 * so it is fixed at 0.
 */
export function toDesktopNavigatorSession(
  session: Session,
  active: boolean,
  crashed: boolean,
): SessionNavigatorSession {
  return {
    id: session.id,
    name: session.name,
    cwd: session.cwd,
    order: 0,
    state: crashed ? 'exited' : active ? 'active' : session.state,
  };
}
