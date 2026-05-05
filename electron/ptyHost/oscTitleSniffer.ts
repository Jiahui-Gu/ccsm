// Cross-tree shim — W2-B (Task #581). See `./index.ts` rationale.
//
// `electron/notify/sinks/pipeline.ts` imports `OscTitleSniffer` from this
// path. The real implementation moved to `daemon/ptyHost/oscTitleSniffer.ts`.

export { OscTitleSniffer, type OscTitleEvent } from '../../daemon/ptyHost/oscTitleSniffer';
