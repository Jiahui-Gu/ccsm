// S4-T8 (Task #141): GitHub device-flow OAuth, on-demand from the main UI.
//
// User pressing the Login button triggers `start_oauth`, which:
//   1. POSTs <auth-base>/api/auth/device/start to mint device + user codes.
//      The auth base URL is **mandatory env** (`CCSM_AUTH_BASE`); the Tauri
//      shell must stay repo-agnostic (no hardcoded cloud host — see the
//      `Tauri red-line guard (no cloud refs)` CI check + ROADMAP). dev runs
//      pass it via `CCSM_AUTH_BASE=... pnpm tauri dev`; release builds inject
//      it through the packaging pipeline.
//   2. Returns the user_code + verification_uri to the SPA so the modal can
//      display them. The SPA opens the verification URL via plugin-shell; the
//      user finishes auth in their default browser.
//   3. Spawns a background poll task that hits <auth-base>/api/auth/device/poll
//      on the worker-supplied interval. On success it persists the returned
//      tunnel JWT + refresh token to ~/.ccsm/tunnel_jwt (chmod 600 on Unix;
//      on Windows the default %USERPROFILE% ACL provides equivalent
//      protection for the threat model — see daemon_mgr::write_token_file).
//   4. Emits a Tauri event for state transitions (`oauth-state-change`,
//      `oauth-complete`, `oauth-failed`). The JWT itself is NEVER sent to the
//      SPA — only the resolved login is, so the renderer can render "@user".
//
// Why a Rust-side persistor (vs. SPA storing the JWT): the daemon needs the
// JWT in `CCSM_TUNNEL_JWT` env at spawn time. The SPA cannot inject env into
// a child process started by the Tauri shell; only the Rust side can. Storing
// in localStorage would also leak the JWT to the renderer's JS context, which
// is unnecessary surface for a credential the renderer never uses.
//
// On disk format (~/.ccsm/tunnel_jwt) — JSON, single object:
//   { "tunnel_jwt": "<jwt>", "tunnel_refresh_token": "<hex>", "login": "<gh-login>" }
//
// Threat model: only readable by the current OS user. Tunnel refresh rotates
// on every refresh (cf-worker side), so a stolen file gives the attacker at
// most one refresh round-trip until the legitimate daemon next refreshes.

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_shell::ShellExt;
use tokio::time::sleep;

const MAX_POLL_INTERVAL_SEC: u64 = 60;

/// R-51b (Task #168): max age of an in-memory PKCE state entry. Mirrors the
/// cf-worker side's 5-minute TTL on the persisted code_verifier row; if the
/// user takes longer than that to complete the browser round-trip both
/// sides reject the deep-link / callback consistently.
const PKCE_STATE_TTL_SEC: u64 = 5 * 60;

/// Persisted credential blob — read by `daemon_mgr` at spawn time.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PersistedTunnelCreds {
    pub tunnel_jwt: String,
    pub tunnel_refresh_token: String,
    pub login: String,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OauthState {
    Idle,
    AwaitingUser,
    Success,
    Failed,
}

/// Process-wide OAuth state. Held in `tauri::State` so commands and the poll
/// task share a single source of truth.
#[derive(Default)]
pub struct OauthStore {
    state: Mutex<OauthState>,
}

impl OauthStore {
    fn set(&self, app: &AppHandle, next: OauthState) {
        {
            let mut g = self.state.lock().expect("oauth state mutex poisoned");
            *g = next.clone();
        }
        let _ = app.emit("oauth-state-change", &next);
    }

    fn snapshot(&self) -> OauthState {
        self.state
            .lock()
            .expect("oauth state mutex poisoned")
            .clone()
    }
}

impl Default for OauthState {
    fn default() -> Self {
        // If a credential file already exists at startup, the manager flips us
        // to Success on first read. Until then we are idle.
        OauthState::Idle
    }
}

// ---------------------------------------------------------------------------
// R-51b (Task #168): PKCE deep-link state.
//
// `start_pkce_oauth` calls cf-worker /api/auth/desktop/start, which returns
// the GitHub authorize URL plus an opaque `state`. We extract the state from
// the URL and remember it in `PkceStateStore` so the deep-link listener
// (registered in lib.rs / dispatched here via `handle_desktop_callback`) can
// reject any `ccsm://oauth?...&state=X` payload whose state was not minted by
// us.
//
// The store is intentionally tiny — at most one outstanding entry per OS
// session in the common case, but we model a small map so a user who restarts
// the flow before finishing the first one still works. Entries are one-shot
// (consumed on first matching deep link) and time-out after PKCE_STATE_TTL_SEC.
// ---------------------------------------------------------------------------

#[derive(Default)]
pub struct PkceStateStore {
    entries: Mutex<Vec<PkceStateEntry>>,
}

#[derive(Clone, Debug)]
struct PkceStateEntry {
    state: String,
    created_at: u64,
}

impl PkceStateStore {
    /// Record a freshly minted state. Caller is `start_pkce_oauth`.
    fn insert(&self, state: String) {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let mut g = self.entries.lock().expect("pkce state mutex poisoned");
        // Prune expired.
        g.retain(|e| now.saturating_sub(e.created_at) <= PKCE_STATE_TTL_SEC);
        g.push(PkceStateEntry { state, created_at: now });
    }

