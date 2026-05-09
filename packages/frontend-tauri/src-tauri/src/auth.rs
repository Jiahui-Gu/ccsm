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
pub async fn start_oauth(
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
}
