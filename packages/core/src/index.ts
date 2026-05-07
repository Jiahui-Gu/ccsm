// @ccsm/core public surface (wave-2 T3).
//
// Framework-agnostic primitives shared by both the web frontend and the
// future Tauri desktop shell. Zero React / zustand / window dependencies —
// host-specific concerns (URL bases, auth tokens) are injected by the
// adapter at construction time.
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
