# Voice Input Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a mic button to CCSM's terminal pane that records the user's speech, transcribes it locally with Whisper, and injects the text into the active session's input line without auto-submitting.

**Architecture:** Recording runs in the renderer (Web Audio → 16 kHz mono `Float32Array`). The PCM crosses one IPC hop to the main process, where a lazily-loaded `smart-whisper` N-API addon transcribes against a bundled `ggml-small.bin`. The returned text is injected via the existing `pasteIntoActivePty` path (bracketed-paste, no Enter). A `useVoiceRecorder` hook owns the state machine; a `MicButton` renders state and lives in `TerminalPane`.

**Tech Stack:** Electron 41, React 18, TypeScript 5.7, `smart-whisper` (whisper.cpp N-API binding), Web Audio / `OfflineAudioContext`, vitest, electron-builder.

**Design spec:** `docs/superpowers/specs/2026-05-30-voice-input-design.md`

**Verified `smart-whisper` API (empirical, 2026-05-30):**
```ts
import { Whisper } from 'smart-whisper';
const whisper = new Whisper(modelPath, { gpu: false });
const task = await whisper.transcribe(pcm /* Float32Array @ 16kHz mono */, { language: 'auto' });
const result = await task.result; // TranscribeResult[] — simple shape: { from: number; to: number; text: string }[]
await whisper.free();
```

**Branch:** `feat/voice-input` (already checked out; spec committed as `1b9c207`).

**Working norms (from CLAUDE.md + user memory):**
- npm only. Node >= 22. Renderer (`src/`) MUST NOT import from `electron/`.
- After each task: stage only the files that task touched, commit with a clear message.
- Final ship is strictly PR → CI green → merge via PR. **Never** push straight to `main`, never bypass CI.
- Before declaring done: `npm run typecheck`, `npm run lint`, `npm test` all pass.

---

## File Structure

**New files:**
- `electron/voice/transcriber.ts` — main: lazy-load `smart-whisper`, resolve model path, run transcription, map failures to `VoiceResult`.
- `electron/voice/__tests__/transcriber.test.ts` — unit tests (whisper mocked).
- `electron/ipc/voiceIpc.ts` — main: `registerVoiceIpc({ipcMain})`, validate payload, call transcriber.
- `electron/ipc/__tests__/voiceIpc.test.ts` — payload-validation unit tests.
- `electron/preload/bridges/ccsmVoice.ts` — preload: expose `window.ccsmVoice.transcribe`.
- `src/voice/resample.ts` — renderer: downmix + resample to 16 kHz mono `Float32Array`.
- `src/voice/__tests__/resample.test.ts` — unit test for the resampler.
- `src/voice/recorderMachine.ts` — renderer: pure state-machine reducer.
- `src/voice/__tests__/recorderMachine.test.ts` — reducer transition tests.
- `src/components/voice/useVoiceRecorder.ts` — renderer: Web Audio capture + machine + transcribe + inject.
- `src/components/voice/MicButton.tsx` — renderer: button rendering state, placed in `TerminalPane`.
- `scripts/fetch-whisper-model.mjs` — downloads `ggml-small.bin` into `resources/models/`.

**Modified files:**
- `src/voice/types.ts` — NEW shared `VoiceResult` type (imported by both renderer via re-export and main). NOTE: `src/` can't import `electron/`, and `electron/` importing `src/` is also avoided. So `VoiceResult` is defined ONCE in `electron/voice/voiceTypes.ts` and DUPLICATED structurally in `src/global.d.ts` (the existing convention — `UpdateStatus` is duplicated the same way between `electron/preload/bridges/ccsmCore.ts` and `src/global.d.ts`).
- `electron/preload/index.ts` — register the new voice bridge.
- `electron/main.ts` — call `registerVoiceIpc({ipcMain})`.
- `src/global.d.ts` — add `window.ccsmVoice` typing + `VoiceResult` union.
- `src/components/TerminalPane.tsx` — mount `<MicButton>`.
- `src/i18n/locales/en.ts` + `src/i18n/locales/zh.ts` — `voice` namespace keys.
- `package.json` — `smart-whisper` dependency, `asarUnpack` entry, `extraResources` for the model.
- `scripts/postinstall.mjs` — rebuild `smart-whisper` for the Electron ABI.
- `.gitignore` — exclude `resources/models/*.bin`.

---

## Task 1: Add `smart-whisper` dependency and native rebuild wiring

**Files:**
- Modify: `package.json` (dependencies, `build.asarUnpack`)
- Modify: `scripts/postinstall.mjs:113-114`

- [ ] **Step 1: Add the dependency**

Run:
```bash
npm install smart-whisper
```
Expected: `smart-whisper` appears under `dependencies` in `package.json`; `postinstall` runs (the `smart-whisper` rebuild line isn't there yet, so it only rebuilds sqlite + node-pty — that's fine for now).

- [ ] **Step 2: Add `smart-whisper` to the native rebuild list**

In `scripts/postinstall.mjs`, find:
```js
runRebuild('better-sqlite3', { allowFailure: false });
runRebuild('node-pty', { allowFailure: true });
```
Change to:
```js
runRebuild('better-sqlite3', { allowFailure: false });
runRebuild('node-pty', { allowFailure: true });
runRebuild('smart-whisper', { allowFailure: false });
```

