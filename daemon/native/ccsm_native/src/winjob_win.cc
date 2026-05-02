// winjob — Win32 JobObject helpers.
//
// Spec: frag-3.5.1 §3.5.1.1 (Win JobObject wiring).
//
// Three syscalls collapsed to three N-API exports:
//
//   create()                   -> external pointer (HANDLE)
//      CreateJobObjectW(NULL, NULL)
//      SetInformationJobObject(JobObjectExtendedLimitInformation,
//        { LimitFlags: KILL_ON_JOB_CLOSE | BREAKAWAY_OK })
//
//   assign(handle, pid)        -> void
//      OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, false, pid)
//      AssignProcessToJobObject(handle, processHandle)
//      CloseHandle(processHandle)
//
//   terminate(handle, code)    -> void
//      TerminateJobObject(handle, code)
//
// Handle lifetime: per §3.5.1.1 "Lifetime", the JobObject HANDLE is
// allocated once at daemon boot and held for the daemon's whole life
// — the OS closes it on process exit, which is the trigger for
// `KILL_ON_JOB_CLOSE`. We therefore return the raw HANDLE to JS as
// an external pointer (uint64 buffer) and provide NO `close()` /
// `dispose()` export. JS wraps the lifetime via the `JobObjectHandle`
// abstraction in `daemon/src/pty/win-jobobject.ts`.

#include <windows.h>

#include "surfaces.h"

namespace ccsm_n {

namespace {

// Externals are wrapped in a Napi::External<HANDLE> so the GC tracks
// them but never frees the underlying HANDLE (finalizer is a no-op
// per the lifetime contract above). Using External instead of a
// uint64 BigInt keeps a JS-side sanity-check trivial: the value is
// not a number, not a string, and instanceof Object — easy to
// distinguish from accidental misuse.
void NoopFinalize(Napi::Env, HANDLE) {
  // intentionally empty — see file header
}

Napi::Value WinjobCreate(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  HANDLE job = CreateJobObjectW(nullptr, nullptr);
  if (job == nullptr) {
    DWORD err = GetLastError();
    Napi::Error e = Napi::Error::New(
        env, "CreateJobObjectW failed: code=" + std::to_string(err));
    e.Set("code", Napi::String::New(env, "EWINAPI"));
    e.Set("winErr", Napi::Number::New(env, static_cast<double>(err)));
    e.ThrowAsJavaScriptException();
    return env.Null();
  }

  JOBOBJECT_EXTENDED_LIMIT_INFORMATION info_eli;
  ZeroMemory(&info_eli, sizeof(info_eli));
  info_eli.BasicLimitInformation.LimitFlags =
      JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_BREAKAWAY_OK;

  if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation,
                               &info_eli, sizeof(info_eli))) {
    DWORD err = GetLastError();
    CloseHandle(job);
    Napi::Error e = Napi::Error::New(
        env, "SetInformationJobObject failed: code=" + std::to_string(err));
    e.Set("code", Napi::String::New(env, "EWINAPI"));
    e.Set("winErr", Napi::Number::New(env, static_cast<double>(err)));
    e.ThrowAsJavaScriptException();
    return env.Null();
  }

  return Napi::External<void>::New(env, job, NoopFinalize);
}

Napi::Value WinjobAssign(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[0].IsExternal() || !info[1].IsNumber()) {
    Napi::TypeError::New(env,
                         "winjob.assign(handle: External, pid: number)")
        .ThrowAsJavaScriptException();
    return env.Null();
  }
  HANDLE job = info[0].As<Napi::External<void>>().Data();
  DWORD pid = static_cast<DWORD>(info[1].As<Napi::Number>().Uint32Value());

  HANDLE proc = OpenProcess(
      PROCESS_SET_QUOTA | PROCESS_TERMINATE, FALSE, pid);
  if (proc == nullptr) {
    DWORD err = GetLastError();
    Napi::Error e = Napi::Error::New(
        env, "OpenProcess failed for pid=" + std::to_string(pid) +
                 " code=" + std::to_string(err));
    e.Set("code", Napi::String::New(env, "EWINAPI"));
    e.Set("winErr", Napi::Number::New(env, static_cast<double>(err)));
    e.ThrowAsJavaScriptException();
    return env.Null();
  }

  BOOL ok = AssignProcessToJobObject(job, proc);
  DWORD err = ok ? 0 : GetLastError();
  CloseHandle(proc);
  if (!ok) {
    Napi::Error e = Napi::Error::New(
        env, "AssignProcessToJobObject failed for pid=" +
                 std::to_string(pid) + " code=" + std::to_string(err));
    e.Set("code", Napi::String::New(env, "EWINAPI"));
    e.Set("winErr", Napi::Number::New(env, static_cast<double>(err)));
    e.ThrowAsJavaScriptException();
    return env.Null();
  }
  return env.Undefined();
}

Napi::Value WinjobTerminate(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[0].IsExternal() || !info[1].IsNumber()) {
    Napi::TypeError::New(env,
                         "winjob.terminate(handle: External, exitCode: number)")
        .ThrowAsJavaScriptException();
    return env.Null();
  }
  HANDLE job = info[0].As<Napi::External<void>>().Data();
  UINT code = static_cast<UINT>(info[1].As<Napi::Number>().Uint32Value());

  if (!TerminateJobObject(job, code)) {
    DWORD err = GetLastError();
    Napi::Error e = Napi::Error::New(
        env, "TerminateJobObject failed: code=" + std::to_string(err));
    e.Set("code", Napi::String::New(env, "EWINAPI"));
    e.Set("winErr", Napi::Number::New(env, static_cast<double>(err)));
    e.ThrowAsJavaScriptException();
    return env.Null();
  }
  return env.Undefined();
}

}  // namespace

void RegisterWinjob(Napi::Env env, Napi::Object exports) {
  exports.Set("create", Napi::Function::New(env, WinjobCreate, "create"));
  exports.Set("assign", Napi::Function::New(env, WinjobAssign, "assign"));
  exports.Set("terminate",
              Napi::Function::New(env, WinjobTerminate, "terminate"));
}

}  // namespace ccsm_n
