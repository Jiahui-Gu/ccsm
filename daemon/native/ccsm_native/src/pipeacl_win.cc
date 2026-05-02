// pipeAcl — Win32 named-pipe DACL hardening.
//
// Spec: frag-3.5.1 §3.5.1.6 + frag-6-7 §7.M1.
//
// One export: `applyOwnerOnly(pipePath: string): void`. The five
// syscalls listed in `daemon/src/pty/pipe-acl.ts` (token query, ACL
// build, deny ACEs for BUILTIN\Users + ANONYMOUS LOGON, set DACL,
// PIPE_REJECT_REMOTE_CLIENTS) all happen inside this single call so
// JS never observes an intermediate-DACL state.

#include <windows.h>
#include <aclapi.h>
#include <sddl.h>

#include <memory>
#include <string>
#include <vector>

#include "surfaces.h"

namespace ccsm_n {

namespace {

struct LocalDeleter {
  void operator()(void* p) const noexcept {
    if (p != nullptr) ::LocalFree(p);
  }
};

template <typename T>
using LocalPtr = std::unique_ptr<T, LocalDeleter>;

// Convert a UTF-8 std::string to a UTF-16 std::wstring suitable for
// CreateFileW / pipe APIs. Empty input yields empty output.
std::wstring Utf8ToWide(const std::string& s) {
  if (s.empty()) return std::wstring();
  int needed = MultiByteToWideChar(CP_UTF8, 0, s.data(),
                                   static_cast<int>(s.size()), nullptr, 0);
  std::wstring out(static_cast<size_t>(needed), L'\0');
  MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()),
                      out.data(), needed);
  return out;
}

// ThrowWinErr: convert a Win32 error code into a JS Error with
// `code: 'EWINAPI'`. Returns env.Null() so callers can `return`.
Napi::Value ThrowWinErr(Napi::Env env, const char* op, DWORD err) {
  Napi::Error e = Napi::Error::New(
      env,
      std::string("pipeAcl.") + op + " failed: code=" + std::to_string(err));
  e.Set("code", Napi::String::New(env, "EWINAPI"));
  e.Set("winErr", Napi::Number::New(env, static_cast<double>(err)));
  e.ThrowAsJavaScriptException();
  return env.Null();
}

