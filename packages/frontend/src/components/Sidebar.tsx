// Sidebar — Task #656 / T9 (DESIGN.md §7).
//
// Layout invariants (preserved from T5):
//   Zone 1 — top:        + New Session  (PRIMARY) | search icon (placeholder)
//   Zone 2 — middle:     GROUPS list — single hard-coded "default" group with
//                        every store-known session as a row underneath.
//   Zone 3 — Archived:   collapsible, body always renders the empty hint.
//   Zone 4 — bottom:     Settings (placeholder) | Import (placeholder)
//
// What T9 wires for real:
//   - + New Session button calls POST /api/sessions and appends the sid to
//     the store via `addSession()` (which auto-promotes it to active so the
//     MainPane re-attaches). Failures surface as alert() — same UX language
//     the placeholder buttons already use; structured error UI is post-MVP.
//   - Each session row click → `setActive(sid)`.
//   - Each row's hover-revealed × button → DELETE /api/sessions/:sid then
//     `closeSession(sid)`. We optimistically prune from the store on success;
//     on failure we surface the error and leave the row intact so the user
//     can retry.
//
// What stays placeholder (out of MVP scope):
//   - GROUPS [+] button (no real multi-group support yet)
//   - Search, Settings, Import, Archived expand/collapse body
//
// Per the dispatch spec we MUST NOT touch the daemon to add/move state for
// these placeholders; they remain noop alerts so the layout shows complete.

import { useState } from 'react';
import { createSession, deleteSession, HttpError } from '../api/sessions';
import { useStore } from '../store';

const notImplemented = (): void => {
  alert('not implemented');
};

/**
 * Short visual id for sidebar rows. We slice the sid (a UUID in real life,
 * but anything in tests) down to its leading 4 characters — enough for the
 * user to disambiguate a handful of concurrent sessions without burning the
 * sidebar width on a full UUID. Mirrors the DESIGN.md §7 mockup.
 */
function shortSid(sid: string): string {
  return sid.length <= 4 ? sid : sid.slice(0, 4);
}

/**
 * Format a unix-ms timestamp as HH:MM in the local timezone. Pure helper
 * (no Date.now() dependency) so the column stays stable in tests.
 */
