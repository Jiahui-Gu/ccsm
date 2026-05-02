// peerCred — Darwin / macOS getpeereid.
//
// Spec: frag-3.4.1 §3.4.1.j, v0.3-design §3.1.1.
//
// One Darwin export: `getpeereid(socket): { uid, gid }`. Extracts the
// underlying fd from `socket._handle.fd` and calls `getpeereid(fd,
// &uid, &gid)`. Note: getpeereid does NOT return a pid; callers (the
// `verifyPeerCred` decider) MUST treat `peer.pid` as undefined on
// this platform.

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

Napi::Value GetpeereidFn(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1) {
    Napi::TypeError::New(env, "peerCred.getpeereid(socket)")
        .ThrowAsJavaScriptException();
    return env.Null();
  }
  int fd = ExtractFdFromSocket(env, info[0]);
  if (fd < 0) return env.Null();

  uid_t uid = 0;
  gid_t gid = 0;
  if (getpeereid(fd, &uid, &gid) != 0) {
    int err = errno;
    Napi::Error e = Napi::Error::New(
        env, std::string("getpeereid failed: ") + strerror(err));
    e.Set("code", Napi::String::New(env, "EGETPEEREID"));
    e.Set("errno", Napi::Number::New(env, err));
    e.ThrowAsJavaScriptException();
    return env.Null();
  }

  Napi::Object out = Napi::Object::New(env);
  out.Set("uid", Napi::Number::New(env, static_cast<double>(uid)));
  out.Set("gid", Napi::Number::New(env, static_cast<double>(gid)));
  return out;
}

}  // namespace

void RegisterPeerCred(Napi::Env env, Napi::Object exports) {
  exports.Set("getpeereid",
              Napi::Function::New(env, GetpeereidFn, "getpeereid"));
}

}  // namespace ccsm_n
