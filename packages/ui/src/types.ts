// HostConfig — what shells (web / Tauri) inject into RuntimeProvider.
//
// Wave-2 T6 (#686): @ccsm/ui is the shared React layer. It owns the store,
// components, hooks, and the SessionRuntime instance, but it knows nothing
// about WHERE the daemon lives or HOW the bearer token is obtained — that
// differs per shell:
//
//   - Web (frontend-web): same-origin httpBase from window.location, token
//     from sessionStorage (main.tsx wrote it from the URL ?token= on load).
//   - Tauri (frontend-tauri, T10): httpBase is `http://127.0.0.1:<port>`
//     where port comes from the daemon spawn handshake; token comes from
//     the same handshake and is held in a closure.

export interface HostConfig {
  /**
   * Absolute base URL of the daemon: protocol + host (+ optional port). The
   * runtime / api wrappers append paths (`/api/sessions`, `/ws`) directly,
   * so no trailing slash is expected.
   */
  httpBase: string;
  /**
   * Read the current bearer token. Called at action time (createSession /
   * resumeSession / ws connect), so a shell that rotates the token only
   * has to make the next call return the new value.
   */
  getToken: () => string | null;
  /**
   * Optional override for the ws upgrade path (Task #793, S3-G). Defaults to
   * `/ws`. Cloud-tunnel deployment uses `/ws/default` so the request reaches
   * the Worker + DO instead of falling through to the SPA.
   */
  wsPath?: string;
}
