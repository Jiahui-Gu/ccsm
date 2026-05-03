// TODO(wave0d.4 #251): remove when electron/ptyHost/* migrates to daemon
// (last out-of-zone consumer is electron/ptyHost/jsonlResolver.ts).
//
// Re-export shim — real implementation lives in
// packages/daemon/src/sessionWatcher/projectKey.ts.
export * from '../../packages/daemon/src/sessionWatcher/projectKey';
