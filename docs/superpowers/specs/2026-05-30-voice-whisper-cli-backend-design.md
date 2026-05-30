# Voice Transcription Backend: AVX2 whisper-cli Subprocess

**Date:** 2026-05-30
**Status:** Design — pending user review

## Problem

CCSM's voice dictation transcribes via `smart-whisper` (a whisper.cpp N-API
binding). On Windows, `smart-whisper`'s build script (`dist/build.js`,
`infer_backend()`) falls through to an empty `default` case for `win32`: it
passes **no** `GGML_AVX2 / GGML_FMA / GGML_F16C` compile defines and links
**no** BLAS. The prebuilt binary therefore runs whisper.cpp's **scalar
fallback** kernels — on a CPU with AVX2 this wastes ~8–16x of available
throughput.

Measured on an i5-13400 (10 cores / 16 threads, AVX2), 6.6 s of speech, base
model, greedy, 14 threads:

| Backend | Time | Real-time factor |
|---|---|---|
| Official whisper.cpp BLAS/AVX2 binary | **0.88 s** | 0.13x |
| smart-whisper scalar (current) | 13 s | 2.0x |
| smart-whisper scalar, small+beam+4thr (original) | 94 s | 14x |

13 s is still unusable for dictation. The ceiling is fixed by smart-whisper's
scalar binary; no amount of model/sampling tuning escapes it. The official
AVX2 binary is ~15x faster on the identical machine, model, and audio.

## Goal

Replace the transcription backend with the official AVX2 `whisper-cli.exe`
invoked as a subprocess, achieving sub-second latency, while keeping the
`transcribe(pcm)` interface — and therefore the renderer, IPC, and preload
layers — unchanged.

## Non-goals (YAGNI)

- macOS / Linux binary distribution. CCSM voice is Windows-x64-only today.
  On non-Windows or when the binary is absent, transcription degrades
  gracefully to the existing `no-model` result.
- Auto-download / UI guidance for a missing binary or model (deferred earlier
  by the user; out of scope here).
- Streaming / partial transcription. One-shot dictation only, as today.

## Architecture

The single seam is `electron/voice/transcriber.ts`'s
`transcribe(pcm: Float32Array): Promise<VoiceResult>`. Its signature and
return type (`VoiceResult` from `voiceTypes.ts`) are unchanged, so
`electron/ipc/voiceIpc.ts`, `electron/preload/bridges/ccsmVoice.ts`, and the
renderer require **no** changes.

### Data flow (all in the main process)

```
Float32Array (16 kHz mono)
  → encodeWav() → 16 kHz mono 16-bit PCM WAV Buffer
  → write to os.tmpdir()/ccsm-voice-<rand>.wav
  → spawn whisper-cli.exe -m <model> -f <tmp.wav> -t <cores-2> -bo 1 -bs 1 -np -nt
  → on exit 0: stdout is the plain transcript (no timestamps, no logs)
  → trim → { ok:true, text } (or { ok:false, error:'empty' } if blank)
  → finally: unlink the temp wav
```

`whisper-cli` accepts only file paths (wav/mp3/flac/ogg) — **not** stdin raw
PCM (verified empirically). A temp WAV is therefore the only viable input
path. The flags `-np` (no prints) and `-nt` (no timestamps) make stdout the
clean transcript text, avoiding a JSON sidecar file that would need cleanup.

### Components (three small, single-responsibility files)

1. **`electron/voice/wavEncoder.ts`** — `encodeWav(pcm: Float32Array,
   sampleRate = 16000): Buffer`. Pure function: Float32 samples → 16-bit PCM
   WAV (44-byte header + data). No I/O, no dependencies; trivially unit-tested.

2. **`electron/voice/whisperCli.ts`** —
   `runWhisperCli(args: { wavPath: string; modelPath: string; binPath: string;
   threads: number }): Promise<{ code: number; stdout: string; stderr: string }>`.
   Wraps `child_process.spawn`; owns subprocess lifecycle only; mockable in
   tests.

3. **`electron/voice/transcriber.ts`** (rewritten) — orchestration:
   `resolveModelPath()` + `resolveBinPath()` + write temp wav + call
   `runWhisperCli` + parse + cleanup + map to `VoiceResult`.

`resolveBinPath()` mirrors the existing `resolveModelPath()`:

