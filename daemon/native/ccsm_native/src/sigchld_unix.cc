// sigchld — POSIX SIGCHLD subscription + per-PID waitpid.
//
// Spec: frag-3.5.1 §3.5.1.2 (POSIX process group + SIGCHLD wiring).
//
// Two POSIX exports:
//
//   subscribe(handler: () => void): () => void
//      Wraps `uv_signal_t` against the Node event loop so SIGCHLD
//      delivery surfaces as a normal libuv callback (no
//      async-signal-safety concerns from a sigaction callback). The
//      returned function detaches the subscription.
//
//   waitpid(pid: number): { state, exitCode?, signal? }
//      `waitpid(pid, &status, WNOHANG)`. Per spec: per-PID scope,
//      WNOHANG mandatory, never reaps PIDs the daemon does not own.
//
// Why uv_signal_t and not sigaction directly: the libuv handle does
// the right thing with multiple subscribers (we install one), runs
// the callback on the event loop thread (so calling into JS is
// safe), and is tested against signal coalescing inside libuv. The
// JS-side `installSigchldReaper` (T38) iterates registered PIDs on
// every callback exactly because POSIX coalesces SIGCHLD — we
// preserve that contract.

#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>
#include <signal.h>
#include <errno.h>
#include <string.h>

#include <memory>
#include <string>

#include <uv.h>

#include "surfaces.h"

namespace ccsm_n {

namespace {

// One subscription = one uv_signal_t + one persistent JS callback.
// The daemon installs this exactly once at boot per spec; we permit
// multiple concurrent subscriptions (e.g. tests) by tracking each in
// its own heap-allocated holder.
struct Sub {
  uv_signal_t handle{};
  Napi::FunctionReference cb;
  bool detached = false;
};

void OnSigchld(uv_signal_t* h, int /*signum*/) {
  auto* sub = static_cast<Sub*>(h->data);
  if (sub == nullptr || sub->detached) return;
  if (sub->cb.IsEmpty()) return;
  Napi::Env env = sub->cb.Env();
  Napi::HandleScope scope(env);
  // The JS callback is `() => void` per spec — pure producer; any
  // throw bubbles to the libuv loop's unhandled-error sink.
  sub->cb.Call({});
}

void OnCloseFreeSub(uv_handle_t* h) {
  auto* sub = static_cast<Sub*>(h->data);
  delete sub;
}

Napi::Value SubscribeFn(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsFunction()) {
    Napi::TypeError::New(env, "sigchld.subscribe(handler: () => void)")
        .ThrowAsJavaScriptException();
    return env.Null();
  }
  uv_loop_t* loop = nullptr;
  napi_status st = napi_get_uv_event_loop(env, &loop);
  if (st != napi_ok || loop == nullptr) {
    Napi::Error::New(env, "sigchld.subscribe: napi_get_uv_event_loop failed")
        .ThrowAsJavaScriptException();
    return env.Null();
  }

  auto sub = std::make_unique<Sub>();
  sub->cb = Napi::Persistent(info[0].As<Napi::Function>());
  sub->handle.data = sub.get();

  if (uv_signal_init(loop, &sub->handle) != 0) {
    Napi::Error::New(env, "sigchld.subscribe: uv_signal_init failed")
        .ThrowAsJavaScriptException();
    return env.Null();
  }
  if (uv_signal_start(&sub->handle, OnSigchld, SIGCHLD) != 0) {
    uv_close(reinterpret_cast<uv_handle_t*>(&sub->handle),
             [](uv_handle_t* h) {
               auto* s = static_cast<Sub*>(h->data);
               delete s;
             });
    sub.release();  // freed in the close cb
    Napi::Error::New(env, "sigchld.subscribe: uv_signal_start failed")
        .ThrowAsJavaScriptException();
    return env.Null();
  }
  // Don't let the signal handle keep the event loop alive on its
  // own. The daemon has plenty of other refs (server, timers); this
  // matches the contract that the reaper does not by itself prevent
  // process exit.
  uv_unref(reinterpret_cast<uv_handle_t*>(&sub->handle));

  Sub* raw = sub.release();

  // Returned `detach` closure. Closing the handle is async (uv runs
  // the close cb on the next loop tick) so we mark `detached` first
  // to swallow any in-flight callbacks.
  auto detachFn = Napi::Function::New(
      env, [raw](const Napi::CallbackInfo& cbInfo) -> Napi::Value {
        Napi::Env e = cbInfo.Env();
        if (raw->detached) return e.Undefined();
        raw->detached = true;
        // Stop the signal first so no new callbacks fire, then close.
        uv_signal_stop(&raw->handle);
        uv_close(reinterpret_cast<uv_handle_t*>(&raw->handle),
                 OnCloseFreeSub);
        // raw is freed inside OnCloseFreeSub — do NOT touch it after.
        return e.Undefined();
      },
      "detach");
  return detachFn;
}

Napi::Value WaitpidFn(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsNumber()) {
    Napi::TypeError::New(env, "sigchld.waitpid(pid: number)")
        .ThrowAsJavaScriptException();
    return env.Null();
  }
  pid_t pid = static_cast<pid_t>(info[0].As<Napi::Number>().Int32Value());

  int status = 0;
  pid_t r = ::waitpid(pid, &status, WNOHANG);
  Napi::Object out = Napi::Object::New(env);
  if (r == 0) {
    out.Set("state", Napi::String::New(env, "no-state-change"));
    return out;
  }
  if (r < 0) {
    // ECHILD = "no such child or already reaped"; per the JS-side
    // contract this maps to `no-state-change` (the reaper treats
    // both kernel outcomes as "nothing to do for this pid right
    // now"). Other errnos (EINVAL, EINTR) bubble.
    if (errno == ECHILD) {
      out.Set("state", Napi::String::New(env, "no-state-change"));
      return out;
    }
    int err = errno;
    Napi::Error e = Napi::Error::New(
        env, std::string("waitpid failed: ") + strerror(err));
    e.Set("code", Napi::String::New(env, "EWAITPID"));
    e.Set("errno", Napi::Number::New(env, err));
    e.ThrowAsJavaScriptException();
    return env.Null();
  }
  // r > 0  →  exited. Decode status.
  out.Set("state", Napi::String::New(env, "exited"));
  if (WIFEXITED(status)) {
    out.Set("exitCode",
            Napi::Number::New(env, static_cast<double>(WEXITSTATUS(status))));
  } else if (WIFSIGNALED(status)) {
    int sig = WTERMSIG(status);
    out.Set("exitCode", Napi::Number::New(env, 0));
    const char* name = strsignal(sig);
    out.Set("signal",
            name != nullptr
                ? Napi::Value(Napi::String::New(env, name))
                : Napi::Value(Napi::Number::New(env, sig)));
  } else {
    // Stopped/continued etc. — treat as no-state-change. waitpid
    // without WUNTRACED/WCONTINUED won't actually surface these.
    out.Set("state", Napi::String::New(env, "no-state-change"));
  }
  return out;
}

}  // namespace

void RegisterSigchld(Napi::Env env, Napi::Object exports) {
  exports.Set("subscribe",
              Napi::Function::New(env, SubscribeFn, "subscribe"));
  exports.Set("waitpid", Napi::Function::New(env, WaitpidFn, "waitpid"));
}

}  // namespace ccsm_n
