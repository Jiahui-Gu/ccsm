// Tauri shell host config — built from the daemon spawn handshake.
//
// Wave-2 T10 (#685). Unlike the web shell (same-origin + sessionStorage),
// the Tauri shell talks to a daemon on `http://127.0.0.1:<port>` where port
// + token come from the `daemon-ready` event emitted by the Rust side
// (`start_daemon` Tauri command, T8). The token is delivered once at spawn
// time and held in the closure returned by getToken; if T12+ later rotates
// the token (e.g. handshake redo) the shell will rebuild HostConfig and
// re-mount <RuntimeProvider>.
import type { HostConfig } from '@ccsm/ui';

export interface Handshake {
  ready: boolean;
  port: number;
  token: string;
}

export function buildTauriHostConfig(hs: Handshake): HostConfig {
  return {
    httpBase: `http://127.0.0.1:${hs.port}`,
    getToken: () => hs.token,
  };
}
