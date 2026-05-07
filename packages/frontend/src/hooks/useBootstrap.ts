// Bootstrap hook (#670): on App mount (and whenever the token changes), pull
// the session list from the daemon and hydrate the store so a browser
// refresh doesn't appear to wipe the user's existing sessions.
//
// SCOPE — what this hook owns:
//   - One GET /api/sessions per token transition.
//   - Hydrating the store via `hydrateSessions` (append-only, idempotent).
//
// EXPLICITLY OUT OF SCOPE:
//   - Setting activeSid (the user picks; bootstrap must not yank focus).
//   - Spinning up ws / scrollback (session-runtime owns that).
//   - Retrying on transient failure (post-MVP — today we just warn).

import { useEffect } from 'react';
import { HttpError, listSessions } from '../api/sessions';
import { useStore } from '../store';

export function useBootstrap(): void {
  const token = useStore((s) => s.token);
  const hydrateSessions = useStore((s) => s.hydrateSessions);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    listSessions(token)
      .then((r) => {
        if (cancelled) return;
        hydrateSessions(r.sessions);
      })
      .catch((err) => {
        if (cancelled) return;
        if (
          err instanceof HttpError &&
          (err.status === 401 || err.status === 403)
        ) {
          // Auth failures are expected when the token is stale — the user
          // will land on the login screen anyway. Don't surface as an error.
          console.warn(
            '[ccsm/bootstrap] token rejected, sessions not hydrated',
          );
        } else {
          console.warn('[ccsm/bootstrap] listSessions failed:', err);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [token, hydrateSessions]);
}
