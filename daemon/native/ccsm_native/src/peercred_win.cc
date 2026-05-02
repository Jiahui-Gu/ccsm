// peerCred — Win32 named-pipe peer identity (SID).
//
// Spec: frag-3.4.1 §3.4.1.j, v0.3-design §3.1.1.
//
// Two exports for Win:
//
//   getNamedPipeClientProcessId(socket): number
//      socket._handle.fd  →  HANDLE  →  GetNamedPipeClientProcessId
//
//   openProcessTokenUserSid(pid: number): string
//      OpenProcess(QUERY_LIMITED_INFORMATION) →
//      OpenProcessToken(TOKEN_QUERY) →
//      GetTokenInformation(TokenUser) →
//      ConvertSidToStringSidW
//
// Socket handle extraction note:
//
// The spec docstring on `daemon/src/sockets/peer-cred-verify.ts` says
// "the binding extracts the OS handle via `socket._handle.fd` (or the
// equivalent N-API accessor)". libuv pipes expose their HANDLE on
// `socket._handle.fd` as a number whose value is the raw HANDLE bit
// pattern (libuv internal contract; uv_pipe_t.handle is HANDLE). We
// validate the number is non-negative and a finite integer and cast.
// The JS shim is the only legitimate caller and is the one place that
// owns this assumption.

#include <windows.h>
#include <sddl.h>

#include <cstdint>
#include <string>
#include <vector>

#include "surfaces.h"

namespace ccsm_n {

namespace {

HANDLE ExtractHandleFromSocket(Napi::Env env, const Napi::Value& v) {
  if (!v.IsObject()) {
    Napi::TypeError::New(env, "peerCred: socket arg must be a net.Socket")
        .ThrowAsJavaScriptException();
    return INVALID_HANDLE_VALUE;
  }
  Napi::Object sock = v.As<Napi::Object>();
  Napi::Value handleVal = sock.Get("_handle");
  if (!handleVal.IsObject()) {
    Napi::TypeError::New(env,
                         "peerCred: socket._handle missing (socket destroyed?)")
        .ThrowAsJavaScriptException();
    return INVALID_HANDLE_VALUE;
  }
  Napi::Value fdVal = handleVal.As<Napi::Object>().Get("fd");
  if (!fdVal.IsNumber()) {
    Napi::TypeError::New(env,
                         "peerCred: socket._handle.fd missing or non-numeric")
        .ThrowAsJavaScriptException();
    return INVALID_HANDLE_VALUE;
  }
  // libuv stores HANDLE bit pattern in the JS number; on 32-bit Node the
  // upper 32 bits are zero. We accept up to int64 (fd may be -1 sentinel
  // on a closed handle, which we treat as INVALID_HANDLE_VALUE).
  int64_t raw = fdVal.As<Napi::Number>().Int64Value();
  if (raw < 0) {
    Napi::Error e = Napi::Error::New(env,
                                     "peerCred: socket fd is closed (-1)");
    e.Set("code", Napi::String::New(env, "EBADF"));
    e.ThrowAsJavaScriptException();
    return INVALID_HANDLE_VALUE;
  }
  return reinterpret_cast<HANDLE>(static_cast<intptr_t>(raw));
}

Napi::Value GetNamedPipeClientProcessIdFn(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1) {
    Napi::TypeError::New(env,
                         "peerCred.getNamedPipeClientProcessId(socket)")
        .ThrowAsJavaScriptException();
    return env.Null();
  }
  HANDLE pipe = ExtractHandleFromSocket(env, info[0]);
  if (pipe == INVALID_HANDLE_VALUE) return env.Null();

  ULONG pid = 0;
  if (!GetNamedPipeClientProcessId(pipe, &pid)) {
    DWORD err = GetLastError();
    Napi::Error e = Napi::Error::New(
        env, std::string("GetNamedPipeClientProcessId failed: code=") +
                 std::to_string(err));
    e.Set("code", Napi::String::New(env, "EWINAPI"));
    e.Set("winErr", Napi::Number::New(env, static_cast<double>(err)));
    e.ThrowAsJavaScriptException();
    return env.Null();
  }
  return Napi::Number::New(env, static_cast<double>(pid));
}

Napi::Value OpenProcessTokenUserSidFn(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsNumber()) {
    Napi::TypeError::New(env,
                         "peerCred.openProcessTokenUserSid(pid: number)")
        .ThrowAsJavaScriptException();
    return env.Null();
  }
  DWORD pid = static_cast<DWORD>(info[0].As<Napi::Number>().Uint32Value());

