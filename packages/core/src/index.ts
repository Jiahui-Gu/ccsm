// @ccsm/core public surface (wave-2 T3 + T4 + T5).
//
// Framework-agnostic primitives shared by both the web frontend and the
// future Tauri desktop shell. Zero React / zustand / window dependencies —
// host-specific concerns (URL bases, auth tokens, status routing) are
// injected by the adapter at construction time.
export {
  WsClient,
  buildWsUrl,
  type HostBase,
  type WsClientOptions,
  type WsStatus,
} from './ws/client.js';

// Wave-2 T4 (#689): REST API helpers for /api/sessions.
export {
  HttpError,
  createSession,
  deleteSession,
  listSessions,
  resumeSession,
  type SessionsApiOptions,
} from './api/sessions.js';

// T5 (#688): per-session runtime — ws lifecycle, scrollback, reconnect,
// PAUSE/RESUME backpressure. Decoupled from React/zustand via injected
// `statusSink` + optional `outputSink`.
export {
  SessionRuntime,
  type SessionRuntimeOptions,
} from './runtime/session-runtime.js';
export {
  PAUSE_THRESHOLD,
  RECONNECT_DELAYS_MS,
  SCROLLBACK_CAP_BYTES,
  type OutputListener,
  type OutputSink,
  type SessionRuntimeEntry,
  type StatusSink,
} from './runtime/types.js';
