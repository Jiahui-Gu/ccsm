// TODO(wave0d.3 #249 / wave0d.4 #251): remove when electron/prefs/* and
// electron/ptyHost/* migrate to daemon (last out-of-zone consumers of
// `sessionWatcher` — see PR for Task #250 §Shims).
//
// Re-export shim — real implementation lives in
// packages/daemon/src/sessionWatcher/index.ts.
export * from '../../packages/daemon/src/sessionWatcher/index';