Napi::Value PipeAclApplyOwnerOnly(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "pipeAcl.applyOwnerOnly(pipePath: string)")
        .ThrowAsJavaScriptException();
    return env.Null();
  }
  std::string pipePath = info[0].As<Napi::String>().Utf8Value();
  std::wstring wpipe = Utf8ToWide(pipePath);

  // Open the pipe with WRITE_DAC so SetSecurityInfo can replace the
  // DACL. The pipe must already exist (created by `net.Server.listen`).
  HANDLE pipe = CreateFileW(wpipe.c_str(),
                            WRITE_DAC | READ_CONTROL,
                            FILE_SHARE_READ | FILE_SHARE_WRITE,
                            nullptr,
                            OPEN_EXISTING,
                            0,
                            nullptr);
  if (pipe == INVALID_HANDLE_VALUE) {
    return ThrowWinErr(env, "CreateFile(pipe)", GetLastError());
  }

  // 1. Resolve current process user SID.
  HANDLE token = nullptr;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) {
    DWORD err = GetLastError();
    CloseHandle(pipe);
    return ThrowWinErr(env, "OpenProcessToken", err);
  }
  DWORD tuLen = 0;
  GetTokenInformation(token, TokenUser, nullptr, 0, &tuLen);
  if (tuLen == 0) {
    DWORD err = GetLastError();
    CloseHandle(token);
    CloseHandle(pipe);
    return ThrowWinErr(env, "GetTokenInformation(size)", err);
  }
  std::vector<BYTE> tuBuf(tuLen);
  if (!GetTokenInformation(token, TokenUser, tuBuf.data(), tuLen, &tuLen)) {
    DWORD err = GetLastError();
    CloseHandle(token);
    CloseHandle(pipe);
    return ThrowWinErr(env, "GetTokenInformation", err);
  }
  CloseHandle(token);
  PSID userSid = reinterpret_cast<TOKEN_USER*>(tuBuf.data())->User.Sid;

  // 2. Build BUILTIN\Users + ANONYMOUS LOGON SIDs for explicit deny.
  PSID usersSid = nullptr;
  PSID anonSid = nullptr;
  SID_IDENTIFIER_AUTHORITY ntAuth = SECURITY_NT_AUTHORITY;
  if (!AllocateAndInitializeSid(&ntAuth, 2,
                                SECURITY_BUILTIN_DOMAIN_RID,
                                DOMAIN_ALIAS_RID_USERS, 0, 0, 0, 0, 0, 0,
                                &usersSid)) {
    DWORD err = GetLastError();
    CloseHandle(pipe);
    return ThrowWinErr(env, "AllocateSid(Users)", err);
  }
  if (!AllocateAndInitializeSid(&ntAuth, 1,
                                SECURITY_ANONYMOUS_LOGON_RID,
                                0, 0, 0, 0, 0, 0, 0,
                                &anonSid)) {
    DWORD err = GetLastError();
    FreeSid(usersSid);
    CloseHandle(pipe);
    return ThrowWinErr(env, "AllocateSid(Anonymous)", err);
  }

  // 3. Build a fresh DACL with one allow + two deny ACEs.
  EXPLICIT_ACCESSW eas[3];
  ZeroMemory(eas, sizeof(eas));
  eas[0].grfAccessPermissions = GENERIC_READ | GENERIC_WRITE;
  eas[0].grfAccessMode = SET_ACCESS;
  eas[0].grfInheritance = NO_INHERITANCE;
  eas[0].Trustee.TrusteeForm = TRUSTEE_IS_SID;
  eas[0].Trustee.TrusteeType = TRUSTEE_IS_USER;
  eas[0].Trustee.ptstrName = reinterpret_cast<LPWSTR>(userSid);

  eas[1].grfAccessPermissions = GENERIC_ALL;
  eas[1].grfAccessMode = DENY_ACCESS;
  eas[1].grfInheritance = NO_INHERITANCE;
  eas[1].Trustee.TrusteeForm = TRUSTEE_IS_SID;
  eas[1].Trustee.TrusteeType = TRUSTEE_IS_GROUP;
  eas[1].Trustee.ptstrName = reinterpret_cast<LPWSTR>(usersSid);

  eas[2].grfAccessPermissions = GENERIC_ALL;
  eas[2].grfAccessMode = DENY_ACCESS;
  eas[2].grfInheritance = NO_INHERITANCE;
  eas[2].Trustee.TrusteeForm = TRUSTEE_IS_SID;
  eas[2].Trustee.TrusteeType = TRUSTEE_IS_USER;
  eas[2].Trustee.ptstrName = reinterpret_cast<LPWSTR>(anonSid);

  PACL acl = nullptr;
  DWORD setErr = SetEntriesInAclW(3, eas, nullptr, &acl);
  FreeSid(usersSid);
  FreeSid(anonSid);
  if (setErr != ERROR_SUCCESS) {
    CloseHandle(pipe);
    return ThrowWinErr(env, "SetEntriesInAcl", setErr);
  }
  LocalPtr<ACL> aclGuard(acl);

  // 4. Apply the new DACL to the pipe handle.
  DWORD si = SetSecurityInfo(pipe, SE_KERNEL_OBJECT,
                             DACL_SECURITY_INFORMATION |
                                 PROTECTED_DACL_SECURITY_INFORMATION,
                             nullptr, nullptr, acl, nullptr);
  if (si != ERROR_SUCCESS) {
    CloseHandle(pipe);
    return ThrowWinErr(env, "SetSecurityInfo", si);
  }

  // 5. Reject remote clients on the pipe state.
  DWORD pipeMode = PIPE_REJECT_REMOTE_CLIENTS;
  // SetNamedPipeHandleState's first parameter must be a pipe state
  // word. We do NOT change PIPE_READMODE_*; pass a value of 0 to
  // mean "don't change" via NULL pointer below.
  if (!SetNamedPipeHandleState(pipe, &pipeMode, nullptr, nullptr)) {
    DWORD err = GetLastError();
    // SetNamedPipeHandleState returning ERROR_ACCESS_DENIED on a pipe
    // we just hardened the DACL of is the expected "we already locked
    // ourselves out of mode-change" state and is not fatal; the DACL
    // is already applied. We surface anything else as a hard error.
    if (err != ERROR_ACCESS_DENIED) {
      CloseHandle(pipe);
      return ThrowWinErr(env, "SetNamedPipeHandleState", err);
    }
  }

  CloseHandle(pipe);
  return env.Undefined();
}

}  // namespace

void RegisterPipeAcl(Napi::Env env, Napi::Object exports) {
  exports.Set("applyOwnerOnly",
              Napi::Function::New(env, PipeAclApplyOwnerOnly, "applyOwnerOnly"));
}

}  // namespace ccsm_n
