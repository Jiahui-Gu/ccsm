// ccsm_native — N-API entry point.
//
// Spec: docs/superpowers/specs/v0.3-fragments/frag-3.5.1-pty-hardening.md
//   §3.5.1.1.a   "Native binding swap interface (lockin-P0-2)"
//
// Single-responsibility: this translation unit is the napi `Init`
// dispatcher. It owns NO syscall logic — it forwards to per-surface
// `Register*` functions implemented in surface-specific .cc files.
// Every surface's per-platform implementation lives in either
// <surface>_<platform>.cc (real impl) or <surface>_stub.cc (throws
// `code: 'ENOSYS'` so the JS layer's "MUST throw on the wrong
// platform" contract is honoured at the binding layer too — no
// surface ever silently no-ops at the native level).
//
// Export shape (consumed by `daemon/src/native/index.ts` shim):
//
//   {
//     winjob:   { create(): JobHandle, assign(h, pid), terminate(h, code) },
//     pipeAcl:  { applyOwnerOnly(pipePath: string): void },
//     pdeathsig:{ armSelf(signal: number): void },
//     peerCred: {
//       getNamedPipeClientProcessId(socket): number,   // win32 only
//       openProcessTokenUserSid(pid): string,          // win32 only
//       getsockoptPeerCred(socket): { uid, gid, pid }, // linux only
//       getpeereid(socket): { uid, gid },              // darwin only
//     },
//     sigchld:  {
//       subscribe(handler: () => void): () => void,    // POSIX only
//       waitpid(pid: number): WaitpidResult,           // POSIX only
//     },
//   }
//
// Per-platform availability is documented in the per-surface header
// `surfaces.h`. The JS shim narrows the type at runtime by
// `process.platform`.

#include <napi.h>

#include "surfaces.h"

namespace ccsm_n {

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  Napi::Object winjob = Napi::Object::New(env);
  RegisterWinjob(env, winjob);
  exports.Set("winjob", winjob);

  Napi::Object pipeAcl = Napi::Object::New(env);
  RegisterPipeAcl(env, pipeAcl);
  exports.Set("pipeAcl", pipeAcl);

  Napi::Object pdeathsig = Napi::Object::New(env);
  RegisterPdeathsig(env, pdeathsig);
  exports.Set("pdeathsig", pdeathsig);

  Napi::Object peerCred = Napi::Object::New(env);
  RegisterPeerCred(env, peerCred);
  exports.Set("peerCred", peerCred);

  Napi::Object sigchld = Napi::Object::New(env);
  RegisterSigchld(env, sigchld);
  exports.Set("sigchld", sigchld);

  // Cheap version probe so the JS shim can sanity-check the loaded
  // .node matches the expected ABI shape. Bumped manually whenever
  // the export surface changes.
  exports.Set("bindingVersion", Napi::String::New(env, "0.3.0"));

  return exports;
}

}  // namespace ccsm_n

// File-scope shim — NODE_API_MODULE concatenates `__napi_` with the
// regfunc token, which forbids qualified names like `ccsm_n::Init`.
// We expose `InitModule` at the global namespace and forward into the
// namespaced implementation. Spec note: keeping the implementation in
// the namespace preserves single-responsibility (file-scope shim is
// the only piece that touches macros).
static Napi::Object InitModule(Napi::Env env, Napi::Object exports) {
  return ccsm_n::Init(env, exports);
}

NODE_API_MODULE(ccsm_native, InitModule)
