# R2 (Security) review — 10-build-package-installer

## P0

### P0-10-1 — No update / in-place replacement flow specified; service-running binary swap is undefined

Spec covers install (§5) and uninstall (§5), but **never** updates. Once v0.3 ships, every patch release runs the daemon as a system service — the installer must:
1. Stop the running service (graceful, with timeout + SIGKILL fallback).
2. Replace `ccsm-daemon(.exe)` and `native/*.node`.
3. Restart.

Hazards omitted from the spec:
- **Race during step 1→2**: if user re-launches Electron mid-update, it connects to the now-stopped daemon, gets `UNAVAILABLE`, retries — fine if the new daemon is up by then; not fine if the upgrade fails halfway and the old binary is gone.
- **Pinned file handle on Windows**: `ccsm-daemon.exe` running prevents replacement; spec must specify "stop, wait for handle release, replace, start" or use MSI's reboot-pending file replacement.
- **Native module ABI mismatch**: if Node 22 ABI changes between releases, partial replacement (new daemon, old `.node`) crashes on first SQLite open. Atomic replacement via stage-and-rename mandatory.
- **Downgrade rollback**: if new daemon fails `/healthz` check after restart, installer should restore old binary; spec doesn't define rollback.

This is a P0 because every patch release is a live-system change that, done wrong, leaves users with a broken daemon at boot — and an attacker who can race the update can swap binaries.

### P0-10-2 — Code-signing covers binaries but installer-time integrity verification of the daemon binary is unspecified

§3 lists signing for outputs. §5 install steps do NOT include "verify daemon binary signature before service-registering it". An attacker who can write to the staging dir between unpacking the MSI and `ServiceInstall` swaps `ccsm-daemon.exe` and gets it registered (and run on every boot) as LocalService. Spec must:
- Mandate post-extract pre-register signature verification (Windows: `WinVerifyTrust`; macOS: `codesign --verify --deep --strict`; Linux: `gpg --verify` on the .deb/.rpm signature, OR rely on apt/dnf's chain).
- Cover the same for `native/*.node` files.

## P1

### P1-10-1 — Install-time ACL on `%ProgramData%\ccsm\` grants "interactive user Read on the listener descriptor file" — single-user concept on multi-user machine

§5.1: "grant interactive user Read on the listener descriptor file". On a Windows machine with multiple interactive users (RDP / fast user switching), "the interactive user" at install time is one specific user; subsequent users get no read. Either:
- Grant `BUILTIN\Users` Read on the descriptor file (every user can read), and rely on per-pipe DACL for actual auth.
- Or per-user descriptor file path under `%LOCALAPPDATA%\ccsm\` written at first connection by the daemon (peer-cred-derived).

Spec should specify which, and reconcile with ch 03 §3 which lists both `%LOCALAPPDATA%` and `%PROGRAMDATA%` as alternatives without committing.

### P1-10-2 — `pkgbuild` postinstall runs as root with no integrity check of the postinstall script's contents at runtime

§5.2: postinstall does `launchctl bootstrap ... kickstart -k`. Standard, but spec must mandate the postinstall script is itself signed (it is, as part of the .pkg signature) AND that the kickstart command does not pass user-controlled args. Currently the script is fixed; document that it MUST remain fixed (no template substitution from user input).

### P1-10-3 — Linux postinst `useradd ccsm` does not pin uid range or shell

§5.3: "Postinst: create `ccsm` user". If the installer doesn't specify `useradd --system --shell /usr/sbin/nologin`, the user gets a login shell and a high uid. A login-capable system user is a credential surface. Spec: pin `--system --no-create-home --shell /usr/sbin/nologin --user-group`.

### P1-10-4 — Native `.node` files in `native/` directory ACL not specified

§2 layout. If `native/better_sqlite3.node` is writable by the interactive user (sloppy MSI ACL), attacker swaps the .node and the next daemon start loads attacker code as LocalService. Spec must specify NTFS / POSIX ACLs on `native/` matching the binary itself.

## P2

### P2-10-1 — Notarization of a sea binary uses `com.apple.security.cs.allow-jit` entitlement (ch 14 §1.13)

`allow-jit` lets the daemon allocate W+X memory pages. Combined with running as `_ccsm` and access to user data via SQLite, the JIT entitlement increases blast radius of any V8 RCE. Spec should evaluate whether `disable-library-validation` is needed for the `.node` loads — if so, this further weakens hardened-runtime guarantees and should be called out as a residual risk in ch 14.

### P2-10-2 — `debsigs` for .deb is not the standard repository-signing path

§3. Most users install via apt from a repo whose `Release` file is signed. `debsigs` is per-package and rarely verified by end users. If we ship our own apt repo, the Release-signing model is what matters; standalone .deb signed with `debsigs` is verified only via `debsig-verify` which most users don't run. Document the actual distribution channel.

### P2-10-3 — `e2e-installer-vm` job uses self-hosted Win 11 25H2 runner (ch 11 §6)

A self-hosted runner that runs untrusted PR code is a CI security concern; PRs from forks should not be allowed to schedule on it (default GitHub behaviour OK if `pull_request_target` is not used). Spec should pin the workflow trigger model to prevent accidental exposure.