```ts
const BIN_FILENAME = 'whisper-cli.exe';
export function resolveBinPath(): string {
  const packaged = path.join(process.resourcesPath ?? '', 'whisper-bin', BIN_FILENAME);
  if (process.resourcesPath && fs.existsSync(packaged)) return packaged;
  return path.join(app.getAppPath(), 'resources', 'whisper-bin', BIN_FILENAME);
}
```

### Distribution & packaging

- Commit `whisper-cli.exe` and its dependency DLLs (~15 MB total) into
  `resources/whisper-bin/`. These come from the official whisper.cpp release
  asset `whisper-blas-bin-x64.zip` (tag v1.8.5), which reports
  `AVX=1 AVX2=1 F16C=1 FMA=1` at runtime.
- electron-builder `extraResources`: add
  `{ "from": "resources/whisper-bin", "to": "whisper-bin" }`.
- Remove the `smart-whisper` entry from `asarUnpack`; uninstall the
  `smart-whisper` dependency from `package.json`.
- Switch the default model `small` → `base`: `MODEL_FILENAME` in
  `transcriber.ts` and the URL + `dest` in `scripts/fetch-whisper-model.mjs`.
  This folds in the model decision from the still-open PR #1440 (which targets
  the smart-whisper backend this work removes). `base` is the dictation sweet
  spot: accuracy ≈ `small`, half the disk (148 MB vs 487 MB), and fastest on
  AVX2 (0.88 s vs ~2–3 s for `small`). PR #1440's `strategy:0` sampling change
  is dropped — it was a smart-whisper API call, gone with the binding. Do NOT
  merge #1440 separately; merging then immediately rewriting it is churn.

Rationale for bundling (vs. fetch-on-demand): consistent with the existing
`resources/models` + extraResources pattern; 15 MB is negligible beside the
148 MB model; the user's network reaches GitHub releases slowly/unreliably, so
fetch-on-demand would stall dev and CI; bundling gives offline, install-ready
dev. Binary is version-pinned in git for reproducibility.

### Error mapping

| Condition | VoiceResult |
|---|---|
| Model file missing | `{ ok:false, error:'no-model' }` |
| whisper-cli.exe missing (incl. non-Windows) | `{ ok:false, error:'no-model' }` |
| Subprocess exit code ≠ 0 | `{ ok:false, error:'transcribe-failed' }` |
| stdout empty after trim | `{ ok:false, error:'empty' }` |
| Success | `{ ok:true, text }` |

`no-model` is reused for a missing binary: both mean "the local environment
isn't set up," and the renderer already renders that state. `VoiceResult`'s
error union is unchanged.

### whisper-cli invocation

```
whisper-cli.exe -m <modelPath> -f <wavPath> -t <max(1, cores-2)> -bo 1 -bs 1 -np -nt
```

`-bo 1 -bs 1` = greedy (best-of 1, beam-size 1); `-np` = no prints; `-nt` =
no timestamps. Threads = `os.cpus().length - 2` (matches the prior tuning).

## Testing

- **wavEncoder unit test:** known Float32 input → assert WAV header fields
  (RIFF/`WAVE`/`fmt `/sample rate 16000/16-bit/mono) and data byte length.
- **transcriber unit test:** mock `whisperCli.runWhisperCli` and `fs`; cover
  five cases — no-model, missing binary, success, non-zero exit, empty stdout
  — mirroring the existing five-test structure.
- **e2e:** the harness replaces the `voice:transcribe` IPC handler with canned
  text and never exercises real `transcribe()`, so it needs **no** changes;
  CI stays green.
- **Real-machine validation (already run):** base + greedy + 14 threads, 6.6 s
  SAPI speech → 0.88 s, transcript exactly correct.

## Risks

- **Binary/whisper.cpp version coupling.** Mitigated: base model format and
  whisper-cli CLI interface are stable across releases; the binary is pinned in
  git, so the version is controlled and reproducible.
- **Temp-wav leakage.** Random filename + `finally` unlink; avoids the kind of
  cross-run residue seen in the e2e clipboard leak incident.
- **Antivirus/SmartScreen on a bundled exe.** The exe ships inside the app's
  resources and is launched by the app, not downloaded at runtime; same trust
  posture as the rest of the packaged app.
