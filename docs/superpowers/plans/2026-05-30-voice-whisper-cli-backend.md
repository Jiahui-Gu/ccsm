# Voice whisper-cli Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the smart-whisper scalar N-API voice backend with the official AVX2 `whisper-cli.exe` invoked as a subprocess, dropping transcription latency from ~13 s to sub-second while keeping the `transcribe(pcm)` seam unchanged.

**Architecture:** The only seam is `electron/voice/transcriber.ts`'s `transcribe(pcm: Float32Array): Promise<VoiceResult>`. We split the new backend into three single-responsibility files: a pure WAV encoder, a `spawn` wrapper, and the rewritten orchestrator. The encoder turns the Float32 PCM into a temp 16 kHz mono 16-bit WAV; the wrapper runs `whisper-cli.exe -m model -f wav -t cores-2 -bo 1 -bs 1 -np -nt`; the orchestrator wires resolve-paths → write-temp → spawn → parse stdout → unlink → map to `VoiceResult`. IPC, preload, and renderer are untouched because the signature and return type are identical.

**Tech Stack:** Electron 41 main process, TypeScript 5.7, Node `child_process.spawn` / `fs` / `os` / `path`, vitest. Bundled binary from whisper.cpp release v1.8.5 (`whisper-blas-bin-x64.zip`, reports `AVX=1 AVX2=1 F16C=1 FMA=1`).

**Reference spec:** `docs/superpowers/specs/2026-05-30-voice-whisper-cli-backend-design.md`

---

## File Structure

| File | Responsibility | Status |
|---|---|---|
| `resources/whisper-bin/whisper-cli.exe` + DLLs | the AVX2 binary, committed to git | create (Task 0) |
| `electron/voice/wavEncoder.ts` | pure Float32 → 16-bit PCM WAV `Buffer` | create (Task 1) |
| `electron/voice/__tests__/wavEncoder.test.ts` | WAV header + data assertions | create (Task 1) |
| `electron/voice/whisperCli.ts` | `spawn` lifecycle wrapper | create (Task 2) |
| `electron/voice/transcriber.ts` | orchestration; `resolveModelPath` + `resolveBinPath` | rewrite (Task 3) |
| `electron/voice/__tests__/transcriber.test.ts` | 5-case unit test, mocked spawn + fs | rewrite (Task 3) |
| `scripts/fetch-whisper-model.mjs` | model fetch: `small` → `base` | modify (Task 4) |
| `package.json` | extraResources + drop smart-whisper | modify (Task 4) |

---

## Task 0: Stage the AVX2 binary into the repo

**Files:**
- Create: `resources/whisper-bin/whisper-cli.exe` and its sibling DLLs

The temp benchmark binary was cleaned up, so re-fetch the official asset, extract it, and copy the runtime files into `resources/whisper-bin/`. The release zip puts the exe and DLLs flat in its root; we keep only the files `whisper-cli.exe` needs at runtime (the exe plus all `*.dll` beside it — typically `whisper.dll`, `ggml.dll`, `ggml-base.dll`, `ggml-cpu.dll`, and the OpenBLAS/`libopenblas.dll` set). Do NOT copy `main.exe`, `bench.exe`, `quantize.exe`, `server.exe`, or `*.lib`/headers.

- [ ] **Step 1: Download the release asset (proxy-bypassed)**

Run:
```bash
mkdir -p C:/Users/Jiahui/repos/ccsm/.tmp-whisper-dl
env -u https_proxy -u HTTPS_PROXY -u http_proxy -u HTTP_PROXY -u ALL_PROXY -u all_proxy \
  gh release download v1.8.5 --repo ggml-org/whisper.cpp \
  --pattern 'whisper-blas-bin-x64.zip' \
  --dir C:/Users/Jiahui/repos/ccsm/.tmp-whisper-dl
```
Expected: `whisper-blas-bin-x64.zip` (~10–15 MB) in `.tmp-whisper-dl/`.