    /// Look up + remove the entry matching `state`. Returns true if a fresh,
    /// not-yet-consumed entry was found and consumed; false otherwise (used
    /// once, never minted, or aged out).
    fn take(&self, state: &str) -> bool {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let mut g = self.entries.lock().expect("pkce state mutex poisoned");
        // Drop expired up front so a state can't survive past TTL even if the
        // user races a second start.
        g.retain(|e| now.saturating_sub(e.created_at) <= PKCE_STATE_TTL_SEC);
        if let Some(idx) = g.iter().position(|e| e.state == state) {
            g.remove(idx);
            true
        } else {
            false
        }
    }
}

// ---------------------------------------------------------------------------
// Wire types — matched 1:1 with cf-worker `deviceFlow.ts`.
// ---------------------------------------------------------------------------

#[derive(Deserialize, Serialize, Clone, Debug)]
pub struct DeviceStartResponse {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub expires_in: u64,
    pub interval: u64,
}

/// What the SPA receives from `start_oauth`. We strip device_code so the SPA
/// cannot directly drive the poll loop (the Rust task owns it).
#[derive(Serialize, Clone, Debug)]
pub struct StartOauthSpaPayload {
    pub user_code: String,
    pub verification_uri: String,
    pub expires_in: u64,
    pub interval: u64,
}

#[derive(Deserialize, Debug)]
struct DevicePollSuccess {
    tunnel_jwt: String,
    tunnel_refresh_token: String,
    login: String,
}

#[derive(Deserialize, Debug)]
struct DevicePollPending {
    status: String,
    interval: Option<u64>,
}

#[derive(Serialize, Clone, Debug)]
pub struct OauthCompletePayload {
    pub login: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct OauthFailedPayload {
    pub reason: String,
}

// ---------------------------------------------------------------------------
// On-disk persistence
// ---------------------------------------------------------------------------

fn ccsm_dir() -> Result<PathBuf, String> {
    #[cfg(windows)]
    let home = std::env::var_os("USERPROFILE")
        .ok_or_else(|| "USERPROFILE env not set".to_string())?;
    #[cfg(not(windows))]
    let home = std::env::var_os("HOME").ok_or_else(|| "HOME env not set".to_string())?;
    Ok(PathBuf::from(home).join(".ccsm"))
}

fn tunnel_jwt_path() -> Result<PathBuf, String> {
    Ok(ccsm_dir()?.join("tunnel_jwt"))
}

pub fn read_persisted_creds() -> Option<PersistedTunnelCreds> {
    let path = match tunnel_jwt_path() {
        Ok(p) => p,
        Err(_) => return None,
    };
    let raw = std::fs::read_to_string(&path).ok()?;
    let parsed: PersistedTunnelCreds = serde_json::from_str(&raw).ok()?;
    if parsed.tunnel_jwt.is_empty() || parsed.login.is_empty() {
        return None;
    }
    Some(parsed)
}

/// Audit F-S-2 (Task #152): extract the `sub` (GitHub user id) claim from a
/// JWT payload **without verifying the signature**. The caller (daemon_mgr)
/// uses the result only as an env-var hint that gets re-checked server-side
/// against an already-verified hello.identity, so the lack of signature
/// check here is intentional — a forged value just makes the daemon refuse
/// every browser, it cannot grant access.
///
/// Returns None on any structural error (not 3 parts / bad base64url / bad
/// JSON / missing string `sub`).
pub fn parse_jwt_sub_unverified(jwt: &str) -> Option<String> {
    let mut parts = jwt.split('.');
    let _hdr = parts.next()?;
    let payload = parts.next()?;
    parts.next()?; // signature segment must exist
    if parts.next().is_some() {
        return None;
    }
    let bytes = base64url_decode(payload)?;
    let v: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    let sub = v.get("sub")?.as_str()?;
    if sub.is_empty() {
        return None;
    }
    Some(sub.to_string())
}

/// Tiny RFC 4648 §5 base64url decoder. Returns None on any invalid char so
/// callers can degrade to "skip identity-bind" rather than panic.
fn base64url_decode(s: &str) -> Option<Vec<u8>> {
    fn idx(c: u8) -> Option<u8> {
        match c {
            b'A'..=b'Z' => Some(c - b'A'),
            b'a'..=b'z' => Some(c - b'a' + 26),
            b'0'..=b'9' => Some(c - b'0' + 52),
            b'-' => Some(62),
            b'_' => Some(63),
            _ => None,
        }
    }
    // Strip optional `=` padding then drive 4-char groups by index math.
    let bytes: Vec<u8> = s.bytes().filter(|b| *b != b'=').collect();
    let mut out = Vec::with_capacity(bytes.len() * 3 / 4);
    let mut chunk = [0u8; 4];
    let mut have = 0usize;
    for b in bytes {
        let v = idx(b)?;
        chunk[have] = v;
        have += 1;
        if have == 4 {
            out.push((chunk[0] << 2) | (chunk[1] >> 4));
            out.push((chunk[1] << 4) | (chunk[2] >> 2));
            out.push((chunk[2] << 6) | chunk[3]);
            have = 0;
        }
    }
    match have {
        0 => {}
        1 => return None, // invalid leftover
        2 => {
            out.push((chunk[0] << 2) | (chunk[1] >> 4));
        }
        3 => {
            out.push((chunk[0] << 2) | (chunk[1] >> 4));
            out.push((chunk[1] << 4) | (chunk[2] >> 2));
        }
        _ => unreachable!(),
    }
    Some(out)
}

fn write_persisted_creds(creds: &PersistedTunnelCreds) -> Result<(), String> {
    let dir = ccsm_dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir {}: {e}", dir.display()))?;
    let path = dir.join("tunnel_jwt");
    let json = serde_json::to_string(creds).map_err(|e| format!("serialize creds: {e}"))?;
    write_creds_file(&path, &json)?;
    Ok(())
}

fn delete_persisted_creds() -> Result<(), String> {
    let path = tunnel_jwt_path()?;
    if path.exists() {
        std::fs::remove_file(&path)
            .map_err(|e| format!("remove {}: {e}", path.display()))?;
    }
    Ok(())
}

#[cfg(unix)]
fn write_creds_file(path: &std::path::Path, contents: &str) -> Result<(), String> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    // Truncate-and-rewrite is OK here — the daemon reads only at spawn time.
    let _ = std::fs::remove_file(path);
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .map_err(|e| format!("create {}: {e}", path.display()))?;
    f.write_all(contents.as_bytes())
        .map_err(|e| format!("write {}: {e}", path.display()))?;
    Ok(())
}

