// Hand-written barrel for `@ccsm/proto-gen/v1`.
//
// Re-exports the 8 + 3 domain proto stubs + the umbrella `CcsmService`. Pure
// `export *` (named-only) so bundlers (Vite/Rollup/webpack with sideEffects)
// can tree-shake unused stubs out of the production bundle.
//
// IMPORTANT: this file is hand-written and MUST NOT be deleted by
// `buf generate`. The buf toolchain (`protoc-gen-es`) only emits files
// matching `*_pb.ts`, so this `index.ts` is safe alongside the generated
// output. The `.gitattributes` rule excludes this file from
// `linguist-generated` so GitHub still shows diffs on review.
//
// No runtime side-effects. No default export. No re-export of side-effecting
// modules. Every consumer either imports a named symbol (tree-shakeable) or
// imports the entire namespace (not tree-shakeable, by design).

export * from "./common_pb";
export * from "./core_pb";
export * from "./import_pb";
export * from "./notify_pb";
export * from "./pty_pb";
export * from "./session_pb";
export * from "./session_events_pb";
export * from "./session_titles_pb";
export * from "./sessions_pb";
export * from "./settings_pb";
export * from "./updater_pb";
export * from "./service_pb";
