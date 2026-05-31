// electron/remote/turnCred.ts
import { type RTCIceServer } from 'werift';

/** Fetch ICE servers (STUN + optional TURN) from the Worker's
 *  `POST /turn/credentials`. Returns null — never throws — on any non-OK
 *  response (501 "turn not configured" is the expected default), network
 *  error, or malformed body, so the controller degrades to STUN-only instead
 *  of crashing mobile-remote startup. `fetchImpl` is injectable for tests. */
export async function fetchIceServers(deps: {
  workerOrigin: string;
  token: string;
  fetchImpl?: typeof fetch;
}): Promise<RTCIceServer[] | null> {
  const f = deps.fetchImpl ?? fetch;
  try {
    const res = await f(new URL('/turn/credentials', deps.workerOrigin).toString(), {
      method: 'POST',
      headers: { authorization: `Bearer ${deps.token}` },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { iceServers?: RTCIceServer[] };
    return Array.isArray(body.iceServers) ? body.iceServers : null;
  } catch {
    return null;
  }
}