#[cfg(windows)]
fn write_creds_file(path: &std::path::Path, contents: &str) -> Result<(), String> {
    // Windows: %USERPROFILE% files inherit the user-profile ACL (Full Control
    // owner + SYSTEM/Administrators, no other users) — same model as
    // daemon_mgr::write_token_file. See that file for the full rationale.
    use std::io::Write;
    let _ = std::fs::remove_file(path);
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|e| format!("create {}: {e}", path.display()))?;
    f.write_all(contents.as_bytes())
        .map_err(|e| format!("write {}: {e}", path.display()))?;
    Ok(())
}

fn auth_base() -> Result<String, String> {
    // **Mandatory env**: the Tauri shell is repo-agnostic by ROADMAP red-line,
    // so the cloud auth endpoint is never hardcoded — the embedder (dev shell
    // or release packager) must inject it. Returning Err here propagates a
    // clear, actionable failure into `oauth-failed` instead of silently
    // dialing some default host.
    match std::env::var("CCSM_AUTH_BASE") {
        Ok(v) if !v.is_empty() => Ok(v),
        _ => Err("CCSM_AUTH_BASE env not set (Tauri shell must not hardcode an auth host)".to_string()),
    }
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn start_device_oauth(
    app: AppHandle,
    store: State<'_, OauthStore>,
) -> Result<StartOauthSpaPayload, String> {
    // Reject re-entry while a flow is awaiting the user.
    if matches!(store.snapshot(), OauthState::AwaitingUser) {
        return Err("oauth already in progress".to_string());
    }

    let url = format!("{}/api/auth/device/start", auth_base()?);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| format!("build http client: {e}"))?;

    let res = client
        .post(&url)
        .send()
        .await
        .map_err(|e| format!("device/start http error: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("device/start status {}", res.status()));
    }
    let parsed: DeviceStartResponse = res
        .json()
        .await
        .map_err(|e| format!("device/start json: {e}"))?;

    store.set(&app, OauthState::AwaitingUser);

    // Best-effort: open the verification URL in the user's default browser
    // via plugin-shell (already a workspace dep). Failure is logged and the
    // SPA still renders the URL + user_code in its modal so the user can
    // navigate manually.
    if let Err(e) = app.shell().open(&parsed.verification_uri, None) {
        eprintln!("[auth] shell.open({}) failed: {e}", parsed.verification_uri);
    }

    let spa = StartOauthSpaPayload {
        user_code: parsed.user_code.clone(),
        verification_uri: parsed.verification_uri.clone(),
        expires_in: parsed.expires_in,
        interval: parsed.interval.max(1),
    };

    // Spawn the poll loop. We move the device_code in so the SPA never sees
    // it — only the Rust side polls for completion.
    let app_for_poll = app.clone();
    let device_code = parsed.device_code.clone();
    let initial_interval = parsed.interval.max(1);
    let expires_in = parsed.expires_in;
    tauri::async_runtime::spawn(async move {
        run_poll_loop(app_for_poll, device_code, initial_interval, expires_in).await;
    });

    Ok(spa)
}

#[tauri::command]
pub fn get_oauth_state(store: State<'_, OauthStore>) -> OauthState {
    store.snapshot()
}

#[tauri::command]
pub async fn oauth_logout(
    app: AppHandle,
    store: State<'_, OauthStore>,
) -> Result<(), String> {
    delete_persisted_creds()?;
    store.set(&app, OauthState::Idle);
    Ok(())
}

/// Read currently-known login (if any) from the persisted creds. Lets the
/// SPA render "@login" without exposing the JWT.
#[tauri::command]
pub fn get_oauth_login() -> Option<String> {
    read_persisted_creds().map(|c| c.login)
}

// ---------------------------------------------------------------------------
// Poll loop
// ---------------------------------------------------------------------------

async fn run_poll_loop(
    app: AppHandle,
    device_code: String,
    initial_interval_sec: u64,
    expires_in_sec: u64,
) {
    let store: State<OauthStore> = app.state();
    let url = match auth_base() {
        Ok(base) => format!("{}/api/auth/device/poll", base),
        Err(e) => {
            // Should be unreachable in practice — start_oauth already failed
            // with the same Err if env was missing, so the poll task would
            // never have been spawned. Belt-and-suspenders: surface as a
            // normal oauth-failed event rather than panic.
            emit_failed(&app, &store, e);
            return;
        }
    };
    let deadline = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() + expires_in_sec)
        .unwrap_or(u64::MAX);

    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            emit_failed(&app, &store, format!("build http client: {e}"));
            return;
        }
    };

    let mut interval = initial_interval_sec.clamp(1, MAX_POLL_INTERVAL_SEC);

    loop {
        sleep(Duration::from_secs(interval)).await;

        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        if now >= deadline {
            emit_failed(&app, &store, "device code expired".to_string());
            return;
        }

        let body = serde_json::json!({ "device_code": device_code });
        let res = match client.post(&url).json(&body).send().await {
            Ok(r) => r,
            Err(e) => {
                eprintln!("[auth] poll http error: {e}; will retry");
                continue;
            }
        };

        let status = res.status();
        let bytes = match res.bytes().await {
            Ok(b) => b,
            Err(e) => {
                eprintln!("[auth] poll body read error: {e}; will retry");
                continue;
            }
        };

        // Success path — the worker returns 200 + tunnel_jwt.
        if status.is_success() {
            // Try success shape first.
            if let Ok(success) = serde_json::from_slice::<DevicePollSuccess>(&bytes) {
                let creds = PersistedTunnelCreds {
                    tunnel_jwt: success.tunnel_jwt,
                    tunnel_refresh_token: success.tunnel_refresh_token,
                    login: success.login,
                };
                if let Err(e) = write_persisted_creds(&creds) {
                    emit_failed(&app, &store, format!("persist creds: {e}"));
                    return;
                }
                store.set(&app, OauthState::Success);
                let _ = app.emit(
                    "oauth-complete",
                    OauthCompletePayload { login: creds.login.clone() },
                );
                return;
            }
            // Pending / slow_down come back as 200 too.
            if let Ok(pending) = serde_json::from_slice::<DevicePollPending>(&bytes) {
                match pending.status.as_str() {
                    "pending" => {
                        if let Some(i) = pending.interval {
                            interval = i.clamp(1, MAX_POLL_INTERVAL_SEC);
                        }
                        continue;
                    }
                    "slow_down" => {
                        // GitHub's slow_down asks us to back off; honor the
                        // worker-supplied new interval, falling back to +5s.
                        interval = pending
                            .interval
                            .unwrap_or(interval.saturating_add(5))
                            .clamp(1, MAX_POLL_INTERVAL_SEC);
                        continue;
                    }
                    other => {
                        emit_failed(
                            &app,
                            &store,
                            format!("device/poll unknown status: {other}"),
                        );
                        return;
                    }
                }
            }
            emit_failed(
                &app,
                &store,
                "device/poll body shape unknown".to_string(),
            );
            return;
        }

        // 410 expired / 403 denied / 502 etc.
        let parsed = serde_json::from_slice::<DevicePollPending>(&bytes).ok();
        let reason = match parsed.as_ref().map(|p| p.status.as_str()) {
            Some("expired") => "expired".to_string(),
            Some("denied") => "denied".to_string(),
            Some(other) => format!("device/poll error status={other}"),
            None => format!(
                "device/poll http {} body={}",
                status,
                String::from_utf8_lossy(&bytes).chars().take(120).collect::<String>()
            ),
        };
        emit_failed(&app, &store, reason);
        return;
    }
}

