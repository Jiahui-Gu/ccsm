# tools/spike-harness/

Shared scripts referenced by the v0.3 spike repro recipes in
`docs/superpowers/specs/2026-05-03-v03-daemon-split-design.md` chapter 14
§1.1-§1.16. Pinned by chapter 14 §1.B.

## Forever-stable contract

Per spec ch14 §1.B, every script in this directory has a **forever-stable
contract** (input args + output format). v0.4 spikes may **add** new scripts
but MUST NOT remove or change the contract of an existing script. Each
script's header comment documents its contract; that header is the spec.

Cross-link: chapter 11 §2 / §6 pins this path; chapter 12 §3 reuses
`install-residue-diff.{sh,ps1}` for ship-gate (d).

## Layer 1 constraints

- `node:` standard library only — no npm deps for things stdlib already does.
- System shells (bash, PowerShell) for OS glue.
- Stub bodies are acceptable; the **contract** (args + output) is what the
  downstream T9.1-T9.14 spikes lock against.

## Inventory

| Script                           | Used by spike     | Status                              |
| -------------------------------- | ----------------- | ----------------------------------- |
| `wrap-as-localservice.ps1`       | §1.1              | runnable (sc.exe wrapper)           |
| `set-pipe-dacl.ps1`              | §1.1              | runnable (P/Invoke SetSecurityInfo on pipe handle; T9.1) |
| `connect-and-peercred.sh`        | §1.1, §1.4, §1.5  | runnable (UDS getsockopt)           |
| `connect-and-peercred.ps1`       | §1.1, §1.4, §1.5  | runnable (P/Invoke GetNamedPipe{Server,Client}ProcessId + token SID; T9.1) |
| `pty-emitter.mjs`                | §1.7              | stub (TODO: node-pty when T9.7)     |
| `delta-collector.mjs`            | §1.7              | runnable (NDJSON tail + seq check)  |
| `vt-grammar.mjs`                 | §1.8              | runnable (weighted CSI/OSC/DCS gen) |
| `snapshot-roundtrip.spec.ts`     | §1.8              | describe.skip until T4.6 codec      |
| `sea-hello/index.mjs`            | §1.10, §1.13      | runnable (TCP echo + port file)     |
| `entitlements-jit.plist`         | §1.13             | runnable (codesign input)           |
| `install-residue-diff.sh`        | §1.16             | stub (TODO: tree+stat diff)         |
| `install-residue-diff.ps1`       | §1.16             | stub (TODO: Get-ChildItem + reg diff) |
| `rtt-histogram.mjs`              | §1.3, §1.4, §1.5  | runnable (JSONL → p50/p95/p99)      |
| `stream-truncation-detector.mjs` | §1.3, §1.4, §1.5  | runnable (seq-gap detector)         |
| `probes/uds-h2c/{server,client}.mjs` | §1.4 (T9.4)   | runnable on darwin/linux; win32 skip |
| `probes/uds-h2c/run.sh`          | §1.4 (T9.4)       | smoke (60s) + 1h soak driver        |
| `probes/win-h2-named-pipe/{server,client}.mjs` | §1.5 (T9.5) | runnable on win32; non-win32 skip |
| `probes/win-h2-named-pipe/run.sh` | §1.5 (T9.5)      | smoke (60s) + 1h soak driver        |
| `probes/macos-notarization-sea/notarize.sh` | §1.13 (T9.12) | gated on Apple Dev ID cert (ops prereq) |
| `probes/macos-notarization-sea/Info.plist`  | §1.13 (T9.12) | sample bundle metadata for Mach-O notarization |
| `probes/better-sqlite3-22-arm64/probe.mjs` | §1.12 (T9.11) | runnable (GitHub manifest check + opt. live load) |
| `probes/snapshot-roundtrip-fidelity/probe.mjs` | §1.8 phase 4.5 (T9.7) | runnable (reference codec + corpus + canonical cross-check) |
| `probes/loopback-h2c-on-25h2/{server,client}.mjs` | §1.3 (T9.3) | runnable on win32; non-win32 skip |
| `probes/loopback-h2c-on-25h2/run.sh` | §1.3 (T9.3)   | smoke (60s) + 1h soak driver (Win 11 25H2) |
| `probes/macos-uds-cross-user/{server,client}.mjs` | §1.2 (T9.2) | runnable on darwin; linux/win32 skip |
| `probes/macos-uds-cross-user/run.sh` | §1.2 (T9.2)   | bind-path × cross-user matrix driver |
| `probes/win-localservice-uds/{server,client}.mjs` | §1.1 (T9.1) | runnable on win32; non-win32 skip |
| `probes/win-localservice-uds/probe.ps1` | §1.1 (T9.1) | same-user (no admin) + localservice (admin) modes |