  HANDLE proc = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (proc == nullptr) {
    DWORD err = GetLastError();
    Napi::Error e = Napi::Error::New(
        env, std::string("OpenProcess(pid=") + std::to_string(pid) +
                 ") failed: code=" + std::to_string(err));
    e.Set("code", Napi::String::New(env, "EWINAPI"));
    e.Set("winErr", Napi::Number::New(env, static_cast<double>(err)));
    e.ThrowAsJavaScriptException();
    return env.Null();
  }

  HANDLE token = nullptr;
  if (!OpenProcessToken(proc, TOKEN_QUERY, &token)) {
    DWORD err = GetLastError();
    CloseHandle(proc);
    Napi::Error e = Napi::Error::New(
        env, std::string("OpenProcessToken failed: code=") + std::to_string(err));
    e.Set("code", Napi::String::New(env, "EWINAPI"));
    e.Set("winErr", Napi::Number::New(env, static_cast<double>(err)));
    e.ThrowAsJavaScriptException();
    return env.Null();
  }
  CloseHandle(proc);

  DWORD tuLen = 0;
  GetTokenInformation(token, TokenUser, nullptr, 0, &tuLen);
  if (tuLen == 0) {
    DWORD err = GetLastError();
    CloseHandle(token);
    Napi::Error e = Napi::Error::New(
        env,
        std::string("GetTokenInformation(size) failed: code=") + std::to_string(err));
    e.Set("code", Napi::String::New(env, "EWINAPI"));
    e.Set("winErr", Napi::Number::New(env, static_cast<double>(err)));
    e.ThrowAsJavaScriptException();
    return env.Null();
  }
  std::vector<BYTE> tuBuf(tuLen);
  if (!GetTokenInformation(token, TokenUser, tuBuf.data(), tuLen, &tuLen)) {
    DWORD err = GetLastError();
    CloseHandle(token);
    Napi::Error e = Napi::Error::New(
        env, std::string("GetTokenInformation failed: code=") + std::to_string(err));
    e.Set("code", Napi::String::New(env, "EWINAPI"));
    e.Set("winErr", Napi::Number::New(env, static_cast<double>(err)));
    e.ThrowAsJavaScriptException();
    return env.Null();
  }
  CloseHandle(token);

  PSID userSid = reinterpret_cast<TOKEN_USER*>(tuBuf.data())->User.Sid;
  LPWSTR sidStr = nullptr;
  if (!ConvertSidToStringSidW(userSid, &sidStr)) {
    DWORD err = GetLastError();
    Napi::Error e = Napi::Error::New(
        env, std::string("ConvertSidToStringSid failed: code=") +
                 std::to_string(err));
    e.Set("code", Napi::String::New(env, "EWINAPI"));
    e.Set("winErr", Napi::Number::New(env, static_cast<double>(err)));
    e.ThrowAsJavaScriptException();
    return env.Null();
  }
  // sidStr is LPWSTR (UTF-16); convert to UTF-8 std::string for JS.
  int needed = WideCharToMultiByte(CP_UTF8, 0, sidStr, -1, nullptr, 0,
                                   nullptr, nullptr);
  std::string out(static_cast<size_t>(needed > 0 ? needed - 1 : 0), '\0');
  if (needed > 0) {
    WideCharToMultiByte(CP_UTF8, 0, sidStr, -1, out.data(), needed,
                        nullptr, nullptr);
  }
  LocalFree(sidStr);
  return Napi::String::New(env, out);
}

}  // namespace

void RegisterPeerCred(Napi::Env env, Napi::Object exports) {
  exports.Set(
      "getNamedPipeClientProcessId",
      Napi::Function::New(env, GetNamedPipeClientProcessIdFn,
                          "getNamedPipeClientProcessId"));
  exports.Set("openProcessTokenUserSid",
              Napi::Function::New(env, OpenProcessTokenUserSidFn,
                                  "openProcessTokenUserSid"));
}

}  // namespace ccsm_n
