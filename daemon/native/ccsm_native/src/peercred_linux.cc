// peerCred — Linux SO_PEERCRED.
//
// Spec: frag-3.4.1 §3.4.1.j, v0.3-design §3.1.1.
//
// One Linux export: `getsockoptPeerCred(socket): { uid, gid, pid }`.
// Extracts the underlying fd from `socket._handle.fd` (libuv stores
// the fd as a JS number on the handle object) and calls
// `getsockopt(fd, SOL_SOCKET, SO_PEERCRED)`.

#include <sys/socket.h>
#include <sys/types.h>
#include <unistd.h>
#include <errno.h>
#include <string.h>

#include <string>

#include "surfaces.h"

namespace ccsm_n {

namespace {

int ExtractFdFromSocket(Napi::Env env, const Napi::Value& v) {
  if (!v.IsObject()) {
    Napi::TypeError::New(env, "peerCred: socket arg must be a net.Socket")
        .ThrowAsJavaScriptException();
    return -1;
  }
  Napi::Object sock = v.As<Napi::Object>();
  Napi::Value handleVal = sock.Get("_handle");
  if (!handleVal.IsObject()) {
    Napi::TypeError::New(env,
                         "peerCred: socket._handle missing (socket destroyed?)")
        .ThrowAsJavaScriptException();
    return -1;
  }
  Napi::Value fdVal = handleVal.As<Napi::Object>().Get("fd");
  if (!fdVal.IsNumber()) {
    Napi::TypeError::New(env,
                         "peerCred: socket._handle.fd missing or non-numeric")
        .ThrowAsJavaScriptException();
    return -1;
  }
  int fd = fdVal.As<Napi::Number>().Int32Value();
  if (fd < 0) {
    Napi::Error e = Napi::Error::New(env, "peerCred: socket fd is closed (-1)");
    e.Set("code", Napi::String::New(env, "EBADF"));
    e.ThrowAsJavaScriptException();
    return -1;
  }
  return fd;
}

Napi::Value GetsockoptPeerCredFn(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1) {
    Napi::TypeError::New(env, "peerCred.getsockoptPeerCred(socket)")
        .ThrowAsJavaScriptException();
    return env.Null();
  }
  int fd = ExtractFdFromSocket(env, info[0]);
  if (fd < 0) return env.Null();

  struct ucred cred;
  socklen_t len = sizeof(cred);
  if (getsockopt(fd, SOL_SOCKET, SO_PEERCRED, &cred, &len) != 0) {
    int err = errno;
    Napi::Error e = Napi::Error::New(
        env,
        std::string("getsockopt(SO_PEERCRED) failed: ") + strerror(err));
    e.Set("code", Napi::String::New(env, "EGETSOCKOPT"));
    e.Set("errno", Napi::Number::New(env, err));
    e.ThrowAsJavaScriptException();
    return env.Null();
  }

  Napi::Object out = Napi::Object::New(env);
  out.Set("uid", Napi::Number::New(env, static_cast<double>(cred.uid)));
  out.Set("gid", Napi::Number::New(env, static_cast<double>(cred.gid)));
  out.Set("pid", Napi::Number::New(env, static_cast<double>(cred.pid)));
  return out;
}

}  // namespace

void RegisterPeerCred(Napi::Env env, Napi::Object exports) {
  exports.Set("getsockoptPeerCred",
              Napi::Function::New(env, GetsockoptPeerCredFn,
                                  "getsockoptPeerCred"));
  // Win32-only and darwin-only methods are NOT registered on Linux —
  // the JS shim narrows by `process.platform`. If a misconfigured
  // call site reaches for `getNamedPipeClientProcessId` on Linux it
  // gets `undefined` (calling it throws JS-side TypeError, which the
  // peer-cred-verify decider already catches and converts to a clear
  // "wire ccsm_native (frag-11)" error).
}

}  // namespace ccsm_n
