// Public surface for the Principal model. Keep this file as a flat re-export
// so consumers do `import { Principal, principalKey, assertOwnership } from
// '@ccsm/daemon/principal'` without learning the internal file layout.

export {
  PermissionDenied,
  assertOwnership,
  makePrincipal,
  principalKey,
} from './principal.js';
export type { Principal, PrincipalKind } from './principal.js';
