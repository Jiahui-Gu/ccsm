// S4-T8 (Task #141): SPA-side helpers for the device-flow login button.
// R-51c (Task #169): added PKCE helpers for the deep-link primary path.
//
// The Rust side (auth.rs) owns the actual flow: HTTP to cf-worker, polling
// or deep-link reception, disk persistence, env injection into the daemon.
// The SPA only:
//   - invokes start_pkce_oauth() (default, deep-link round-trip via OS),
//   - invokes start_device_oauth() (fallback, user-code modal + polling),
//   - listens for `oauth-complete` / `oauth-failed` / `oauth-state-change`,
//   - calls oauth_logout() when the user signs out,
//   - calls get_oauth_login() at mount to render the current "@user" if any.
//
// The tunnel JWT is intentionally NEVER exposed to the renderer — only the
// resolved login string crosses the IPC boundary on success.
//
// R-51c note: cf-worker emits a single `oauth-failed` event for both flows;
// R-51b did NOT introduce a separate `pkce_oauth_failed` channel — the SPA
// must distinguish locally based on which command was last invoked. We model
// that by tracking a small in-memory flag in LoginButton instead of inventing
// a backend channel that doesn't exist yet.

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export type OauthState = 'idle' | 'awaiting_user' | 'success' | 'failed';

export interface StartOauthSpaPayload {
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

export interface OauthCompletePayload {
  login: string;
}

export interface OauthFailedPayload {
  reason: string;
}

export async function invokeStartOauth(): Promise<StartOauthSpaPayload> {
  return invoke<StartOauthSpaPayload>('start_oauth');
}

/// R-51c (Task #169): kick off the PKCE / deep-link primary path. The Rust
/// command POSTs to cf-worker `/api/auth/desktop/start`, opens the GitHub
/// authorize URL via plugin-shell, and parks state in PkceStateStore so the
/// `ccsm://oauth?...` deep link can be verified on return. The command
/// returns once the browser has been launched — completion is signaled by
/// the existing `oauth-complete` event (no extra payload).
export async function invokeStartPkceOauth(): Promise<void> {
  return invoke<void>('start_pkce_oauth');
}

/// R-51c (Task #169): kick off the device-flow fallback path. Same shape
/// (and same SPA UI) as the legacy `start_oauth` — kept as a separate
/// command so the Rust side can later diverge (e.g. extra telemetry on
/// fallback frequency) without affecting the PKCE path.
export async function invokeStartDeviceOauth(): Promise<StartOauthSpaPayload> {
  return invoke<StartOauthSpaPayload>('start_device_oauth');
}

export async function invokeGetOauthState(): Promise<OauthState> {
  return invoke<OauthState>('get_oauth_state');
}

export async function invokeGetOauthLogin(): Promise<string | null> {
  return invoke<string | null>('get_oauth_login');
}

export async function invokeOauthLogout(): Promise<void> {
  return invoke<void>('oauth_logout');
}

export function onOauthComplete(
  cb: (payload: OauthCompletePayload) => void,
): Promise<UnlistenFn> {
  return listen<OauthCompletePayload>('oauth-complete', (e) => cb(e.payload));
}

export function onOauthFailed(
  cb: (payload: OauthFailedPayload) => void,
): Promise<UnlistenFn> {
  return listen<OauthFailedPayload>('oauth-failed', (e) => cb(e.payload));
}

export function onOauthStateChange(
  cb: (state: OauthState) => void,
): Promise<UnlistenFn> {
  return listen<OauthState>('oauth-state-change', (e) => cb(e.payload));
}