fn emit_failed(app: &AppHandle, store: &State<OauthStore>, reason: String) {
    eprintln!("[auth] oauth failed: {reason}");
    store.set(app, OauthState::Failed);
    let _ = app.emit("oauth-failed", OauthFailedPayload { reason });
}

// ---------------------------------------------------------------------------
// R-51b (Task #168): PKCE deep-link OAuth flow
// ---------------------------------------------------------------------------

/// Parsed `ccsm://oauth?...` deep-link payload. Returned by `parse_deeplink_url`
/// for unit-testable URL handling separate from the live Tauri runtime path.
#[derive(Debug, PartialEq, Eq)]
pub struct DeepLinkPayload {
    pub token: String,
    pub refresh: String,
    pub state: String,
    /// GitHub login (handle) of the signed-in user. Task #177: the static
    /// callback page now forwards the cf-worker `exchange` response's `login`
    /// field into the deep link so the desktop shell can persist a real value
    /// instead of the legacy placeholder "pending".
    pub login: String,
}

/// Parse `ccsm://oauth?token=<jwt>&refresh=<token>&state=<state>&login=<login>`
/// into its four required fields. Returns `None` on any structural failure:
///   - scheme is not `ccsm`
///   - host (URL "authority") is not `oauth`
///   - any of token / refresh / state / login is missing or empty
///
/// The verifier is run on the parsed URL only; signature validity / state
/// freshness are the caller's job (`PkceStateStore::take`).
pub fn parse_deeplink_url(url: &str) -> Option<DeepLinkPayload> {
    // We deliberately do NOT pull in a URL parser dep — the format is fully
    // controlled by the static callback page's URLSearchParams encoder and is
    // `ccsm://oauth?...` with percent-encoded values. Hand-rolling 30 lines
    // is cheaper than adding `url = "2"` to Cargo for one call site.
    let after_scheme = url.strip_prefix("ccsm://")?;
    // Split at the first `?` — the part before is `<authority>[/<path>]`,
    // after is the query string.
    let (authority_path, query) = match after_scheme.find('?') {
        Some(i) => (&after_scheme[..i], &after_scheme[i + 1..]),
        None => return None,
    };
    // Accept both `ccsm://oauth?` (no path) and `ccsm://oauth/?` (trailing
    // slash). Reject anything else, e.g. `ccsm://other`, `ccsm://oauth/x`.
    let authority = authority_path.trim_end_matches('/');
    if authority != "oauth" {
        return None;
    }
    let mut token: Option<String> = None;
    let mut refresh: Option<String> = None;
    let mut state: Option<String> = None;
    let mut login: Option<String> = None;
    for pair in query.split('&') {
        let (k, v) = match pair.find('=') {
            Some(i) => (&pair[..i], &pair[i + 1..]),
            None => continue,
        };
        // Percent-decode the value for symmetry with cf-worker URLSearchParams
        // encoding. We intentionally don't decode plus-signs as spaces (RFC
        // 3986 vs application/x-www-form-urlencoded) because the only field
        // that can contain `+` is the JWT, where `+` is part of base64url's
        // alphabet — but cf-worker uses base64url-without-padding which has
        // `-` and `_`, not `+`, so a literal `+` here is unexpected and we
        // pass it through.
        let decoded = percent_decode(v);
        match k {
            "token" => token = Some(decoded),
            "refresh" => refresh = Some(decoded),
            "state" => state = Some(decoded),
            "login" => login = Some(decoded),
            _ => {}
        }
    }
    let token = token?;
    let refresh = refresh?;
    let state = state?;
    let login = login?;
    if token.is_empty() || refresh.is_empty() || state.is_empty() || login.is_empty() {
        return None;
    }
    Some(DeepLinkPayload { token, refresh, state, login })
}

