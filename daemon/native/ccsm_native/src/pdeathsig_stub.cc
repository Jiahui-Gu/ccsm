// pdeathsig — non-Linux stub. Throws ENOSYS on macOS / Windows. The
// macOS analogue (kqueue NOTE_EXIT) is documented in spec §3.5.1.2
// "macOS parent-watch" as deferred — the v0.3 path relies on the
// supervisor's cold-restart pgid-SIGKILL sweep.

#include "surfaces.h"

namespace ccsm_n {

void RegisterPdeathsig(Napi::Env env, Napi::Object exports) {
  exports.Set(
      "armSelf",
      Napi::Function::New(
          env,
          [](const Napi::CallbackInfo& i) {
            ThrowEnosys(i.Env(), "pdeathsig", "armSelf");
            return i.Env().Null();
          },
          "armSelf"));
}

}  // namespace ccsm_n