function formatHHMM(createdAt: number): string {
  const d = new Date(createdAt);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

export function Sidebar() {
  const [archivedExpanded, setArchivedExpanded] = useState(false);
  // Prevents a second + New Session click from racing while POST is in flight.
  // We deliberately do not surface a spinner — the daemon is local so the
  // round-trip is sub-millisecond in practice.
  const [creating, setCreating] = useState(false);

  const token = useStore((s) => s.token);
  const sessions = useStore((s) => s.sessions);
  const activeSid = useStore((s) => s.activeSid);
  const addSession = useStore((s) => s.addSession);
  const setActive = useStore((s) => s.setActive);
  const closeSessionInStore = useStore((s) => s.closeSession);

  // Mirror MainPane.resolveToken: prefer the store cache, fall back to
  // sessionStorage at action time so unit tests that stash the token in
  // beforeEach (after the store module evaluated) still authenticate.
  const resolveToken = (): string | null => {
    if (token) return token;
    if (typeof window === 'undefined') return null;
    return sessionStorage.getItem('ccsm.token');
  };

  const onNewSession = async (): Promise<void> => {
    if (creating) return;
    const tok = resolveToken();
    if (!tok) {
      alert('no token — append ?token=<t> to the URL and reload');
      return;
    }
    setCreating(true);
    try {
      const resp = await createSession(tok);
      // Daemon contract: createdAt is required. Some test stubs (T6) omit
      // it; fall back to Date.now() so the row still renders an HH:MM column
      // instead of "NaN:NaN".
      const createdAt =
        typeof resp.createdAt === 'number' ? resp.createdAt : Date.now();
      addSession({ sid: resp.sid, createdAt, alive: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      alert(`failed to create session: ${msg}`);
    } finally {
      setCreating(false);
    }
  };

  const onCloseSession = async (sid: string): Promise<void> => {
    const tok = resolveToken();
    if (!tok) {
      // Nothing to call on the daemon, but still prune locally so the UI
      // doesn't stick. This branch is mostly for defensive parity with the
      // create path — by the time we have a session row, we have a token.
      closeSessionInStore(sid);
      return;
    }
    try {
      await deleteSession(tok, sid);
      closeSessionInStore(sid);
    } catch (err) {
      const msg =
        err instanceof HttpError
          ? `${err.status} ${err.message}`
          : err instanceof Error
            ? err.message
            : String(err);
      alert(`failed to close session: ${msg}`);
    }
  };

  return (
    <div className="sidebar">
      {/* Zone 1 — top: New Session + Search */}
      <div className="sidebar__top">
        <button
          type="button"
          className="sidebar__btn sidebar__btn--primary"
          data-testid="sidebar-new-session"
          disabled={creating}
          onClick={() => {
            void onNewSession();
          }}
        >
          + New Session
        </button>
        <button
          type="button"
          className="sidebar__btn sidebar__btn--icon"
          data-testid="sidebar-search"
          aria-label="Search sessions"
          onClick={notImplemented}
        >
          {'\u{1F50D}'}
        </button>
      </div>

      {/* Zone 2 — middle: GROUPS list (T9 wires the default group) */}
      <div className="sidebar__groups" data-testid="sidebar-groups">
        <div className="sidebar__groups-header">
          <span className="sidebar__groups-label">GROUPS</span>
          <button
            type="button"
            className="sidebar__btn sidebar__btn--icon"
            aria-label="Add group"
            // Multi-group is intentionally deferred (DESIGN.md §7 / MVP
            // boundary). Keep the button visible so the layout matches the
            // mockup, but make the click an explicit not-implemented.
            onClick={notImplemented}
          >
            +
          </button>
        </div>

        <div className="sidebar__group" data-testid="sidebar-group-default">
          <div className="sidebar__group-header">{'▾'} default</div>
          {sessions.length === 0 ? (
            <div className="sidebar__groups-empty">
              No sessions yet — click + New Session above
            </div>
          ) : (
            <ul className="sidebar__session-list">
              {sessions.map((s) => {
                const isActive = s.sid === activeSid;
                return (
                  <li
                    key={s.sid}
                    className={
                      isActive
                        ? 'sidebar__session sidebar__session--active'
                        : 'sidebar__session'
                    }
                    data-testid={`sidebar-session-${s.sid}`}
                    data-active={isActive ? 'true' : 'false'}
                  >
                    <button
                      type="button"
                      className="sidebar__session-row"
                      data-testid={`sidebar-session-row-${s.sid}`}
                      onClick={() => setActive(s.sid)}
                    >
                      <span className="sidebar__session-marker">
                        {isActive ? '*' : ' '}
                      </span>
                      <span className="sidebar__session-sid">
                        {shortSid(s.sid)}
                      </span>
                      <span className="sidebar__session-time">
                        {formatHHMM(s.createdAt)}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="sidebar__session-close"
                      data-testid={`sidebar-session-close-${s.sid}`}
                      aria-label={`Close session ${shortSid(s.sid)}`}
                      onClick={(e) => {
                        // Prevent the row's setActive click from firing first
                        // when the X is nested inside the same flex row.
                        e.stopPropagation();
                        void onCloseSession(s.sid);
                      }}
                    >
                      {'×'}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      {/* Zone 3 — Archived collapsible (placeholder) */}
      <div className="sidebar__archived">
        <button
          type="button"
          className="sidebar__archived-toggle"
          data-testid="sidebar-archived"
          aria-expanded={archivedExpanded}
          onClick={() => setArchivedExpanded((v) => !v)}
        >
          {archivedExpanded ? '▾' : '▸'} Archived
        </button>
        {archivedExpanded && (
          <div className="sidebar__archived-body">no archived groups</div>
        )}
      </div>

      {/* Zone 4 — bottom: Settings + Import (placeholders) */}
      <div className="sidebar__bottom">
        <button
          type="button"
          className="sidebar__btn sidebar__btn--primary"
          data-testid="sidebar-settings"
          onClick={notImplemented}
        >
          {'⚙'} Settings
        </button>
        <button
          type="button"
          className="sidebar__btn sidebar__btn--icon"
          data-testid="sidebar-import"
          aria-label="Import"
          onClick={notImplemented}
        >
          {'⬇'}
        </button>
      </div>
    </div>
  );
}
