// Cross-tree shim — W2-B (Task #581).
//
// `electron/ptyHost/` was moved to `daemon/ptyHost/` so the daemon owns the
// node-pty processes. Existing electron-side callers
// (`electron/notify/bootstrap/installPipeline.ts`,
//  `electron/notify/sinks/pipeline.ts`) still import from
// `electron/ptyHost`. Until W2-C lifts the notify pipeline into the daemon,
// we keep this thin re-export so the typecheck graph stays compilable
// without touching the W2-C-owned notify files.
//
// IMPORTANT: at runtime the notify pipeline is currently dead code (wave-1
// removed its boot from `electron/main.ts`; only its tests still exercise
// it). Even if a future caller does `onPtyData` from the Electron process,
// the listener Set lives in *that* process — it will never observe chunks
// emitted by the daemon's ptyHost in the daemon process. Resurrecting
// notify in W2-C will require subscribing to the SSE stream
// (`/api/events/pty?sid=*`) instead.

export {
  onPtyData,
  onPtyChunk,
  onPtyExit,
  type PtyDataListener,
  type PtyChunkListener,
  type PtyExitListener,
} from '../../daemon/ptyHost';
