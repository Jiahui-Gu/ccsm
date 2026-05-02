# R5 review — 10-build-package-installer.md

## P0

### P0-10-1. macOS notarization with hardened runtime + JIT entitlement — gate on the spike
§3 + spike [macos-notarization-sea] (chapter 14 §1.13) — the **expected** result is "rejected" because Apple has tightened JIT entitlement issuance. **Spike fallback** is "revert to a notarized .app bundle wrapping non-sea node + bundle.js + node_modules/" — which is a fundamentally different artifact shape. Then chapter 10 §1's "single binary per OS" claim is conditional on macOS notarization passing, but no chapter explicitly states the conditional. Phase 10 acceptance is "code signing + notarization in CI green" — implies the fallback path may need to land in v0.3.

**P0** because if the fallback triggers, chapter 10 §1, §2, §6 all need different content for macOS. Either:
- (a) Pre-resolve the spike before stage-6 DAG extraction (it's gating).
- (b) Have chapter 10 ship both code paths and pick at install time.

Phase ordering in chapter 13 doesn't sequence the spike before phase 10.

## P1

### P1-10-1. WiX 4 vs electron-builder MSI builder — "MUST-SPIKE"
§5.1 says "pick by which is more reliable for service registration — MUST-SPIKE" but does not register a named spike id. Chapter 14 has [msi-service-install-25h2] which only validates `<ServiceInstall>` element works on 25H2 — does not compare WiX 4 standalone vs electron-builder. Add a separate spike `[msi-tooling-pick]` or merge into 14 §1.14 explicitly. Currently a downstream worker reading 14 sees only one MSI spike.

### P1-10-2. `node-windows` mention in chapter 02 §2.1 vs WiX in chapter 10 §5.1
Chapter 02 §2.1: "Registration tool: `node-windows` OR direct `sc.exe create` from the installer (brief §9). MUST-SPIKE: `node-windows` is unmaintained for Node 22 sea bundles; `sc.exe` from MSI custom action is the lower-risk fallback."

Chapter 10 §5.1: "Service registration: WiX `<ServiceInstall>` element (NOT a `sc.exe` custom action — declarative is cleaner for uninstall)."

**Three options listed across two chapters**: `node-windows`, `sc.exe`, WiX `<ServiceInstall>`. Chapter 02 prefers `sc.exe`; chapter 10 picks WiX `<ServiceInstall>`. P1 contradiction — pick one and align both chapters.

### P1-10-3. CI build matrix — `e2e-installer-vm` mac/linux variants
§6 lists `e2e-win-installer-vm` only. Chapter 12 §4.4 says "Mac/linux equivalents (`installer-roundtrip.sh`) written in parallel but ship-gate (d) is specifically Win per brief §11(d)." But the matrix here doesn't list mac/linux installer e2e jobs. Either add them OR explicitly state "v0.3: only win e2e installer in CI; mac/linux smoke tested manually pre-tag".

### P1-10-4. Vague verbs
- §1 "appropriate" appears in `codesign / signtool / debsign as appropriate` — vague but the per-OS table in §3 enumerates each. Cross-ref or remove "as appropriate".
- §2 "Cross-compile native modules in CI using `prebuildify` or vendor's prebuilt artifacts when available" — "when available" undefined trigger. Pin per-module.

### P1-10-5. NSIS vs MSI — picked MSI
"v0.3 ships MSI as primary" — but does NSIS ever ship? §4 says "we pick MSI ... NSIS is fine for non-managed". Drop NSIS mention to avoid implying dual-output, OR declare NSIS as a side-output for non-enterprise.

### P1-10-6. macOS `.app` bundle wrapping fallback
§3 fallback for sea notarization is ".app bundle wrapping non-sea node + bundle.js + node_modules/". This means the daemon binary on macOS may not be `ccsm-daemon` (a sea binary) but a `.app` bundle. Chapter 02 §2.2 hardcodes `binary in /Library/Application Support/ccsm/ccsm-daemon`. If fallback fires, location and shape change. Document the cascade.

## Scalability hotspots
(N/A — installer chapter)

## Markdown hygiene
- §3 / §5 / §6 tables OK.
- §5.x sub-headings use `####` under `###` ✓.
- Code blocks tagged.