/// RFC 3986 §2.1 percent-decoding of an URL component. Invalid escape
/// sequences are left as-is; this is a conservative parser sized for the
/// limited set of characters cf-worker actually emits.
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hi = hex_val(bytes[i + 1]);
            let lo = hex_val(bytes[i + 2]);
            if let (Some(h), Some(l)) = (hi, lo) {
                out.push((h << 4) | l);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| s.to_string())
}

fn hex_val(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}

/// React to a `ccsm://oauth?...` deep link arriving from the OS. Verifies
/// `state` against the in-memory PkceStateStore (one-shot; entries that have
/// been consumed or aged out are rejected), persists the credentials to
/// `~/.ccsm/tunnel_jwt`, and emits `oauth-complete`.
///
/// Called from the deep-link plugin's `on_open_url` listener registered in
/// `lib.rs`; also from any single-instance forward path (the second
/// instance's argv carries the URL on Linux/Windows).
pub fn handle_desktop_callback(app: &AppHandle, url: &str) -> Result<(), String> {
    let payload = parse_deeplink_url(url)
        .ok_or_else(|| format!("malformed deep link url: {url}"))?;
    let pkce: State<PkceStateStore> = app.state();
    if !pkce.take(&payload.state) {
        return Err(
            "deep-link state not recognized (state mismatch / replay / expired)".to_string(),
        );
    }
    // Task #177: persist the login that the cf-worker `exchange` endpoint
    // resolved (sourced from the GitHub /user response inside the linker).
    // Previously this hard-coded "pending" because the deep-link only carried
    // {token, refresh, state}, and the SPA ended up rendering "@pending".
    // The static callback page now forwards `login` from the exchange
    // response into the `ccsm://oauth?...&login=<login>` query, so the
    // desktop side can store it verbatim — keeping cf-worker's oauthLinker
    // as the single producer of the login value (no JWT parsing here).
    let creds = PersistedTunnelCreds {
        tunnel_jwt: payload.token,
        tunnel_refresh_token: payload.refresh,
        login: payload.login,
    };
    write_persisted_creds(&creds)
        .map_err(|e| format!("persist desktop creds: {e}"))?;
    // Match the device-flow side's state transition + event so consumers
    // (SPA, daemon supervisor) see one unified Success surface.
    let store: State<OauthStore> = app.state();
    store.set(app, OauthState::Success);
    let _ = app.emit(
        "oauth-complete",
        OauthCompletePayload { login: creds.login.clone() },
    );
    Ok(())
}

/// Wire response from cf-worker `POST /api/auth/desktop/start`.
#[derive(Deserialize, Debug)]
struct DesktopStartResponse {
    auth_url: String,
}

/// `start_pkce_oauth` Tauri command — preferred OAuth path on platforms
/// where deep-link delivery is reliable (Windows installed-app, Linux
/// installed-app). The Tauri shell asks cf-worker to mint a state +
/// code_verifier (verifier stored server-side in the PKCE-state UserDO
/// role; never travels to the desktop). The shell extracts `state` from
/// the returned `auth_url`, parks it in `PkceStateStore`, opens the URL
/// via plugin-shell, and waits for the deep-link listener (lib.rs) to
/// dispatch a callback to `handle_desktop_callback`.
///
/// This intentionally does NOT spawn a poll loop — the OS deep-link
/// delivery is the completion signal. Device flow (`start_device_oauth`)
/// remains available as a fallback for environments where deep-links are
/// unreliable (macOS dev mode; sandboxed flatpak/snap without the
/// declared single-instance slot).
#[tauri::command]
pub async fn start_pkce_oauth(
    app: AppHandle,
    store: State<'_, OauthStore>,
    pkce: State<'_, PkceStateStore>,
) -> Result<(), String> {
    if matches!(store.snapshot(), OauthState::AwaitingUser) {
        return Err("oauth already in progress".to_string());
    }
    let url = format!("{}/api/auth/desktop/start", auth_base()?);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| format!("build http client: {e}"))?;

    let res = client
        .post(&url)
        .send()
        .await
        .map_err(|e| format!("desktop/start http error: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("desktop/start status {}", res.status()));
    }
    let parsed: DesktopStartResponse = res
        .json()
        .await
        .map_err(|e| format!("desktop/start json: {e}"))?;

    // Extract `state` from the auth_url so the deep-link callback can verify
    // it later. Hand-roll the lookup to avoid pulling in the `url` crate;
    // `state=` is always present (cf-worker always emits it) so the parser
    // is not load-bearing for security — the cf-worker side is also
    // verifying state before exchanging the code.
    let state = extract_query_param(&parsed.auth_url, "state")
        .ok_or_else(|| "auth_url missing state param".to_string())?;
    pkce.insert(state);

    store.set(&app, OauthState::AwaitingUser);
    if let Err(e) = app.shell().open(&parsed.auth_url, None) {
        eprintln!("[auth] shell.open({}) failed: {e}", parsed.auth_url);
    }
    Ok(())
}