If `gh release download` fails on network, fall back to curl:
```bash
env -u https_proxy -u HTTPS_PROXY -u http_proxy -u HTTP_PROXY -u ALL_PROXY -u all_proxy \
  curl -L -o C:/Users/Jiahui/repos/ccsm/.tmp-whisper-dl/whisper-blas-bin-x64.zip \
  "https://github.com/ggml-org/whisper.cpp/releases/download/v1.8.5/whisper-blas-bin-x64.zip"
```

- [ ] **Step 2: Extract the zip**

Run (PowerShell, absolute paths — `Expand-Archive` has been flaky, use the .NET API):
```bash
powershell -NoProfile -Command "Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory('C:\\Users\\Jiahui\\repos\\ccsm\\.tmp-whisper-dl\\whisper-blas-bin-x64.zip', 'C:\\Users\\Jiahui\\repos\\ccsm\\.tmp-whisper-dl\\extracted')"
```
Expected: an `extracted/` (possibly with a `Release/` subdir) containing `whisper-cli.exe` and several `.dll`.

- [ ] **Step 3: Locate the exe and copy exe + DLLs into resources/whisper-bin**

Run:
```bash
mkdir -p C:/Users/Jiahui/repos/ccsm/resources/whisper-bin
SRC=$(dirname "$(find C:/Users/Jiahui/repos/ccsm/.tmp-whisper-dl/extracted -name whisper-cli.exe | head -1)")
cp "$SRC/whisper-cli.exe" C:/Users/Jiahui/repos/ccsm/resources/whisper-bin/
cp "$SRC"/*.dll C:/Users/Jiahui/repos/ccsm/resources/whisper-bin/
ls -la C:/Users/Jiahui/repos/ccsm/resources/whisper-bin/
```
Expected: `whisper-cli.exe` plus several `.dll` listed. Total ~10–15 MB.

- [ ] **Step 4: Smoke-test the binary reports AVX2 and transcribes**

Run (uses the base model already at `resources/models/ggml-base.bin`; generate a 1 s silence wav inline is not enough, so just verify it loads and prints build flags via `--help` exit 0):
```bash
C:/Users/Jiahui/repos/ccsm/resources/whisper-bin/whisper-cli.exe --help >/dev/null 2>&1 && echo "EXE OK exit $?"
```
Expected: `EXE OK exit 0`. If it fails with a missing-DLL error, copy the named DLL from `$SRC` and retry.

- [ ] **Step 5: Clean the download dir and commit the binary**

Run:
```bash
rm -rf C:/Users/Jiahui/repos/ccsm/.tmp-whisper-dl
cd C:/Users/Jiahui/repos/ccsm
git add resources/whisper-bin/
git commit -m "feat(voice): bundle AVX2 whisper-cli.exe + DLLs (whisper.cpp v1.8.5)"
```

---

## Task 1: Pure WAV encoder

**Files:**
- Create: `electron/voice/wavEncoder.ts`
- Test: `electron/voice/__tests__/wavEncoder.test.ts`

`encodeWav` writes a canonical 44-byte WAV header + PCM data. 16 kHz mono 16-bit. Float samples are clamped to [-1, 1] then scaled to int16.

- [ ] **Step 1: Write the failing test**

