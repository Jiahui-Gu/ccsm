// @ccsm/proto — public surface for v0.3 Connect-RPC bindings.
//
// This re-exports the generated TypeScript bindings under
// `gen/ts/ccsm/v1/*_pb.ts` so consumers can write:
//
//   import { SessionService } from '@ccsm/proto';
//
// Connect-ES v2 derives both the client (`createClient(SessionService, transport)`)
// and the server (`router.service(SessionService, impl)`) from the same
// `GenService` descriptor — there is no separate `protoc-gen-connect-es`
// generator. See specs/2026-05-03-v03-daemon-split-design.md ch04 §1.
//
// `gen/ts/` is gitignored (regenerated via `pnpm --filter @ccsm/proto run gen`,
// CI-gated by T0.8). All seven v0.3 services are re-exported here. The
// `common.proto` file declares no service — only shared types/enums.
//
// Wildcard re-exports keep this surface minimal and self-updating: any
// new message / enum / service added to a `.proto` file becomes available
// at `@ccsm/proto` after `pnpm gen`, with no edits required here.

// Common shared types (no service): Principal, LocalUser, RequestMeta,
// ErrorDetail, SessionState enum, ...
export * from '../gen/ts/ccsm/v1/common_pb.js';

// Service modules — each exports a `*Service: GenService<...>` descriptor
// alongside its request/response message types.
export * from '../gen/ts/ccsm/v1/session_pb.js';
export * from '../gen/ts/ccsm/v1/pty_pb.js';
export * from '../gen/ts/ccsm/v1/crash_pb.js';
export * from '../gen/ts/ccsm/v1/settings_pb.js';
export * from '../gen/ts/ccsm/v1/notify_pb.js';
export * from '../gen/ts/ccsm/v1/draft_pb.js';
export * from '../gen/ts/ccsm/v1/supervisor_pb.js';
