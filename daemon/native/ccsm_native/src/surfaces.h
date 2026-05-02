// Surface registration headers.
//
// Each `Register*(env, exports)` function attaches the JS-visible
// methods of one surface onto the supplied object. Per-platform
// translation units provide either the real implementation or a stub
// that throws `Error { code: 'ENOSYS' }` on call.

#pragma once

#include <napi.h>

namespace ccsm_n {

void RegisterWinjob(Napi::Env env, Napi::Object exports);
void RegisterPipeAcl(Napi::Env env, Napi::Object exports);
void RegisterPdeathsig(Napi::Env env, Napi::Object exports);
void RegisterPeerCred(Napi::Env env, Napi::Object exports);
void RegisterSigchld(Napi::Env env, Napi::Object exports);

// Helper: throw a JS Error with `code: 'ENOSYS'` so the JS shim can
// branch on `err.code === 'ENOSYS'` deterministically. Not a fatal.
inline void ThrowEnosys(Napi::Env env, const char* surface, const char* op) {
  Napi::Error err = Napi::Error::New(
      env,
      std::string(surface) + "." + op + ": ENOSYS (not supported on this platform)");
  err.Set("code", Napi::String::New(env, "ENOSYS"));
  err.Set("surface", Napi::String::New(env, surface));
  err.Set("op", Napi::String::New(env, op));
  err.ThrowAsJavaScriptException();
}

}  // namespace ccsm_n