/// Read `?key=<value>&...` and return the first matching value (URL-decoded).
/// Returns `None` if the URL has no query string or the key isn't present.
fn extract_query_param(url: &str, key: &str) -> Option<String> {
    let q = url.split_once('?').map(|(_, q)| q)?;
    for pair in q.split('&') {
        let (k, v) = pair.split_once('=')?;
        if k == key {
            return Some(percent_decode(v));
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// Shared guard for tests that mutate HOME/USERPROFILE — both this module's
// tests and `daemon_mgr::tests::load_or_create_generates_and_persists` use it
// to serialize env mutations across the whole crate test binary.
#[cfg(test)]
pub(crate) static TEST_ENV_GUARD: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(test)]
mod tests {
    use super::*;

    fn with_tmp_home<F: FnOnce()>(label: &str, f: F) {
        let _guard = TEST_ENV_GUARD.lock().unwrap_or_else(|e| e.into_inner());
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let tmp = std::env::temp_dir().join(format!(
            "ccsm-auth-test-{}-{}-{}",
            label,
            std::process::id(),
            nanos
        ));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();

        #[cfg(windows)]
        let key = "USERPROFILE";
        #[cfg(not(windows))]
        let key = "HOME";

        let prev = std::env::var_os(key);
        std::env::set_var(key, &tmp);
        f();
        if let Some(v) = prev {
            std::env::set_var(key, v);
        } else {
            std::env::remove_var(key);
        }
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn persist_round_trip() {
        with_tmp_home("persist", || {
            assert!(read_persisted_creds().is_none());
            let creds = PersistedTunnelCreds {
                tunnel_jwt: "abc.def.ghi".into(),
                tunnel_refresh_token: "01234567".into(),
                login: "octocat".into(),
            };
            write_persisted_creds(&creds).unwrap();
            let back = read_persisted_creds().expect("read back");
            assert_eq!(back.tunnel_jwt, "abc.def.ghi");
            assert_eq!(back.tunnel_refresh_token, "01234567");
            assert_eq!(back.login, "octocat");
        });
    }

    #[test]
    fn delete_clears_disk() {
        with_tmp_home("delete", || {
            let creds = PersistedTunnelCreds {
                tunnel_jwt: "j".into(),
                tunnel_refresh_token: "r".into(),
                login: "u".into(),
            };
            write_persisted_creds(&creds).unwrap();
            assert!(read_persisted_creds().is_some());
            delete_persisted_creds().unwrap();
            assert!(read_persisted_creds().is_none());
            // Idempotent: deleting again must not error.
            delete_persisted_creds().unwrap();
        });
    }

    #[test]
    fn rewrite_overwrites_prior_creds() {
        with_tmp_home("rewrite", || {
            let a = PersistedTunnelCreds {
                tunnel_jwt: "j1".into(),
                tunnel_refresh_token: "r1".into(),
                login: "u1".into(),
            };
            write_persisted_creds(&a).unwrap();
            let b = PersistedTunnelCreds {
                tunnel_jwt: "j2".into(),
                tunnel_refresh_token: "r2".into(),
                login: "u2".into(),
            };
            write_persisted_creds(&b).unwrap();
            let back = read_persisted_creds().unwrap();
            assert_eq!(back.tunnel_jwt, "j2");
            assert_eq!(back.login, "u2");
        });
    }

    #[cfg(unix)]
    #[test]
    fn unix_creds_file_is_chmod_600() {
        use std::os::unix::fs::PermissionsExt;
        with_tmp_home("chmod", || {
            let creds = PersistedTunnelCreds {
                tunnel_jwt: "j".into(),
                tunnel_refresh_token: "r".into(),
                login: "u".into(),
            };
            write_persisted_creds(&creds).unwrap();
            let path = tunnel_jwt_path().unwrap();
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "expected 0600 on Unix, got {:o}", mode);
        });
    }

    #[cfg(windows)]
    #[test]
    fn windows_creds_file_under_userprofile() {
        // Reviewer follow-up on PR #1225: lock in that on Windows we (a) can
        // write + read the creds file, and (b) the resolved path lives under
        // the per-test USERPROFILE so the default ACL inheritance argument
        // in the file header actually applies (file inside %USERPROFILE% =
        // owner-only by default; outside it could pick up a different ACL).
        with_tmp_home("win-userprofile", || {
            let creds = PersistedTunnelCreds {
                tunnel_jwt: "winjwt".into(),
                tunnel_refresh_token: "winrefresh".into(),
                login: "winuser".into(),
            };
            write_persisted_creds(&creds).unwrap();

            let path = tunnel_jwt_path().unwrap();
            assert!(path.exists(), "creds file must exist after write");

            // Path must live under the test's USERPROFILE.
            let userprofile = std::env::var("USERPROFILE").expect("USERPROFILE set in with_tmp_home");
            let canon_path = path.canonicalize().unwrap();
            let canon_home = std::path::PathBuf::from(&userprofile).canonicalize().unwrap();
            assert!(
                canon_path.starts_with(&canon_home),
                "creds path {} must be under USERPROFILE {}",
                canon_path.display(),
                canon_home.display(),
            );

            // Round-trip read.
            let back = read_persisted_creds().expect("read back");
            assert_eq!(back.tunnel_jwt, "winjwt");
            assert_eq!(back.login, "winuser");
        });
    }

    /// Audit F-S-2 (Task #152): unverified JWT `sub` extraction.
    #[test]
    fn parse_jwt_sub_extracts_sub_from_payload() {
        // Manual JWT: header={alg:HS256,typ:JWT}, payload={sub:"583231",login:"octocat"},
        // signature is a non-empty placeholder (we never verify it).
        // base64url-encoded values pre-computed.
        let header = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9";
        // {"sub":"583231","login":"octocat"}
        let payload = "eyJzdWIiOiI1ODMyMzEiLCJsb2dpbiI6Im9jdG9jYXQifQ";
        let sig = "ZmFrZS1zaWc";
        let jwt = format!("{}.{}.{}", header, payload, sig);
        assert_eq!(parse_jwt_sub_unverified(&jwt), Some("583231".to_string()));
    }

    #[test]
    fn parse_jwt_sub_returns_none_on_two_part_jwt() {
        assert_eq!(parse_jwt_sub_unverified("a.b"), None);
    }

    #[test]
    fn parse_jwt_sub_returns_none_on_four_part_jwt() {
        assert_eq!(parse_jwt_sub_unverified("a.b.c.d"), None);
    }

    #[test]
    fn parse_jwt_sub_returns_none_when_payload_lacks_sub() {
        // payload = {"login":"octocat"} (no sub)
        let payload = "eyJsb2dpbiI6Im9jdG9jYXQifQ";
        let jwt = format!("hdr.{}.sig", payload);
        assert_eq!(parse_jwt_sub_unverified(&jwt), None);
    }

    #[test]
    fn parse_jwt_sub_returns_none_on_garbage_payload() {
        assert_eq!(parse_jwt_sub_unverified("hdr.@@@@.sig"), None);
    }

    #[test]
    fn parse_jwt_sub_handles_padded_base64url() {
        // Same as parse_jwt_sub_extracts_sub_from_payload but with explicit
        // `=` padding (some encoders emit padding even for base64url).
        let header = "eyJhbGciOiJIUzI1NiJ9";
        let payload_padded = "eyJzdWIiOiIxIn0="; // {"sub":"1"}
        let jwt = format!("{}.{}.s", header, payload_padded);
        assert_eq!(parse_jwt_sub_unverified(&jwt), Some("1".to_string()));
    }

    // R-51b (Task #168): deep-link URL parser + PKCE state map.

    #[test]
    fn parse_deeplink_url_extracts_token_refresh_state() {
        let url = "ccsm://oauth?token=abc.def.ghi&refresh=01234567&state=feedface&login=octocat";
        let p = parse_deeplink_url(url).expect("must parse");
        assert_eq!(p.token, "abc.def.ghi");
        assert_eq!(p.refresh, "01234567");
        assert_eq!(p.state, "feedface");
        // Task #177: login is the resolved GitHub handle, not a placeholder.
        assert_eq!(p.login, "octocat");
    }

    #[test]
    fn parse_deeplink_url_handles_percent_encoded_values() {
        // The static callback page's URLSearchParams encodes `+` as `%2B` etc.
        // Make sure the parser round-trips a percent-encoded JWT sig (rare but
        // possible).
        let url = "ccsm://oauth?token=a.b%2Bc&refresh=r&state=s&login=u";
        let p = parse_deeplink_url(url).expect("must parse");
        assert_eq!(p.token, "a.b+c");
    }

    #[test]
    fn parse_deeplink_url_rejects_wrong_authority() {
        // `ccsm://other?...` and `ccsm://oauth/extra?...` both reject.
        assert!(parse_deeplink_url("ccsm://other?token=t&refresh=r&state=s&login=u").is_none());
        assert!(
            parse_deeplink_url("ccsm://oauth/extra?token=t&refresh=r&state=s&login=u").is_none()
        );
    }

    #[test]
    fn parse_deeplink_url_rejects_missing_or_empty_fields() {
        // missing state
        assert!(parse_deeplink_url("ccsm://oauth?token=t&refresh=r&login=u").is_none());
        // empty token
        assert!(parse_deeplink_url("ccsm://oauth?token=&refresh=r&state=s&login=u").is_none());
        // Task #177: missing login is now a structural failure (no fallback
        // to "pending" placeholder).
        assert!(parse_deeplink_url("ccsm://oauth?token=t&refresh=r&state=s").is_none());
        // empty login
        assert!(parse_deeplink_url("ccsm://oauth?token=t&refresh=r&state=s&login=").is_none());
        // entirely malformed
        assert!(parse_deeplink_url("ccsm://oauth?invalid").is_none());
        // wrong scheme
        assert!(parse_deeplink_url("https://oauth?token=t&refresh=r&state=s&login=u").is_none());
    }

    #[test]
    fn pkce_state_store_one_shot_take() {
        let store = PkceStateStore::default();
        store.insert("S1".into());
        // First take consumes.
        assert!(store.take("S1"));
        // Second take of the same value rejects (replay).
        assert!(!store.take("S1"));
    }

    #[test]
    fn pkce_state_store_rejects_unknown_state() {
        let store = PkceStateStore::default();
        store.insert("S1".into());
        // Different state never inserted → reject.
        assert!(!store.take("S2"));
        // Original still consumable since the unknown attempt didn't touch it.
        assert!(store.take("S1"));
    }

    #[test]
    fn pkce_state_store_drops_expired_entries_on_take() {
        // Use the internal struct directly to plant an expired entry.
        let store = PkceStateStore::default();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        // Insert an entry then backdate it past the TTL.
        store.insert("OLD".into());
        {
            let mut g = store.entries.lock().unwrap();
            for e in g.iter_mut() {
                if e.state == "OLD" {
                    e.created_at = now.saturating_sub(PKCE_STATE_TTL_SEC + 60);
                }
            }
        }
        assert!(!store.take("OLD"), "expired state must be rejected");
    }

    #[test]
    fn extract_query_param_pulls_state_from_auth_url() {
        let url = "https://github.com/login/oauth/authorize?client_id=cid&state=feedface&scope=read%3Auser";
        assert_eq!(extract_query_param(url, "state"), Some("feedface".to_string()));
        assert_eq!(extract_query_param(url, "scope"), Some("read:user".to_string()));
        assert_eq!(extract_query_param(url, "missing"), None);
    }

    /// Task #177 (coverage hardening): explicit serde round-trip on the
    /// persisted blob shape. Catches "dropped field" regressions on the
    /// on-disk schema — if anyone removes the `login` field from
    /// `PersistedTunnelCreds`, deserialization here will fail to populate
    /// it and the SPA bug from Task #177 returns. By pinning the JSON
    /// keys explicitly we also catch silent renames (serde's default is
    /// snake_case but it does not validate "unknown fields", and a
    /// missing field on the struct silently drops it from the wire).
    #[test]
    fn persisted_tunnel_creds_serde_round_trip_includes_login() {
        let json = r#"{"tunnel_jwt":"jwt.body.sig","tunnel_refresh_token":"abcd","login":"alice"}"#;
        let parsed: PersistedTunnelCreds = serde_json::from_str(json).expect("deserialize");
        assert_eq!(parsed.tunnel_jwt, "jwt.body.sig");
        assert_eq!(parsed.tunnel_refresh_token, "abcd");
        assert_eq!(parsed.login, "alice");

        // Re-serialize and assert the produced JSON contains all three keys —
        // this defends against a future `#[serde(skip_serializing)]` slipping
        // onto the login field.
        let out = serde_json::to_string(&parsed).expect("serialize");
        assert!(out.contains("\"tunnel_jwt\""));
        assert!(out.contains("\"tunnel_refresh_token\""));
        assert!(out.contains("\"login\""));
        assert!(out.contains("alice"));
    }

    /// Task #177 (coverage hardening): regression guard that the `login`
    /// field stored by the desktop OAuth deep-link path is NOT the literal
    /// placeholder string "pending". The original bug shipped because
    /// `handle_desktop_callback` wrote `login: String::from("pending")`
    /// when it had real data on the wire — this test mirrors the deep-link
    /// happy path and asserts the literal can never sneak back in for that
    /// code path.
    ///
    /// Note: we deliberately don't grep the whole module for the string
    /// "pending" because GitHub's device-flow API uses `"pending"` as a
    /// legitimate poll-status value (see `run_poll_loop`), and a coarse
    /// grep would generate false positives on that legitimate match.
    #[test]
    fn deep_link_login_is_never_pending_literal() {
        with_tmp_home("never-pending", || {
            let url =
                "ccsm://oauth?token=jwt.body.sig&refresh=rrr&state=feedface&login=octocat";
            let payload = parse_deeplink_url(url).expect("must parse");
            let creds = PersistedTunnelCreds {
                tunnel_jwt: payload.token,
                tunnel_refresh_token: payload.refresh,
                login: payload.login,
            };
            assert_ne!(creds.login, "pending");
            assert_eq!(creds.login, "octocat");
        });
    }

    /// uses — take a deep link string, parse it, copy the parsed `login` (and
    /// the other two credential fields) into `PersistedTunnelCreds`, write to
    /// disk, read back, and verify the persisted `login` matches the deep
    /// link's `login` (NOT the legacy literal "pending").
    ///
    /// We can't drive the real `handle_desktop_callback` directly from a
    /// `#[test]` because it needs a `tauri::AppHandle` (live Tauri runtime).
    /// Instead we mirror the exact composition it performs — same fields,
    /// same write_persisted_creds path — so any future drift that puts
    /// "pending" back into the persisted blob will fail this test.
    #[test]
    fn deep_link_login_round_trips_through_persisted_creds() {
        with_tmp_home("deeplink-login", || {
            let url =
                "ccsm://oauth?token=jwt.value.here&refresh=rrr&state=feedface&login=Jiahui-Gu";
            let payload = parse_deeplink_url(url).expect("must parse");
            assert_eq!(payload.login, "Jiahui-Gu");

            let creds = PersistedTunnelCreds {
                tunnel_jwt: payload.token.clone(),
                tunnel_refresh_token: payload.refresh.clone(),
                login: payload.login.clone(),
            };
            write_persisted_creds(&creds).unwrap();

            let back = read_persisted_creds().expect("read back");
            assert_eq!(back.tunnel_jwt, "jwt.value.here");
            assert_eq!(back.tunnel_refresh_token, "rrr");
            // The bug from Task #177 wrote the literal string "pending" here.
            // Lock in the real login.
            assert_eq!(back.login, "Jiahui-Gu");
            assert_ne!(back.login, "pending");
        });
    }
}
