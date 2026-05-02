// pipeAcl — non-Win32 stub. Throws ENOSYS.

#include "surfaces.h"

namespace ccsm_n {

void RegisterPipeAcl(Napi::Env env, Napi::Object exports) {
  exports.Set(
      "applyOwnerOnly",
      Napi::Function::New(
          env,
          [](const Napi::CallbackInfo& i) {
            ThrowEnosys(i.Env(), "pipeAcl", "applyOwnerOnly");
            return i.Env().Null();
          },
          "applyOwnerOnly"));
}

}  // namespace ccsm_n
