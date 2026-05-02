// pdeathsig — Linux PR_SET_PDEATHSIG self-arm.
//
// Spec: frag-3.5.1 §3.5.1.2 (POSIX process group + SIGCHLD wiring).
//
// One export: `armSelf(signal: number): void`. The Linux kernel
// signals the calling process with `signal` when its parent dies.
// Per spec, the daemon arms its OWN children right after fork (the
// node-pty spawn hook); but since we run inside the daemon process
// and node-pty does not currently expose a post-fork pre-exec hook
// in JS-land, the practical wiring documented in spec §3.5.1.2
// "Linux PDEATHSIG" is to arm pdeathsig **on the parent's behalf
// inside the child** — which from the binding's POV is the same
// syscall called from the calling thread.
//
// In v0.3 we expose `armSelf(signal)` so the call site can be
// `prctl(PR_SET_PDEATHSIG, SIGTERM)` from whichever context is
// appropriate (the JS-side wrapper documents which one it is).

#include <sys/prctl.h>
#include <errno.h>
#include <string.h>

#include <string>

#include "surfaces.h"

namespace ccsm_n {

namespace {

Napi::Value PdeathsigArmSelf(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsNumber()) {
    Napi::TypeError::New(env, "pdeathsig.armSelf(signal: number)")
        .ThrowAsJavaScriptException();
    return env.Null();
  }
  int sig = info[0].As<Napi::Number>().Int32Value();
  if (prctl(PR_SET_PDEATHSIG, sig, 0, 0, 0) != 0) {
    int err = errno;
    Napi::Error e = Napi::Error::New(
        env,
        std::string("prctl(PR_SET_PDEATHSIG) failed: ") + strerror(err));
    e.Set("code", Napi::String::New(env, "EPRCTL"));
    e.Set("errno", Napi::Number::New(env, err));
    e.ThrowAsJavaScriptException();
    return env.Null();
  }
  return env.Undefined();
}

}  // namespace

void RegisterPdeathsig(Napi::Env env, Napi::Object exports) {
  exports.Set("armSelf",
              Napi::Function::New(env, PdeathsigArmSelf, "armSelf"));
}

}  // namespace ccsm_n
