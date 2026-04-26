import { useStore } from '../stores/store';
import { i18next } from '../i18n';
import { getMaxThinkingTokensForModel } from './thinking';

/**
 * Kick off `agent:start` for the given session and reconcile store state
 * based on the result. Shared between the InputBar's first-send path and the
 * AgentInitFailedBanner retry button so both converge on identical state
 * transitions (no chance of the retry path drifting out of sync with the
 * primary path — the classic "works on Send, broken on Retry" trap).
 *
 * Returns `true` if the start succeeded; `false` otherwise. On failure, the
 * store is populated with the appropriate flag (sessionInitFailures entry,
 * installerCorrupt flag for CLAUDE_NOT_FOUND, cwdMissing marker) so the
 * renderer surfaces the right UX without the caller having to duplicate
 * the branching logic.
 *
 * The CLAUDE_NOT_FOUND and CWD_MISSING branches still have bespoke UX
 * elsewhere (installer-corrupt banner + StatusBar cwd chip). We surface the
 * generic failed-to-start banner only for OTHER failures — typically a spawn
 * EACCES, or a kernel-level process-creation error.
 */
export async function startSessionAndReconcile(sessionId: string): Promise<boolean> {
  const store = useStore.getState();
  const session = store.sessions.find((s) => s.id === sessionId);
  const api = window.ccsm;
  if (!session || !api) return false;

  // Pass `sessionId` so the SDK uses ccsm's id as the CLI session_id —
  // keeps the on-disk JSONL filename identical to what ccsm shows. We omit
  // it when `resumeSessionId` is set: the SDK rejects passing both at once
  // (it would conflict with which conversation to load), and on resume the
  // SDK allocates a new sid for the resumed branch which we'll capture
  // server-side and surface back via a future hook.
  //
  // Legacy persisted sessions whose id starts with `s-` (pre-PR-D format)
  // also skip the sessionId option: the SDK validates UUID shape and would
  // reject the prefixed string. They keep the legacy behaviour of getting
  // an SDK-allocated sid, matching their pre-upgrade state.
  const isUuidShaped = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    sessionId,
  );
  const res = await api.agentStart(sessionId, {
    cwd: session.cwd,
    model: session.model || undefined,
    permissionMode: store.permission,
    resumeSessionId: session.resumeSessionId,
    sessionId:
      session.resumeSessionId == null && isUuidShaped ? sessionId : undefined,
  });

  if (res.ok) {
    store.clearSessionInitFailure(sessionId);
    store.markStarted(sessionId);
    // Any successful start proves the bundled CLI binary is reachable, so
    // clear the installer-corrupt banner. Idempotent: harmless when the flag
    // is already false. Without this reset the banner stayed visible until
    // app restart even after the user reinstalled and a session launched OK.
    store.setInstallerCorrupt(false);
    // Push the resolved thinking-tokens cap to the freshly-spawned session
    // so launch + resume both honour the user's `/think` toggle. Mirrors
    // upstream's `launchClaude(..., thinkingLevel)` behaviour where the cap
    // is delivered as the first control RPC after init. Sent unconditionally
    // (including the value 0) so an off-by-default session explicitly clears
    // any stale cap from the SDK side.
    const fresh = useStore.getState();
    const level =
      fresh.thinkingLevelBySession[sessionId] ?? fresh.globalThinkingDefault;
    const tokens = getMaxThinkingTokensForModel(session.model || undefined, level);
    void api.agentSetMaxThinkingTokens(sessionId, tokens);
    return true;
  }

  // Route to the right surface based on errorCode.
  if (res.errorCode === 'CLAUDE_NOT_FOUND') {
    // CCSM ships the binary inside the installer (PR-B) — reaching this
    // means the installer payload is corrupt or partially uninstalled. Show
    // the persistent installer-corrupt banner; no per-session retry path
    // since the user must reinstall before sessions can start.
    store.setInstallerCorrupt(true);
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
