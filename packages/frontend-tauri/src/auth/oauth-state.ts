// S4-T8 (Task #141): SPA-side helpers for the device-flow login button.
//
// The Rust side (auth.rs) owns the actual flow: HTTP to cf-worker, polling,
// disk persistence, env injection into the daemon. The SPA only:
//   - invokes start_oauth() on click (Rust returns user_code + verification_uri),
//   - listens for `oauth-complete` / `oauth-failed` / `oauth-state-change`,
//   - calls oauth_logout() when the user signs out,
//   - calls get_oauth_login() at mount to render the current "@user" if any.
//
// The tunnel JWT is intentionally NEVER exposed to the renderer — only the
// resolved login string crosses the IPC boundary on success.

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
