// @ccsm/daemon supervisor subsystem — UDS-only HTTP control plane.
//
// Spec refs:
//   - ch02 §2 supervisor address per OS.
//   - ch02 §3 startup ordering (`/healthz` 200 only at READY).
//   - ch02 §4 shutdown contract (≤5s grace + 3s SIGKILL).
//   - ch03 §7 endpoints (`/healthz`, `/hello`, `/shutdown`).
//   - ch03 §7.1 peer-cred admin allowlist (sole authn).
//   - ch03 §7.2 security rationale (UDS-only forever; no JWT path).
//   - ch15 §3 forbidden-pattern #9 + #16 + audit row table.
//
// Public surface (consumed by the daemon entrypoint in T1.1 / T1.8):
//   - `makeSupervisorServer(config) → SupervisorServer` — start/stop the
//     UDS listener; serves `/healthz` (anyone), `/hello` + `/shutdown`
//     (admin-only via peer-cred).
//   - `SUPERVISOR_URLS` / `SUPERVISOR_METHODS` — locked URL/method
//     constants (mirrored by `test/supervisor/contract.spec.ts`).
//   - `defaultAdminAllowlist(...)` — per-OS allowlist factory.
//   - `isAllowed(...)` — pure decider for `/hello` + `/shutdown` gating.

export {
  makeSupervisorServer,
  SUPERVISOR_URLS,
  SUPERVISOR_METHODS,
  type SupervisorConfig,
  type SupervisorServer,
  type HealthzBody,
  type HelloBody,
  type ShutdownBody,
  type RejectedBody,
} from './server.js';
export {
  defaultAdminAllowlist,
  isAllowed,
  SID_BUILTIN_ADMINISTRATORS,
  SID_LOCAL_SERVICE,
  type AdminAllowlist,
} from './admin-allowlist.js';