Create `electron/voice/__tests__/wavEncoder.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { encodeWav } from '../wavEncoder';

describe('encodeWav', () => {
  it('writes a canonical 16kHz mono 16-bit WAV header and data', () => {
    const pcm = new Float32Array([0, 0.5, -0.5, 1, -1]);
    const buf = encodeWav(pcm, 16000);

    // header fields
    expect(buf.toString('ascii', 0, 4)).toBe('RIFF');
    expect(buf.toString('ascii', 8, 12)).toBe('WAVE');
    expect(buf.toString('ascii', 12, 16)).toBe('fmt ');
    expect(buf.readUInt32LE(16)).toBe(16); // fmt chunk size
    expect(buf.readUInt16LE(20)).toBe(1); // PCM
    expect(buf.readUInt16LE(22)).toBe(1); // mono
    expect(buf.readUInt32LE(24)).toBe(16000); // sample rate
    expect(buf.readUInt16LE(34)).toBe(16); // bits per sample
    expect(buf.toString('ascii', 36, 40)).toBe('data');

    // data length = samples * 2 bytes
    expect(buf.readUInt32LE(40)).toBe(pcm.length * 2);
    expect(buf.length).toBe(44 + pcm.length * 2);

    // RIFF chunk size = file length - 8
    expect(buf.readUInt32LE(4)).toBe(buf.length - 8);

    // sample scaling: 0 -> 0, 1 -> 32767, -1 -> -32768
    expect(buf.readInt16LE(44)).toBe(0);
    expect(buf.readInt16LE(44 + 6)).toBe(32767); // 4th sample = 1.0
    expect(buf.readInt16LE(44 + 8)).toBe(-32768); // 5th sample = -1.0
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run electron/voice/__tests__/wavEncoder.test.ts`
Expected: FAIL — `Cannot find module '../wavEncoder'`.

- [ ] **Step 3: Write minimal implementation**

Create `electron/voice/wavEncoder.ts`:
```ts
export function encodeWav(pcm: Float32Array, sampleRate = 16000): Buffer {
  const dataLength = pcm.length * 2;
  const buf = Buffer.alloc(44 + dataLength);

  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataLength, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16); // PCM fmt chunk size
  buf.writeUInt16LE(1, 20); // audio format = PCM
  buf.writeUInt16LE(1, 22); // channels = mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate = rate * blockAlign
  buf.writeUInt16LE(2, 32); // block align = channels * bytesPerSample
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataLength, 40);

  for (let i = 0; i < pcm.length; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]));
    buf.writeInt16LE(s < 0 ? s * 0x8000 : s * 0x7fff, 44 + i * 2);
  }
  return buf;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run electron/voice/__tests__/wavEncoder.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
cd C:/Users/Jiahui/repos/ccsm
git add electron/voice/wavEncoder.ts electron/voice/__tests__/wavEncoder.test.ts
git commit -m "feat(voice): pure Float32->16-bit PCM WAV encoder"
```

---

## Task 2: whisper-cli spawn wrapper

**Files:**
- Create: `electron/voice/whisperCli.ts`
- Test: covered indirectly via transcriber mocks in Task 3 (spawn wrapper is thin; no standalone test to avoid spawning a real process in CI)

`runWhisperCli` owns the subprocess lifecycle only: build args, spawn, collect stdout/stderr, resolve on exit. No path resolution, no parsing — those belong to the orchestrator.

- [ ] **Step 1: Write the implementation**

Create `electron/voice/whisperCli.ts`:
```ts
import { spawn } from 'child_process';

export interface WhisperCliArgs {
  binPath: string;
  modelPath: string;
  wavPath: string;
  threads: number;
}

export interface WhisperCliResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function runWhisperCli(args: WhisperCliArgs): Promise<WhisperCliResult> {
  const { binPath, modelPath, wavPath, threads } = args;
  return new Promise((resolve, reject) => {
    const child = spawn(
      binPath,
      [
        '-m', modelPath,
        '-f', wavPath,
        '-t', String(threads),
        '-bo', '1',
        '-bs', '1',
        '-np',
        '-nt',
      ],
      { windowsHide: true },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}
```

- [ ] **Step 2: Typecheck**

Run: `cd C:/Users/Jiahui/repos/ccsm && npx tsc --noEmit -p tsconfig.electron.json`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
cd C:/Users/Jiahui/repos/ccsm
git add electron/voice/whisperCli.ts
git commit -m "feat(voice): child_process.spawn wrapper for whisper-cli"
```

---

## Task 3: Rewrite the orchestrator + its tests

**Files:**
- Modify: `electron/voice/transcriber.ts` (full rewrite of `transcribe`, add `resolveBinPath`, switch `MODEL_FILENAME` to base)
- Modify: `electron/voice/__tests__/transcriber.test.ts` (5 cases, mock `whisperCli` + `fs` + `os`)

- [ ] **Step 1: Rewrite the test for the new backend**

Replace the entire contents of `electron/voice/__tests__/transcriber.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({
  app: { getAppPath: () => '/repo' },
}));

