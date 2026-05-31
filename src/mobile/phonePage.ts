// src/mobile/phonePage.ts
import { Terminal } from '@xterm/xterm';
import { bootPhonePage } from './mobilePage';

export type BootFragment = {
  token: string | null;
  doUrl: string;
  stun: string[];
};

export function parseBootFragment(hash: string): BootFragment {
  const p = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
  const stun = (p.get('stun') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return { token: p.get('token'), doUrl: p.get('doUrl') ?? '', stun };
}

/** Fetch full STUN+TURN from the Worker; fall back to the fragment's STUN-only
 *  set when TURN is unconfigured (501) or the call fails. The phone is a browser
 *  RTCPeerConnection, which accepts `urls: string[]` natively — no flatten. */
export async function resolveIceServers(
  workerOrigin: string,
  token: string,
  fragmentStun: string[],
  fetchFn: typeof fetch = fetch,
): Promise<RTCIceServer[]> {
  try {
    const res = await fetchFn(`${workerOrigin}/turn/credentials`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
    if (res.status === 200) {
      const body = (await res.json()) as { iceServers: RTCIceServer[] };
      if (Array.isArray(body.iceServers) && body.iceServers.length) return body.iceServers;
    }
  } catch { /* network/no-turn: fall through to STUN-only */ }
  return [{ urls: fragmentStun }];
}

function makeChip(sid: string, label: string, active: boolean, onSelect: () => void): Node {
  const el = document.createElement('button');
  el.className = active ? 'chip chip-active' : 'chip';
  el.textContent = label || sid;
  el.addEventListener('click', onSelect);
  return el;
}

export async function main(): Promise<void> {
  const statusEl = document.getElementById('status') as HTMLElement;
  const sessionListEl = document.getElementById('sessions') as HTMLElement;
  const termEl = document.getElementById('terminal') as HTMLElement;

  const frag = parseBootFragment(location.hash);
  if (!frag.token) {
    statusEl.textContent = 'not logged in';
    const a = document.createElement('a');
    a.href = '/auth/github/login';
    a.textContent = 'Sign in with GitHub';
    sessionListEl.replaceChildren(a);
    return;
  }

  const terminal = new Terminal({ convertEol: true, fontSize: 13 });
  terminal.open(termEl);

  const iceServers = await resolveIceServers(location.origin, frag.token, frag.stun);

  bootPhonePage({
    terminal,
    sessionListEl,
    statusEl,
    makeChip,
    locationSearch: `?token=${encodeURIComponent(frag.token)}`,
    doUrl: frag.doUrl,
    iceServers,
  });
}

if (typeof document !== 'undefined' && document.getElementById('terminal')) {
  void main();
}
