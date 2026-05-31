// electron/remote/turnCred.ts
import { type RTCIceServer } from 'werift';

type WireIceServer = {
  urls: string | string[];
  username?: string;
  credential?: string;
};

/** werift's RTCIceServer.urls is a single string and werift consumes it as
 *  one (`urls.includes("stun:")`, `urls.slice(5)`). The Worker sends `urls`
 *  as a string[] (comma-split STUN_URLS/TURN_URLS). Flatten each wire entry
 *  into one werift entry per url, carrying username/credential onto each so
 *  TURN auth survives. */
function flattenIceServers(wire: WireIceServer[]): RTCIceServer[] {
  const out: RTCIceServer[] = [];
  for (const entry of wire) {
    const urls = Array.isArray(entry.urls) ? entry.urls : [entry.urls];
    for (const url of urls) {
      if (typeof url !== 'string' || url.length === 0) continue;
      const server: RTCIceServer = { urls: url };
      if (entry.username !== undefined) server.username = entry.username;
      if (entry.credential !== undefined) server.credential = entry.credential;
      out.push(server);
    }
  }
  return out;
}

/** Fetch ICE servers (STUN + optional TURN) from the Worker's
 *  `POST /turn/credentials`. Returns null — never throws — on any non-OK
 *  response (501 "turn not configured" is the expected default), network
 *  error, malformed body, or a payload that flattens to nothing, so the
 *  controller degrades to STUN-only instead of crashing mobile-remote
 *  startup. `fetchImpl` is injectable for tests. */
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
    const body = (await res.json()) as { iceServers?: WireIceServer[] };
    if (!Array.isArray(body.iceServers)) return null;
    const flat = flattenIceServers(body.iceServers);
    return flat.length > 0 ? flat : null;
  } catch {
    return null;
  }
}