describe('resolveModelPath / resolveBinPath', () => {
  beforeEach(() => vi.resetModules());

  it('resolves repo-local base model path in dev', async () => {
    const { resolveModelPath } = await import('../transcriber');
    expect(resolveModelPath().replace(/\\/g, '/')).toContain(
      'resources/models/ggml-base.bin',
    );
  });

  it('resolves repo-local whisper-cli path in dev', async () => {
    const { resolveBinPath } = await import('../transcriber');
    expect(resolveBinPath().replace(/\\/g, '/')).toContain(
      'resources/whisper-bin/whisper-cli.exe',
    );
  });
});

describe('transcribe', () => {
  beforeEach(() => vi.resetModules());

  function mockFs(opts: { modelExists: boolean; binExists: boolean }) {
    vi.doMock('fs', () => ({
      existsSync: (p: string) => {
        const s = String(p).replace(/\\/g, '/');
        if (s.includes('ggml-base.bin')) return opts.modelExists;
        if (s.includes('whisper-cli.exe')) return opts.binExists;
        return false;
      },
      writeFileSync: vi.fn(),
      unlinkSync: vi.fn(),
    }));
  }

  it('returns no-model when the model file is missing', async () => {
    mockFs({ modelExists: false, binExists: true });
    const { transcribe } = await import('../transcriber');
    expect(await transcribe(new Float32Array(16000))).toEqual({
      ok: false,
      error: 'no-model',
    });
  });

  it('returns no-model when the binary is missing', async () => {
    mockFs({ modelExists: true, binExists: false });
    const { transcribe } = await import('../transcriber');
    expect(await transcribe(new Float32Array(16000))).toEqual({
      ok: false,
      error: 'no-model',
    });
  });

  it('returns ok with trimmed text on success', async () => {
    mockFs({ modelExists: true, binExists: true });
    vi.doMock('../whisperCli', () => ({
      runWhisperCli: vi
        .fn()
        .mockResolvedValue({ code: 0, stdout: '  Hello world  \n', stderr: '' }),
    }));
    const { transcribe } = await import('../transcriber');
    expect(await transcribe(new Float32Array(16000))).toEqual({
      ok: true,
      text: 'Hello world',
    });
  });

  it('returns transcribe-failed on non-zero exit', async () => {
    mockFs({ modelExists: true, binExists: true });
    vi.doMock('../whisperCli', () => ({
      runWhisperCli: vi
        .fn()
        .mockResolvedValue({ code: 1, stdout: '', stderr: 'boom' }),
    }));
    const { transcribe } = await import('../transcriber');
    expect(await transcribe(new Float32Array(16000))).toEqual({
      ok: false,
      error: 'transcribe-failed',
    });
  });

  it('returns empty when stdout is blank after trim', async () => {
    mockFs({ modelExists: true, binExists: true });
    vi.doMock('../whisperCli', () => ({
      runWhisperCli: vi
        .fn()
        .mockResolvedValue({ code: 0, stdout: '   \n', stderr: '' }),
    }));
    const { transcribe } = await import('../transcriber');
    expect(await transcribe(new Float32Array(16000))).toEqual({
      ok: false,
      error: 'empty',
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd C:/Users/Jiahui/repos/ccsm && npx vitest run electron/voice/__tests__/transcriber.test.ts`
Expected: FAIL — `resolveBinPath` not exported / smart-whisper assertions gone.

- [ ] **Step 3: Rewrite the orchestrator**

Replace the entire contents of `electron/voice/transcriber.ts`:
```ts
import { app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import type { VoiceResult } from './voiceTypes';
import { runWhisperCli } from './whisperCli';
import { encodeWav } from './wavEncoder';

const MODEL_FILENAME = 'ggml-base.bin';
const BIN_FILENAME = 'whisper-cli.exe';

export function resolveModelPath(): string {
  const packaged = path.join(process.resourcesPath ?? '', 'models', MODEL_FILENAME);
  if (process.resourcesPath && fs.existsSync(packaged)) return packaged;
  return path.join(app.getAppPath(), 'resources', 'models', MODEL_FILENAME);
}

export function resolveBinPath(): string {
  const packaged = path.join(process.resourcesPath ?? '', 'whisper-bin', BIN_FILENAME);
  if (process.resourcesPath && fs.existsSync(packaged)) return packaged;
  return path.join(app.getAppPath(), 'resources', 'whisper-bin', BIN_FILENAME);
}

export async function transcribe(pcm: Float32Array): Promise<VoiceResult> {
  const modelPath = resolveModelPath();
  if (!fs.existsSync(modelPath)) return { ok: false, error: 'no-model' };
  const binPath = resolveBinPath();
  if (!fs.existsSync(binPath)) return { ok: false, error: 'no-model' };

  const wavPath = path.join(
    os.tmpdir(),
    `ccsm-voice-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`,
  );
  try {
    fs.writeFileSync(wavPath, encodeWav(pcm, 16000));
    const threads = Math.max(1, os.cpus().length - 2);
    const { code, stdout } = await runWhisperCli({
      binPath,
      modelPath,
      wavPath,
      threads,
    });
    if (code !== 0) return { ok: false, error: 'transcribe-failed' };
    const text = stdout.trim();
    if (!text) return { ok: false, error: 'empty' };
    return { ok: true, text };
  } catch {
    return { ok: false, error: 'transcribe-failed' };
  } finally {
    try {
      fs.unlinkSync(wavPath);
    } catch {
      /* best-effort temp cleanup */
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd C:/Users/Jiahui/repos/ccsm && npx vitest run electron/voice/__tests__/transcriber.test.ts`
Expected: PASS (7 tests: 2 resolve + 5 transcribe).

- [ ] **Step 5: Commit**

```bash
cd C:/Users/Jiahui/repos/ccsm
git add electron/voice/transcriber.ts electron/voice/__tests__/transcriber.test.ts
git commit -m "feat(voice): rewrite transcriber to use whisper-cli subprocess"
```

---

## Task 4: Packaging — bundle binary, drop smart-whisper, switch model to base

**Files:**
- Modify: `package.json` (`extraResources`, `asarUnpack`, `dependencies`)
- Modify: `scripts/fetch-whisper-model.mjs` (`small` → `base`)

- [ ] **Step 1: Add whisper-bin to extraResources and remove smart-whisper from asarUnpack**

In `package.json`, change the `build.asarUnpack` array to drop the smart-whisper line:
```json
    "asarUnpack": [
      "**/node_modules/better-sqlite3/**",
      "**/node_modules/node-pty/**"
    ],
```
And change `build.extraResources` to add the binary dir:
```json
    "extraResources": [
      {
        "from": "resources/models",
        "to": "models",
        "filter": ["*.bin"]
      },
      {
        "from": "resources/whisper-bin",
        "to": "whisper-bin"
      }
    ],
```

- [ ] **Step 2: Remove the smart-whisper dependency**

Run:
```bash
cd C:/Users/Jiahui/repos/ccsm
env -u https_proxy -u HTTPS_PROXY -u http_proxy -u HTTP_PROXY -u ALL_PROXY -u all_proxy \
  npm uninstall smart-whisper
```
Expected: `smart-whisper` removed from `package.json` dependencies and from `node_modules`. If the registry is unreachable, edit `package.json` to delete the `"smart-whisper": "^0.8.1",` line manually and run `npm install` later; note it in the PR.

- [ ] **Step 3: Switch the fetch script to the base model**

In `scripts/fetch-whisper-model.mjs`, replace every `ggml-small.bin` with `ggml-base.bin`. Concretely:
- Line 2 comment: `Downloads ggml-base.bin into resources/models/ ...`
- `MODEL_URL`: `'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin'`
- `dest`: `join(__dirname, '..', 'resources', 'models', 'ggml-base.bin')`

- [ ] **Step 4: Typecheck, lint, and full test suite**

Run:
```bash
cd C:/Users/Jiahui/repos/ccsm
npm run typecheck && npm run lint && npm test
```
Expected: all pass, lint `--max-warnings 0` clean. The voice e2e harness (`scripts/harness-e2e-voice-input.mjs`) stubs the IPC handler with canned text, so it needs no change and stays green.

- [ ] **Step 5: Commit**

```bash
cd C:/Users/Jiahui/repos/ccsm
git add package.json package-lock.json scripts/fetch-whisper-model.mjs
git commit -m "build(voice): bundle whisper-bin, drop smart-whisper, default to base model"
```

---

## Task 5: Real-machine validation + open PR

**Files:** none (validation + PR)

- [ ] **Step 1: Build and run the app, exercise the mic**

Run: `npm run dev`, click the terminal-panel mic button, speak a sentence, confirm the transcript pastes into the active pty and latency is sub-second. If you cannot drive the UI, say so explicitly rather than claiming success.

- [ ] **Step 2: Push the branch and open the PR (do NOT merge)**

Per the strict review→CI→merge workflow, push and open a PR targeting `main`; do not merge or bypass CI.
```bash
cd C:/Users/Jiahui/repos/ccsm
git push -u origin feat/voice-whisper-cli-backend
env -u https_proxy -u HTTPS_PROXY -u http_proxy -u HTTP_PROXY -u ALL_PROXY -u all_proxy \
  gh pr create --base main --title "feat(voice): AVX2 whisper-cli subprocess backend (13s -> sub-second)" --body "$(cat <<'EOF'
## Summary
- Replace smart-whisper scalar N-API binding (no AVX2/BLAS on Windows, ~15x slower) with the official AVX2 `whisper-cli.exe` run as a subprocess. Measured 0.88s vs 13s for 6.6s audio, base model, 14 threads on i5-13400.
- Three-file split: pure `wavEncoder`, `spawn` wrapper `whisperCli`, rewritten `transcriber`. The `transcribe(pcm)` seam is unchanged, so IPC/preload/renderer need no changes.
- Bundle `whisper-cli.exe` + DLLs (~15MB) under `resources/whisper-bin/` via extraResources; drop smart-whisper from deps and asarUnpack.
- Fold in the small->base model switch from PR #1440 (do not merge #1440 separately).

## Test plan
- [ ] `npm run typecheck` clean
- [ ] `npm run lint` clean (--max-warnings 0)
- [ ] `npm test` green (wavEncoder + transcriber units)
- [ ] voice e2e harness green (unchanged — stubs IPC)
- [ ] manual: mic in dev pastes transcript, sub-second latency

Closes the latency goal that PR #1440 only partially addressed.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: Report the PR URL and the open question on PR #1440 to the user**

Tell the user (in Chinese): the new PR URL, that #1440 should be closed in favor of this (its model decision is folded in, its sampling change is obsolete), and CI status — without merging anything.

---

## Self-Review

**Spec coverage:** problem/baseline → Task 0 binary + Task 3 backend; data flow (encodeWav → temp wav → spawn → trim → unlink) → Tasks 1–3; 3-component split → Tasks 1/2/3; distribution (extraResources, drop smart-whisper, model→base) → Tasks 0/4; error mapping (no-model×2 / transcribe-failed / empty / ok) → Task 3 five tests; testing (wavEncoder unit, transcriber 5-case, e2e unchanged) → Tasks 1/3/4; risks (temp leak via finally-unlink + random name) → Task 3. All covered.

**Placeholder scan:** every code/file step shows full content; no TBD/TODO. Task 2 intentionally has no standalone test (documented why: avoids spawning a real process in CI; it's covered via transcriber mocks).

**Type consistency:** `WhisperCliResult { code, stdout, stderr }` defined in Task 2, consumed in Task 3 (`{ code, stdout }`). `resolveBinPath` / `resolveModelPath` names consistent across Task 3 impl and tests. `encodeWav(pcm, 16000)` signature consistent Task 1 ↔ Task 3. `VoiceResult` union unchanged, matches all five returns.
