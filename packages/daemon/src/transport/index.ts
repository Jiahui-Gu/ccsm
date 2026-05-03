// HTTP/2 transport adapter barrel — single import surface for the
// factory (T1.4) and tests. Re-exports the four adapters + their
// shared types; no runtime logic of its own.
//
// Spec ch03 §4 — A1/A2/A3/A4.

export type {
  BoundAddress,
  BoundTransport,
  H2cServer,
  H2TlsServer,
  LoopbackBindSpec,
  NamedPipeBindSpec,
  TlsBindSpec,
  TransportAdapter,
  UdsBindSpec,
} from './types.js';

export { bindH2cUds } from './h2c-uds.js';
export { bindH2cLoopback } from './h2c-loopback.js';
export { bindH2NamedPipe, normalizePipePath } from './h2-named-pipe.js';
export { bindH2Tls, computeCertFingerprint } from './h2-tls.js';
