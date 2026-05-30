// electron/remote/tokenProvider.ts
/** The login-state seam for the public-internet mobile path. PR-4 ships this
 *  minimal env reader so the controller + loopback e2e exercise the real
 *  pipe with an INJECTED JWT; PR-4b replaces the body with GitHub OAuth +
 *  safeStorage refresh while keeping this signature (detail spec §4.2, §9).
 *  Returns null = not logged in / feature off → controller no-ops. */
export type MobileRemoteLogin = {
  /** Short-lived session JWT minted by the Worker's OAuth flow. */
  token: string;
  /** The Durable Object base wss URL (no token query yet), e.g.
   *  `wss://<worker>/do/<userHash>`. The controller appends `?token=`. */
  doUrl: string;
};

export type TokenProvider = () => MobileRemoteLogin | null;

export function readMobileRemoteLogin(): MobileRemoteLogin | null {
  const token = process.env.CCSM_MOBILE_REMOTE_TOKEN;
  const doUrl = process.env.CCSM_MOBILE_REMOTE_DO_URL;
  if (!token || !doUrl) return null;
  return { token, doUrl };
}
