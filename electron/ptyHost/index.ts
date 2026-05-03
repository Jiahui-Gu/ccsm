// TODO(v0.4): remove when out-of-zone consumers (electron/main.ts,
// electron/notify/bootstrap/installPipeline.ts, electron/notify/sinks/
// pipeline.ts, electron/testHooks.ts) migrate to @ccsm/daemon imports
// directly.
//
// Re-export shim — real implementation lives in
// packages/daemon/src/ptyHost/index.ts (moved Wave 0d.4 / #251).
export * from '../../packages/daemon/src/ptyHost/index';