Rationale: `smart-whisper` is a true N-API addon and the app cannot transcribe without it, so a rebuild failure must be fatal (like `better-sqlite3`, unlike `node-pty` which has a prebuild fallback).

- [ ] **Step 3: Add `smart-whisper` to `asarUnpack`**

In `package.json`, find:
```json
"asarUnpack": [
  "**/node_modules/better-sqlite3/**",
  "**/node_modules/node-pty/**"
],
```
Change to:
```json
"asarUnpack": [
  "**/node_modules/better-sqlite3/**",
  "**/node_modules/node-pty/**",
  "**/node_modules/smart-whisper/**"
],
```

Rationale: native `.node` binaries can't be loaded from inside the asar archive; they must be unpacked, exactly like the other two native modules.

- [ ] **Step 4: Rebuild to verify the native addon compiles**

Run:
```bash
npm install
```
Expected: `[postinstall] Rebuilding smart-whisper for Electron ABI...` prints and the command exits 0. If it fails on a missing toolchain, that's an environment problem (VS Build Tools / Python) — fix the environment, do not make the rebuild `allowFailure`.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json scripts/postinstall.mjs
git commit -m "build(voice): add smart-whisper dep + native rebuild/unpack wiring"
```

---

## Task 2: Shared `VoiceResult` type (main side)

**Files:**
- Create: `electron/voice/voiceTypes.ts`

- [ ] **Step 1: Write the type**

Create `electron/voice/voiceTypes.ts`:
```ts
// Result of a voice transcription, returned over the `voice:transcribe`
// IPC channel. Mirrored structurally in `src/global.d.ts` (the renderer
// can't import from electron/ — same convention as `UpdateStatus`).
export type VoiceResult =
  | { ok: true; text: string }
  | { ok: false; error: 'no-model' | 'transcribe-failed' | 'empty' };
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS (new file is type-only, no consumers yet).

- [ ] **Step 3: Commit**

```bash
git add electron/voice/voiceTypes.ts
git commit -m "feat(voice): add VoiceResult type"
```

---

## Task 3: Transcriber — model path resolution

**Files:**
- Create: `electron/voice/transcriber.ts`
- Test: `electron/voice/__tests__/transcriber.test.ts`

- [ ] **Step 1: Write the failing test**

Create `electron/voice/__tests__/transcriber.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// app.getAppPath / resourcesPath are read at module load via electron — mock it.
vi.mock('electron', () => ({
  app: { getAppPath: () => '/repo' },
}));

describe('resolveModelPath', () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.CCSM_FORCE_PACKAGED;
  });

  it('resolves the repo-local path in dev', async () => {
    const { resolveModelPath } = await import('../transcriber');
    // dev: process.resourcesPath points into electron's own dir, so we
    // fall back to the app path's resources/models.
    const p = resolveModelPath();
    expect(p.replace(/\\/g, '/')).toContain('resources/models/ggml-small.bin');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run electron/voice/__tests__/transcriber.test.ts`
Expected: FAIL — `Cannot find module '../transcriber'`.

- [ ] **Step 3: Write minimal implementation**

Create `electron/voice/transcriber.ts`:
```ts
import { app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import type { VoiceResult } from './voiceTypes';

const MODEL_FILENAME = 'ggml-small.bin';

// In a packaged app the model lives under `process.resourcesPath`
// (electron-builder `extraResources`). In dev it lives in the repo at
// `resources/models/`. We prefer the packaged location when the file is
// actually there, else fall back to the app path.
export function resolveModelPath(): string {
  const packaged = path.join(
    process.resourcesPath ?? '',
    'models',
    MODEL_FILENAME,
  );
  if (process.resourcesPath && fs.existsSync(packaged)) return packaged;
  return path.join(app.getAppPath(), 'resources', 'models', MODEL_FILENAME);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run electron/voice/__tests__/transcriber.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add electron/voice/transcriber.ts electron/voice/__tests__/transcriber.test.ts
git commit -m "feat(voice): transcriber model-path resolution"
```

---

## Task 4: Transcriber — transcription + error mapping

