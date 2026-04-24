import { useStore } from '../stores/store';
import { i18next } from '../i18n';

/**
 * Kick off `agent:start` for the given session and reconcile store state
 * based on the result. Shared between the InputBar's first-send path and the
 * AgentInitFailedBanner retry button so both converge on identical state
 * transitions (no chance of the retry path drifting out of sync with the
 * primary path — the classic "works on Send, broken on Retry" trap).
 *
 * Returns `true` if the start succeeded; `false` otherwise. On failure, the
 * store is populated with the appropriate flag (sessionInitFailures entry,
 * cliStatus missing flip, cwdMissing marker) so the renderer surfaces the
 * right UX without the caller having to duplicate the branching logic.
 *
 * The CLAUDE_NOT_FOUND and CWD_MISSING branches still have bespoke UX
 * elsewhere (CLI wizard + StatusBar cwd chip). We surface the generic
 * failed-to-start banner only for OTHER failures — typically a spawn
 * EACCES, a missing binary that slipped past the wizard, or a kernel-level
 * process-creation error.
 */
export async function startSessionAndReconcile(sessionId: string): Promise<boolean> {
  const store = useStore.getState();
  const session = store.sessions.find((s) => s.id === sessionId);
  const api = window.agentory;
  if (!session || !api) return false;

  const res = await api.agentStart(sessionId, {
    cwd: session.cwd,
    model: session.model || undefined,
    permissionMode: store.permission,
    resumeSessionId: session.resumeSessionId,
  });

  if (res.ok) {
    store.clearSessionInitFailure(sessionId);
    store.markStarted(sessionId);
    return true;
  }

  // Route to the right surface based on errorCode.
  if (res.errorCode === 'CLAUDE_NOT_FOUND') {
    store.setCliMissing(res.searchedPaths ?? []);
    return false;
  }
  if (res.errorCode === 'CWD_MISSING') {
    store.markSessionCwdMissing(sessionId, true);
    store.appendBlocks(sessionId, [
      {
        kind: 'error',
        id: `cwd-missing-${Date.now().toString(36)}`,
        text: i18next.t('chat.cwdMissing', { cwd: session.cwd }),
      },
    ]);
    return false;
  }

  // Generic init failure — F7 banner handles this. Set the session-level
  // flag instead of appending an error block, so a retry can replace the
  // banner in-place without polluting chat history with repeated errors.
  // For CLI_SPAWN_FAILED we tack the captured stderr tail onto the message
  // so the banner shows *why* the CLI bailed (missing dependency, bad shim,
  // ENOENT after spawn, etc.) rather than a bare "agent failed to start".
  const errMessage =
    res.errorCode === 'CLI_SPAWN_FAILED' && res.detail
      ? `${res.error} — ${res.detail}`
      : res.error;
  store.setSessionInitFailure(sessionId, {
    error: errMessage,
    errorCode: res.errorCode,
    searchedPaths: res.searchedPaths,
  });
  return false;
}
