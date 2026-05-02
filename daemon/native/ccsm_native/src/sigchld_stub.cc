// sigchld — non-POSIX stub (Win32). SIGCHLD does not exist on
// Windows; PTY exit is observed via node-pty's `onExit` (which polls
// `GetExitCodeProcess`) + the JobObject path (winjob_win.cc).
// Throws ENOSYS on every call.

#include "surfaces.h"

namespace ccsm_n {

void RegisterSigchld(Napi::Env env, Napi::Object exports) {
  exports.Set(
      "subscribe",
      Napi::Function::New(
          env,
          [](const Napi::CallbackInfo& i) {
            ThrowEnosys(i.Env(), "sigchld", "subscribe");
            return i.Env().Null();
          },
          "subscribe"));
  exports.Set(
      "waitpid",
      Napi::Function::New(
          env,
          [](const Napi::CallbackInfo& i) {
            ThrowEnosys(i.Env(), "sigchld", "waitpid");
            return i.Env().Null();
          },
          "waitpid"));
}

}  // namespace ccsm_n
