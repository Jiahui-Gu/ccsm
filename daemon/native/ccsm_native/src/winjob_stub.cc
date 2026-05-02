// winjob — non-Win32 stub. Throws ENOSYS on every call.
//
// The JS shim narrows by `process.platform` and never calls these on
// POSIX in production. The stub exists so a misconfigured call site
// fails loud (with `code: 'ENOSYS'`) instead of silently no-oping at
// the binding boundary.

#include "surfaces.h"

namespace ccsm_n {

namespace {

Napi::Value Enosys(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  ThrowEnosys(env, "winjob",
              info.Length() > 0 && info[0].IsString()
                  ? info[0].As<Napi::String>().Utf8Value().c_str()
                  : "<call>");
  return env.Null();
}

}  // namespace

void RegisterWinjob(Napi::Env env, Napi::Object exports) {
  // We register the same names the Win32 build registers so a
  // platform-confused JS caller gets a function reference, calls it,
  // and observes the ENOSYS throw — instead of getting `undefined`
  // and a cryptic "x is not a function" TypeError.
  exports.Set("create", Napi::Function::New(env, [](const Napi::CallbackInfo& i) {
                ThrowEnosys(i.Env(), "winjob", "create");
                return i.Env().Null();
              }, "create"));
  exports.Set("assign", Napi::Function::New(env, [](const Napi::CallbackInfo& i) {
                ThrowEnosys(i.Env(), "winjob", "assign");
                return i.Env().Null();
              }, "assign"));
  exports.Set("terminate",
              Napi::Function::New(env, [](const Napi::CallbackInfo& i) {
                ThrowEnosys(i.Env(), "winjob", "terminate");
                return i.Env().Null();
              }, "terminate"));
}

}  // namespace ccsm_n