**Files:**
- Modify: `electron/voice/transcriber.ts`
- Test: `electron/voice/__tests__/transcriber.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `electron/voice/__tests__/transcriber.test.ts`:
```ts
describe('transcribe', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock('smart-whisper');
  });

  it('returns no-model when the model file is missing', async () => {
    vi.doMock('fs', () => ({ existsSync: () => false }));
    const { transcribe } = await import('../transcriber');
    const res = await transcribe(new Float32Array(16000));
    expect(res).toEqual({ ok: false, error: 'no-model' });
  });

  it('returns joined text on success', async () => {
    vi.doMock('fs', () => ({ existsSync: () => true }));
    const free = vi.fn().mockResolvedValue(undefined);
    const transcribeFn = vi.fn().mockResolvedValue({
      result: Promise.resolve([
        { from: 0, to: 1, text: ' Hello' },
        { from: 1, to: 2, text: ' world' },
      ]),
    });
    vi.doMock('smart-whisper', () => ({
      Whisper: vi.fn().mockImplementation(() => ({
        transcribe: transcribeFn,
        free,
      })),
    }));
    const { transcribe } = await import('../transcriber');
    const res = await transcribe(new Float32Array(16000));
    expect(res).toEqual({ ok: true, text: 'Hello world' });
    expect(free).toHaveBeenCalledOnce();
  });

  it('returns transcribe-failed and still frees when whisper throws', async () => {
    vi.doMock('fs', () => ({ existsSync: () => true }));
    const free = vi.fn().mockResolvedValue(undefined);
    vi.doMock('smart-whisper', () => ({
      Whisper: vi.fn().mockImplementation(() => ({
        transcribe: vi.fn().mockRejectedValue(new Error('boom')),
        free,
      })),
    }));
    const { transcribe } = await import('../transcriber');
    const res = await transcribe(new Float32Array(16000));
    expect(res).toEqual({ ok: false, error: 'transcribe-failed' });
    expect(free).toHaveBeenCalledOnce();
  });

  it('returns empty when transcription yields no text', async () => {
    vi.doMock('fs', () => ({ existsSync: () => true }));
    vi.doMock('smart-whisper', () => ({
      Whisper: vi.fn().mockImplementation(() => ({
        transcribe: vi.fn().mockResolvedValue({ result: Promise.resolve([]) }),
        free: vi.fn().mockResolvedValue(undefined),
      })),
    }));
    const { transcribe } = await import('../transcriber');
    const res = await transcribe(new Float32Array(16000));
    expect(res).toEqual({ ok: false, error: 'empty' });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run electron/voice/__tests__/transcriber.test.ts`
Expected: FAIL — `transcribe` is not exported.

- [ ] **Step 3: Write the implementation**

Append to `electron/voice/transcriber.ts`:
```ts
// Lazy-loaded so the native addon (and its model) only initialize when
// the user actually dictates — keeps cold start cheap and lets the
// renderer load even if the model is absent.
export async function transcribe(pcm: Float32Array): Promise<VoiceResult> {
  const modelPath = resolveModelPath();
  if (!fs.existsSync(modelPath)) return { ok: false, error: 'no-model' };

  const { Whisper } = await import('smart-whisper');
  const whisper = new Whisper(modelPath, { gpu: false });
  try {
    const task = await whisper.transcribe(pcm, { language: 'auto' });
    const segments = await task.result;
    const text = segments.map((s) => s.text).join('').trim();
    if (!text) return { ok: false, error: 'empty' };
    return { ok: true, text };
  } catch {
    return { ok: false, error: 'transcribe-failed' };
  } finally {
    try {
      await whisper.free();
    } catch {
      // best-effort cleanup
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run electron/voice/__tests__/transcriber.test.ts`
Expected: PASS (all 5 tests).

- [ ] **Step 5: Commit**

```bash
git add electron/voice/transcriber.ts electron/voice/__tests__/transcriber.test.ts
git commit -m "feat(voice): transcription + error mapping"
```

---

## Task 5: voiceIpc — payload validation + handler

**Files:**
- Create: `electron/ipc/voiceIpc.ts`
- Test: `electron/ipc/__tests__/voiceIpc.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `electron/ipc/__tests__/voiceIpc.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { validateVoicePayload, MAX_PCM_SAMPLES } from '../voiceIpc';

describe('validateVoicePayload', () => {
  it('accepts a bounded Float32Array', () => {
    expect(validateVoicePayload(new Float32Array(16000))).toBe(true);
  });
  it('rejects non-Float32Array', () => {
    expect(validateVoicePayload([1, 2, 3])).toBe(false);
    expect(validateVoicePayload(new Int16Array(8))).toBe(false);
    expect(validateVoicePayload(null)).toBe(false);
  });
  it('rejects empty', () => {
    expect(validateVoicePayload(new Float32Array(0))).toBe(false);
  });
  it('rejects oversized (> ~10 min @ 16kHz)', () => {
    expect(validateVoicePayload(new Float32Array(MAX_PCM_SAMPLES + 1))).toBe(false);
  });
});

describe('registerVoiceIpc', () => {
  let handler: (e: unknown, pcm: unknown) => Promise<unknown>;
  const ipcMain = {
    handle: vi.fn((_ch: string, h: typeof handler) => {
      handler = h;
    }),
  };
  beforeEach(() => vi.resetModules());

  it('short-circuits invalid payloads with empty error and never calls transcribe', async () => {
    const transcribe = vi.fn();
    vi.doMock('../../voice/transcriber', () => ({ transcribe }));
    const { registerVoiceIpc } = await import('../voiceIpc');
    registerVoiceIpc({ ipcMain: ipcMain as never });
    const res = await handler({}, new Float32Array(0));
    expect(res).toEqual({ ok: false, error: 'empty' });
    expect(transcribe).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run electron/ipc/__tests__/voiceIpc.test.ts`
Expected: FAIL — `Cannot find module '../voiceIpc'`.

- [ ] **Step 3: Write the implementation**

Create `electron/ipc/voiceIpc.ts`:
```ts
import type { IpcMain } from 'electron';
import { transcribe } from '../voice/transcriber';
import type { VoiceResult } from '../voice/voiceTypes';

// 10 minutes of 16 kHz mono audio. IPC payloads are untrusted by
// convention; cap the buffer so a hostile/buggy renderer can't OOM main
// by handing us an enormous Float32Array.
export const MAX_PCM_SAMPLES = 16000 * 60 * 10;

export function validateVoicePayload(pcm: unknown): pcm is Float32Array {
  return pcm instanceof Float32Array && pcm.length > 0 && pcm.length <= MAX_PCM_SAMPLES;
}

export interface VoiceIpcDeps {
  ipcMain: IpcMain;
}

export function registerVoiceIpc(deps: VoiceIpcDeps): void {
  const { ipcMain } = deps;
  ipcMain.handle('voice:transcribe', async (_e, pcm: unknown): Promise<VoiceResult> => {
    if (!validateVoicePayload(pcm)) return { ok: false, error: 'empty' };
    return transcribe(pcm);
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run electron/ipc/__tests__/voiceIpc.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add electron/ipc/voiceIpc.ts electron/ipc/__tests__/voiceIpc.test.ts
git commit -m "feat(voice): voiceIpc handler + payload validation"
```

---

## Task 6: Register voiceIpc in main

**Files:**
- Modify: `electron/main.ts` (import near line 89; call near line 269)

- [ ] **Step 1: Add the import**

In `electron/main.ts`, after the existing IPC imports (near line 89, alongside `registerSessionIpc`), add:
```ts
import { registerVoiceIpc } from './ipc/voiceIpc';
```

- [ ] **Step 2: Register the handler**

In `electron/main.ts`, find:
```ts
  registerUtilityIpc({ ipcMain });
```
Add directly after it:
```ts
  registerVoiceIpc({ ipcMain });
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add electron/main.ts
git commit -m "feat(voice): register voiceIpc in main"
```

---

## Task 7: Preload bridge — `window.ccsmVoice`

**Files:**
- Create: `electron/preload/bridges/ccsmVoice.ts`
- Modify: `electron/preload/index.ts`

- [ ] **Step 1: Write the bridge**

Create `electron/preload/bridges/ccsmVoice.ts`:
```ts
// `window.ccsmVoice` — speech-to-text bridge. The renderer captures mic
// audio (Web Audio), resamples to 16 kHz mono Float32 PCM, and hands it
// here; main runs smart-whisper and returns the transcript. One IPC hop
// each way. Mirrors the single-concern bridge pattern from #769.
import { contextBridge, ipcRenderer } from 'electron';

type VoiceResult =
  | { ok: true; text: string }
  | { ok: false; error: 'no-model' | 'transcribe-failed' | 'empty' };

const api = {
  transcribe: (pcm: Float32Array): Promise<VoiceResult> =>
    ipcRenderer.invoke('voice:transcribe', pcm),
};

export type CCSMVoiceAPI = typeof api;

export function installCcsmVoiceBridge(): void {
  contextBridge.exposeInMainWorld('ccsmVoice', api);
}
```

- [ ] **Step 2: Register it in the preload entry**

In `electron/preload/index.ts`, add the import alongside the others:
```ts
import { installCcsmVoiceBridge } from './bridges/ccsmVoice';
```
Add the install call after `installCcsmShellBridge();`:
```ts
installCcsmVoiceBridge();
```
Add the type re-export at the bottom:
```ts
export type { CCSMVoiceAPI } from './bridges/ccsmVoice';
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add electron/preload/bridges/ccsmVoice.ts electron/preload/index.ts
git commit -m "feat(voice): preload bridge for window.ccsmVoice"
```

---

## Task 8: Renderer type surface — `window.ccsmVoice` in global.d.ts

**Files:**
- Modify: `src/global.d.ts`

- [ ] **Step 1: Add the types**

In `src/global.d.ts`, after the `UpdateStatus` export at the top, add:
```ts
// Mirrors electron/voice/voiceTypes.ts — duplicated structurally because
// the renderer can't import from electron/ (same convention as
// UpdateStatus). Keep these two in sync.
export type VoiceResult =
  | { ok: true; text: string }
  | { ok: false; error: 'no-model' | 'transcribe-failed' | 'empty' };
```

Inside `declare global { interface Window { ... } }`, after the `ccsm?: {...}` block's closing `};`, add a sibling member:
```ts
    ccsmVoice?: {
      transcribe: (pcm: Float32Array) => Promise<VoiceResult>;
    };
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/global.d.ts
git commit -m "feat(voice): type window.ccsmVoice in renderer surface"
```

---

## Task 9: PCM resampler (renderer)

**Files:**
- Create: `src/voice/resample.ts`
- Test: `src/voice/__tests__/resample.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/voice/__tests__/resample.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { resampleTo16k } from '../resample';

describe('resampleTo16k', () => {
  it('downsamples a 48kHz buffer to the expected 16kHz length', () => {
    const input = new Float32Array(48000); // 1 second @ 48kHz
    const out = resampleTo16k(input, 48000);
    // 1 second @ 16kHz = 16000 samples (±1 for rounding)
    expect(Math.abs(out.length - 16000)).toBeLessThanOrEqual(1);
  });

  it('returns the input unchanged when already 16kHz', () => {
    const input = new Float32Array([0.1, 0.2, 0.3]);
    const out = resampleTo16k(input, 16000);
    expect(Array.from(out)).toEqual([0.1, 0.2, 0.3]);
  });

  it('preserves a constant signal value after resampling', () => {
    const input = new Float32Array(48000).fill(0.5);
    const out = resampleTo16k(input, 48000);
    // linear interpolation of a constant stays constant
    expect(out[100]).toBeCloseTo(0.5, 5);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/voice/__tests__/resample.test.ts`
Expected: FAIL — `Cannot find module '../resample'`.

- [ ] **Step 3: Write the implementation**

Create `src/voice/resample.ts`:
```ts
const TARGET_RATE = 16000;

// Linear-interpolation resample of a mono Float32 buffer to 16 kHz.
// whisper.cpp wants exactly 16 kHz mono; the mic typically runs at
// 44.1/48 kHz. This runs on the already-downmixed mono buffer captured
// by the recorder. Returns the input untouched when it's already 16 kHz.
export function resampleTo16k(input: Float32Array, inputRate: number): Float32Array {
  if (inputRate === TARGET_RATE) return input;
  const ratio = inputRate / TARGET_RATE;
  const outLength = Math.round(input.length / ratio);
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const srcPos = i * ratio;
    const i0 = Math.floor(srcPos);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const frac = srcPos - i0;
    out[i] = input[i0] * (1 - frac) + input[i1] * frac;
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/voice/__tests__/resample.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/voice/resample.ts src/voice/__tests__/resample.test.ts
git commit -m "feat(voice): 16kHz PCM resampler"
```

---

## Task 10: Recorder state machine (pure reducer)

**Files:**
- Create: `src/voice/recorderMachine.ts`
- Test: `src/voice/__tests__/recorderMachine.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/voice/__tests__/recorderMachine.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { voiceReducer, type VoiceState } from '../recorderMachine';

const idle: VoiceState = { kind: 'idle' };

describe('voiceReducer', () => {
  it('idle + START → recording', () => {
    expect(voiceReducer(idle, { type: 'START' })).toEqual({ kind: 'recording' });
  });
  it('recording + STOP → transcribing', () => {
    expect(voiceReducer({ kind: 'recording' }, { type: 'STOP' })).toEqual({
      kind: 'transcribing',
    });
  });
  it('transcribing + DONE → idle', () => {
    expect(voiceReducer({ kind: 'transcribing' }, { type: 'DONE' })).toEqual(idle);
  });
  it('transcribing + FAIL → error', () => {
    expect(voiceReducer({ kind: 'transcribing' }, { type: 'FAIL', message: 'x' })).toEqual({
      kind: 'error',
      message: 'x',
    });
  });
  it('recording + FAIL (mic denied) → error', () => {
    expect(voiceReducer({ kind: 'recording' }, { type: 'FAIL', message: 'mic' })).toEqual({
      kind: 'error',
      message: 'mic',
    });
  });
  it('error + RESET → idle', () => {
    expect(voiceReducer({ kind: 'error', message: 'x' }, { type: 'RESET' })).toEqual(idle);
  });
  it('ignores START while transcribing (no concurrent record)', () => {
    const s: VoiceState = { kind: 'transcribing' };
    expect(voiceReducer(s, { type: 'START' })).toEqual(s);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/voice/__tests__/recorderMachine.test.ts`
Expected: FAIL — `Cannot find module '../recorderMachine'`.

- [ ] **Step 3: Write the implementation**

Create `src/voice/recorderMachine.ts`:
```ts
export type VoiceState =
  | { kind: 'idle' }
  | { kind: 'recording' }
  | { kind: 'transcribing' }
  | { kind: 'error'; message: string };

export type VoiceAction =
  | { type: 'START' }
  | { type: 'STOP' }
  | { type: 'DONE' }
  | { type: 'FAIL'; message: string }
  | { type: 'RESET' };

// Pure transition function. Only one recording at a time app-wide:
// START is only honored from idle; STOP only from recording; the
// transcribing state rejects new starts so a slow transcribe can't
// overlap a fresh capture.
export function voiceReducer(state: VoiceState, action: VoiceAction): VoiceState {
  switch (action.type) {
    case 'START':
      return state.kind === 'idle' ? { kind: 'recording' } : state;
    case 'STOP':
      return state.kind === 'recording' ? { kind: 'transcribing' } : state;
    case 'DONE':
      return state.kind === 'transcribing' ? { kind: 'idle' } : state;
    case 'FAIL':
      return { kind: 'error', message: action.message };
    case 'RESET':
      return { kind: 'idle' };
    default:
      return state;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/voice/__tests__/recorderMachine.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/voice/recorderMachine.ts src/voice/__tests__/recorderMachine.test.ts
git commit -m "feat(voice): recorder state machine reducer"
```

---

## Task 11: i18n keys

**Files:**
- Modify: `src/i18n/locales/en.ts`
- Modify: `src/i18n/locales/zh.ts`

- [ ] **Step 1: Add the `voice` namespace to en.ts**

In `src/i18n/locales/en.ts`, inside the top-level `const en = { ... }` object (e.g. after the `common` block), add:
```ts
  voice: {
    start: 'Start dictation',
    stop: 'Stop dictation',
    transcribing: 'Transcribing…',
    errorMic: 'Microphone access denied',
    errorNoModel: 'Voice model not installed',
    errorFailed: 'Transcription failed',
  },
```

- [ ] **Step 2: Add the matching keys to zh.ts**

In `src/i18n/locales/zh.ts`, at the same structural position, add:
```ts
  voice: {
    start: '开始语音输入',
    stop: '停止语音输入',
    transcribing: '识别中…',
    errorMic: '麦克风访问被拒绝',
    errorNoModel: '语音模型未安装',
    errorFailed: '识别失败',
  },
```

- [ ] **Step 3: Run the parity test + typecheck**

Run: `npx vitest run tests/i18n-key-parity.test.ts && npm run typecheck`
Expected: PASS — both catalogs have identical key shape.

- [ ] **Step 4: Commit**

```bash
git add src/i18n/locales/en.ts src/i18n/locales/zh.ts
git commit -m "feat(voice): i18n keys for voice namespace"
```

---

## Task 12: `useVoiceRecorder` hook

**Files:**
- Create: `src/components/voice/useVoiceRecorder.ts`

This hook is integration glue over already-tested units (reducer, resampler, transcribe IPC, paste). No unit test — it's exercised in the manual dev run (Task 15). Keep logic thin; push anything testable into the pure modules.

- [ ] **Step 1: Write the hook**

Create `src/components/voice/useVoiceRecorder.ts`:
```ts
import { useCallback, useReducer, useRef } from 'react';
import { voiceReducer, type VoiceState } from '../../voice/recorderMachine';
import { resampleTo16k } from '../../voice/resample';
import { getTopShell } from '../../terminal/shellRegistry';
import { pasteIntoActivePty } from '../../terminal/paste';

const MIN_SAMPLES_16K = 16000 * 0.3; // ~300ms; shorter clips are treated as silence

// Owns Web Audio capture + the transcription/injection flow. The button
// targets the active session (sid passed in by the hosting TerminalPane),
// matching how paste resolves its target via getTopShell().
export function useVoiceRecorder(sid: string): {
  state: VoiceState;
  toggle: () => void;
} {
  const [state, dispatch] = useReducer(voiceReducer, { kind: 'idle' });
  const mediaRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const chunksRef = useRef<Float32Array[]>([]);
  const processorRef = useRef<ScriptProcessorNode | null>(null);

  const cleanup = useCallback(() => {
    processorRef.current?.disconnect();
    processorRef.current = null;
    ctxRef.current?.close().catch(() => {});
    ctxRef.current = null;
    mediaRef.current?.getTracks().forEach((t) => t.stop());
    mediaRef.current = null;
    chunksRef.current = [];
  }, []);

  const stop = useCallback(async () => {
    const ctx = ctxRef.current;
    const inputRate = ctx?.sampleRate ?? 48000;
    // concatenate captured mono chunks
    const total = chunksRef.current.reduce((n, c) => n + c.length, 0);
    const merged = new Float32Array(total);
    let off = 0;
    for (const c of chunksRef.current) {
      merged.set(c, off);
      off += c.length;
    }
    cleanup();
    dispatch({ type: 'STOP' });

    const pcm = resampleTo16k(merged, inputRate);
    if (pcm.length < MIN_SAMPLES_16K) {
      dispatch({ type: 'DONE' }); // silent / too short — back to idle quietly
      return;
    }
    try {
      const res = await window.ccsmVoice?.transcribe(pcm);
      if (!res || !res.ok) {
        if (res && res.error === 'empty') {
          dispatch({ type: 'DONE' });
          return;
        }
        dispatch({ type: 'FAIL', message: res ? res.error : 'transcribe-failed' });
        return;
      }
      await pasteIntoActivePty(() => getTopShell()?.term, sid, res.text);
      dispatch({ type: 'DONE' });
    } catch {
      dispatch({ type: 'FAIL', message: 'transcribe-failed' });
    }
  }, [cleanup, sid]);

  const start = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaRef.current = stream;
      const ctx = new AudioContext();
      ctxRef.current = ctx;
      const source = ctx.createMediaStreamSource(stream);
      const processor = ctx.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;
      chunksRef.current = [];
      processor.onaudioprocess = (e) => {
        // copy: the underlying buffer is reused by the audio thread
        chunksRef.current.push(new Float32Array(e.inputBuffer.getChannelData(0)));
      };
      source.connect(processor);
      processor.connect(ctx.destination);
      dispatch({ type: 'START' });
    } catch {
      cleanup();
      dispatch({ type: 'FAIL', message: 'mic' });
    }
  }, [cleanup]);

  const toggle = useCallback(() => {
    if (state.kind === 'idle') void start();
    else if (state.kind === 'recording') void stop();
    else if (state.kind === 'error') dispatch({ type: 'RESET' });
    // transcribing: ignore (button disabled anyway)
  }, [state.kind, start, stop]);

  return { state, toggle };
}
```

- [ ] **Step 2: Typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: PASS. (If lint flags `createScriptProcessor` as deprecated, that's acceptable — it's the simplest reliable PCM capture; suppress with a single inline `eslint-disable-next-line` comment naming the rule if and only if lint actually errors.)

- [ ] **Step 3: Commit**

```bash
git add src/components/voice/useVoiceRecorder.ts
git commit -m "feat(voice): useVoiceRecorder capture/transcribe/inject hook"
```

---

## Task 13: `MicButton` component

**Files:**
- Create: `src/components/voice/MicButton.tsx`

- [ ] **Step 1: Write the component**

Create `src/components/voice/MicButton.tsx`:
```tsx
import { Mic, MicOff, Loader2 } from 'lucide-react';
import { useTranslation } from '../../i18n/useTranslation';
import { useVoiceRecorder } from './useVoiceRecorder';

// Mic toggle in the terminal corner. Targets the active session (sid).
// Idle → click to record; recording → click to stop; transcribing →
// disabled spinner; error → red, click resets. Injection (no Enter) is
// handled by the hook via pasteIntoActivePty.
export function MicButton({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation();
  const { state, toggle } = useVoiceRecorder(sessionId);

  const label =
    state.kind === 'recording'
      ? t('voice.stop')
      : state.kind === 'transcribing'
        ? t('voice.transcribing')
        : state.kind === 'error'
          ? state.message === 'mic'
            ? t('voice.errorMic')
            : state.message === 'no-model'
              ? t('voice.errorNoModel')
              : t('voice.errorFailed')
          : t('voice.start');

  const color =
    state.kind === 'recording'
      ? 'text-red-400'
      : state.kind === 'error'
        ? 'text-red-500'
        : 'text-neutral-300';

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={state.kind === 'transcribing'}
      aria-label={label}
      title={label}
      className={`absolute top-2 right-2 z-10 rounded p-1.5 bg-black/40 hover:bg-black/70 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-neutral-400 disabled:opacity-60 ${color}`}
    >
      {state.kind === 'transcribing' ? (
        <Loader2 className="w-4 h-4 animate-spin" />
      ) : state.kind === 'error' ? (
        <MicOff className="w-4 h-4" />
      ) : (
        <Mic className={`w-4 h-4 ${state.kind === 'recording' ? 'animate-pulse' : ''}`} />
      )}
    </button>
  );
}

export default MicButton;
```

NOTE: `Mic`, `MicOff`, `Loader2` are all exported by `lucide-react` (already a dependency). Verify the import resolves during typecheck.

- [ ] **Step 2: Typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/components/voice/MicButton.tsx
git commit -m "feat(voice): MicButton component"
```

---

## Task 14: Mount MicButton in TerminalPane

**Files:**
- Modify: `src/components/TerminalPane.tsx`

- [ ] **Step 1: Add the import**

In `src/components/TerminalPane.tsx`, after the `ScrollToBottomButton` import (line 8), add:
```ts
import { MicButton } from './voice/MicButton';
```

- [ ] **Step 2: Render the button**

In the returned JSX, inside the host `<div>`, after the `<Overlay .../>` line and before the `ScrollToBottomButton` conditional, add the button so it shows only when the terminal is ready:
```tsx
      {state.kind === 'ready' ? <MicButton sessionId={sessionId} /> : null}
```
Resulting block:
```tsx
      <Overlay state={state} onRetry={onRetry} t={t} />
      {state.kind === 'ready' ? <MicButton sessionId={sessionId} /> : null}
      {state.kind === 'ready' ? (
        <ScrollToBottomButton onClick={scrollToBottom} />
      ) : null}
```

- [ ] **Step 3: Typecheck + lint + full test run**

Run: `npm run typecheck && npm run lint && npm test`
Expected: PASS (all suites).

- [ ] **Step 4: Commit**

```bash
git add src/components/TerminalPane.tsx
git commit -m "feat(voice): mount MicButton in TerminalPane"
```

---

## Task 15: Model packaging — fetch script, gitignore, extraResources

**Files:**
- Create: `scripts/fetch-whisper-model.mjs`
- Modify: `.gitignore`
- Modify: `package.json` (`build.extraResources`)

- [ ] **Step 1: Write the fetch script**

Create `scripts/fetch-whisper-model.mjs`:
```js
#!/usr/bin/env node
// Downloads ggml-small.bin into resources/models/ so dev runs and CI
// packaging have the Whisper model without committing a 466 MB binary to
// git. Idempotent: skips the download when the file already exists.
import { existsSync, mkdirSync, createWriteStream } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';

const MODEL_URL =
  'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dest = join(__dirname, '..', 'resources', 'models', 'ggml-small.bin');

if (existsSync(dest)) {
  console.log(`[fetch-whisper-model] already present: ${dest}`);
  process.exit(0);
}
mkdirSync(dirname(dest), { recursive: true });
console.log(`[fetch-whisper-model] downloading ${MODEL_URL}`);
const res = await fetch(MODEL_URL);
if (!res.ok || !res.body) {
  console.error(`[fetch-whisper-model] download failed: HTTP ${res.status}`);
  process.exit(1);
}
await pipeline(res.body, createWriteStream(dest));
console.log(`[fetch-whisper-model] saved to ${dest}`);
```

- [ ] **Step 2: Run the fetch (downloads ~466 MB — needs network)**

Run:
```bash
node scripts/fetch-whisper-model.mjs
```
Expected: file appears at `resources/models/ggml-small.bin`. If offline, this task's dev verification (Task 16) can't run; note it and continue with code review.

- [ ] **Step 3: Gitignore the model binary**

In `.gitignore`, add:
```
resources/models/*.bin
```

- [ ] **Step 4: Add `extraResources` to electron-builder**

In `package.json`'s `build` block, after `"asarUnpack": [...]`, add:
```json
    "extraResources": [
      {
        "from": "resources/models",
        "to": "models",
        "filter": ["*.bin"]
      }
    ],
```

This copies the model to `<app>/resources/models/ggml-small.bin`, which `resolveModelPath()` (Task 3) reads via `process.resourcesPath`.

- [ ] **Step 5: Typecheck (config sanity) + verify git ignores the binary**

Run:
```bash
git status --porcelain resources/models/ggml-small.bin
```
Expected: NO output (the `.bin` is ignored).

- [ ] **Step 6: Commit**

```bash
git add scripts/fetch-whisper-model.mjs .gitignore package.json
git commit -m "build(voice): model fetch script + extraResources packaging"
```

---

## Task 16: Manual dev-run verification

**Files:** none (verification only)

- [ ] **Step 1: Ensure the model is present**

Run: `node scripts/fetch-whisper-model.mjs`
Expected: `already present` or a successful download.

- [ ] **Step 2: Launch the app**

Run: `npm run dev`
Expected: app window opens, a session terminal is visible with a mic button in the top-right corner.

- [ ] **Step 3: Golden path**

Click the mic, speak a short sentence in English, click again. Expected: button shows recording (pulsing red) then transcribing (spinner), then the transcript appears on the active session's input line **without** an Enter being sent. Confirm you can edit the text and press Enter yourself.

- [ ] **Step 4: Chinese path**

Repeat speaking Chinese. Expected: Chinese transcript injected (smart-whisper multilingual `language:'auto'`).

- [ ] **Step 5: Edge cases**

- Click mic, immediately click stop (no speech) → returns quietly to idle, no error toast.
- Deny mic permission (OS dialog) → button goes to error state with the mic tooltip; clicking again resets to idle.

- [ ] **Step 6: Regression check**

Paste (Ctrl+V) and right-click paste still work in the terminal; the mic button doesn't intercept terminal focus or scrolling.

If any UI behavior can't be verified (e.g. no mic in the environment), state that explicitly rather than claiming success.

---

## Task 17: Final verification + PR

**Files:** none (ship)

- [ ] **Step 1: Full gate**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all PASS.

- [ ] **Step 2: Push the branch**

```bash
git push -u origin feat/voice-input
```

- [ ] **Step 3: Open the PR**

```bash
gh pr create --base main --title "feat: local voice input (mic → Whisper → inject)" --body "$(cat <<'EOF'
## Summary
- Mic button in the terminal pane: toggle to record, speak, toggle to stop.
- Local transcription via smart-whisper + bundled ggml-small.bin (offline, multilingual).
- Transcript injected into the active session via the existing paste path — NOT auto-submitted.

## Test plan
- [ ] npm run typecheck / lint / test green
- [ ] Manual dev run: English dictation injects text, no Enter
- [ ] Manual dev run: Chinese dictation injects text
- [ ] Silent/short clip returns to idle quietly
- [ ] Mic-denied shows error state, resets on next click
- [ ] Paste (Ctrl+V / right-click) unaffected

Design spec: docs/superpowers/specs/2026-05-30-voice-input-design.md
Plan: docs/superpowers/plans/2026-05-30-voice-input.md

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 4: Wait for CI, merge via PR**

Wait for required checks to go green on the PR. **Do NOT** push to `main` directly or bypass checks. When green, merge via `gh pr merge` (ask the user for squash/merge/rebase preference if unsure).

---

## Notes on risk / open items

- **`createScriptProcessor` deprecation:** chosen over `AudioWorklet` for simplicity ("prove the chain first" — spec). If lint hard-errors, suppress with a single targeted `eslint-disable-next-line` rather than restructuring; an AudioWorklet migration is a separate follow-up.
- **Model download host:** the fetch script points at the canonical `huggingface.co/ggerganov/whisper.cpp` mirror. If that URL 404s at execution time, find the current ggml-small.bin URL and update the script — do not commit the binary to git.
- **CI packaging:** CI must run `node scripts/fetch-whisper-model.mjs` before `make`/packaging so `extraResources` finds the model. Wiring that into the CI workflow is part of Task 17's PR if the workflow file gates packaging; otherwise it's a follow-up noted on the PR.
