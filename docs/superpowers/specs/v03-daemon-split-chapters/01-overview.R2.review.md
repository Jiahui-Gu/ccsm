# R2 (Security) review — 01-overview

## P2

### P2-01-1 — "every Electron → daemon call uses Connect-RPC over Listener A; **zero** `ipcMain` / `contextBridge` / `ipcRenderer`"

The §1 goal as written replaces a same-process IPC trust boundary with a network trust boundary. Same-process IPC is *implicitly* peer-cred (the renderer is the same Electron app). Listener A is *explicitly* peer-cred but as ch 03 / ch 08 reviews show, the explicit form has DNS-rebinding, PID-recycling, and bridge-attack-surface holes the implicit form did not. The overview chapter should at minimum acknowledge that "Listener A's auth surface is broader than IPC's was" so reviewers on later chapters expect it.

### P2-01-2 — v0.4 delta summary §7 lists `cf-access:<sub>` principal addition as "Handler code: unchanged"

True for the principal-string-compare path, but the v0.3 design choices that this guarantees (RPC-only ownership filter — see ch 05 R2 P0-05-1) ALSO carry forward, including their security weaknesses. Overview should flag that the additivity guarantee covers *correctness*, not *security* — an additive v0.4 may inherit and amplify v0.3 security gaps.

No P0/P1 findings; chapter is a roadmap.
