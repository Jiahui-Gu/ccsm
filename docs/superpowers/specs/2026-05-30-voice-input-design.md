# Voice Input — Design Spec

**Date:** 2026-05-30
**Status:** Approved (design phase)
**Branch:** `feat/voice-input`

## Goal

Let the user talk to a Claude Code session instead of typing. Click a mic
button in the terminal pane, speak, click again to stop; the spoken words are
transcribed locally and injected into the active session's input line — **not
auto-submitted**, so the user reviews and presses Enter themselves.

Motivation: the user dictates prompts to Claude frequently and finds repeatedly
pressing Win+H awkward. A first-class in-app button removes that friction.

## Locked decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Engine | Local Whisper via **`smart-whisper`** (whisper.cpp N-API binding) | MIT, free, offline, strong Chinese. True in-process N-API addon that accepts an in-memory `Float32Array @ 16 kHz` — no temp wav files. Reuses the existing native-module pipeline (`node-pty`/`better-sqlite3`). NOTE: `nodejs-whisper` was rejected — it only accepts a file path and shells out, forcing a temp-wav round trip. |
| Model | `ggml-small.bin` (~466 MB) | Best accuracy/speed tradeoff for dictation; CPU real-time-ish. |
| Model distribution | **Bundled in the installer** | Works offline immediately; installer grows ~466 MB (accepted). |
| Recording | **Toggle** (click to start, click to stop) | User choice. |
| Transcription | **Whole-clip, one shot** (non-streaming) | "Keep it simple, prove the chain first." Streaming is out of scope. |
| Post-transcription | **Inject only, do NOT submit** | Misrecognitions must not auto-send. |
| Injection point | Reuse `pasteIntoActivePty` (`src/terminal/paste.ts`) | Same validated path as manual paste; bracketed-paste handling + no-Enter for free. |
| Trigger UI | Mic button in the terminal corner | Visible state; discoverable. |

## Architecture

Recording happens in the **renderer** (Web Audio is the natural way to reach the
mic). Transcription happens in the **main process** (native module + model file
live there). Audio crosses one IPC hop; text comes back over another.

```
[MicButton] --click--> [recorder]
   renderer              renderer (Web Audio → 16kHz mono PCM)
      |                     |
      |                     v  stop → Float32 PCM
      |              window.ccsm.voice.transcribe(pcm)
      |                     |  (IPC: voice:transcribe)
      |                     v
      |              [transcriber]  main process
      |                     |  smart-whisper + ggml-small.bin
      |                     v
      |              text: string  (IPC reply)
      |                     |
      v                     v
[inject] --reuse--> pasteIntoActivePty(getTopShell()?.term, sid, text)
   renderer                 |
                            v
                    active session PTY  (no Enter)
```

### Renderer ↔ Main boundary

Per `CLAUDE.md`: `src/` must NOT import `electron/`. The renderer reaches main
only through `window.ccsm`. A new preload bridge `electron/preload/bridges/
ccsmVoice.ts` exposes:

```ts
window.ccsm.voice.transcribe(pcm: Float32Array): Promise<VoiceResult>
```

where

```ts
type VoiceResult =
  | { ok: true; text: string }
  | { ok: false; error: 'no-model' | 'transcribe-failed' | 'empty' };
```

Type added to `src/global.d.ts` alongside the existing `window.ccsm` surface.

## Components (one purpose each)

| Unit | Process | Responsibility | Depends on |
|------|---------|----------------|------------|
| `MicButton` (`src/components/voice/MicButton.tsx`) | renderer | Render state (idle / recording / transcribing / error); dispatch toggle; placed in `TerminalPane`. | recorder hook, i18n |
| `useVoiceRecorder` (`src/components/voice/useVoiceRecorder.ts`) | renderer | Own the state machine + Web Audio capture; produce 16 kHz mono `Float32Array`; call `transcribe`; hand text to injector. | Web Audio, `window.ccsm.voice`, `pasteIntoActivePty` |
| `ccsmVoice` bridge (`electron/preload/bridges/ccsmVoice.ts`) | preload | Expose `voice.transcribe` over `ipcRenderer.invoke('voice:transcribe', pcm)`. | ipcRenderer |
| `voiceIpc` (`electron/ipc/voiceIpc.ts`) | main | Handle `voice:transcribe`; validate payload; call transcriber; return `VoiceResult`. | transcriber |
| `transcriber` (`electron/voice/transcriber.ts`) | main | Lazy-load `smart-whisper` + resolve model path; run transcription; map failures to `VoiceResult` errors. | smart-whisper, model file, `app.getAppPath` |

## State machine (recorder)

```
idle --click--> recording --click--> transcribing --(text)--> inject --> idle
                    |                      |
                    | mic-denied           | error
                    v                      v
                  error -----(click)-----> idle
```

- `idle`: mic icon, default color.
- `recording`: icon pulses / turns red; second click stops capture.
- `transcribing`: spinner; button disabled (no concurrent transcribe).
- `error`: brief red flash + tooltip; next click resets to idle.

Only one recording at a time, app-wide. The button always targets the **active**
session (`sessionId` prop of the hosting `TerminalPane`), matching how paste
resolves its target via `getTopShell()`.

## Audio format

Web Audio captures at the device rate (typically 44.1/48 kHz). The recorder
downmixes to mono and resamples to **16 kHz Float32 PCM** in the renderer (via
an `OfflineAudioContext` render pass) so main receives exactly what whisper.cpp
expects — no resampling dependency in main. Empty/near-silent captures
(< ~300 ms of audio) short-circuit to `{ ok:false, error:'empty' }` without
invoking Whisper.

## Model packaging

- Model file `ggml-small.bin` stored at `resources/models/ggml-small.bin`
  (NOT inside the asar — it's data, loaded by path).
- `electron-builder` config gains an `extraResources` entry copying it to the
  packaged app's `resources/`. The transcriber resolves it via
  `process.resourcesPath` in production and a repo-local path in dev.
- The 466 MB binary ships **inside the installer** but is NOT committed to git
  history. A `scripts/fetch-whisper-model.mjs` helper downloads it into
  `resources/models/` (run once locally before `npm run dev`, and in CI before
  `make`). `.gitignore` excludes `resources/models/*.bin`. So: bundled in the
  shipped app = yes; tracked in the repo = no.
- `smart-whisper` itself is a native module → add to the `postinstall` rebuild
  list and `asarUnpack`, exactly like `node-pty`/`better-sqlite3`.

## Error handling

| Failure | Where caught | User sees |
|---------|--------------|-----------|
| Mic permission denied | recorder (getUserMedia reject) | error state + tooltip "Microphone access denied" |
| Model file missing | transcriber → `error:'no-model'` | error state + tooltip "Voice model not installed" |
| Whisper throws | transcriber → `error:'transcribe-failed'` | error state + tooltip "Transcription failed" |
| Empty / silent clip | recorder (pre-check) or `error:'empty'` | silently return to idle (no scary error) |
| No active session | recorder | button disabled when no session focused |

All IPC payloads are untrusted by convention: `voiceIpc` validates that the
payload is a Float32Array of bounded length before handing it to Whisper, and
rejects oversized buffers (cap ~10 min of 16 kHz audio) to avoid a memory DoS.

## i18n

New keys under a `voice` namespace in both `src/i18n/locales/en.ts` and
`zh.ts`: `start`, `stop`, `transcribing`, `errorMic`, `errorNoModel`,
`errorFailed`, button `aria-label`s. Follows the existing `cwdPopover` pattern.

## Testing

- **Unit (vitest):**
  - `transcriber`: model-path resolution (dev vs packaged), error mapping for
    missing model / thrown Whisper (Whisper itself mocked — no real model in
    unit tests).
  - `voiceIpc`: payload validation (non-Float32, oversized, empty) → correct
    `VoiceResult` without calling the transcriber.
  - recorder state machine: pure reducer tested through the
    idle→recording→transcribing→idle transitions with a faked recorder.
  - PCM resample helper: a known-rate buffer resamples to 16 kHz with expected
    length.
- **No real-audio E2E** in this iteration (CI has no mic; real-model transcribe
  is slow). Manual verification: run `npm run dev`, speak, confirm text lands in
  the active session without an Enter.

## Out of scope (YAGNI)

- Streaming / partial transcription.
- Push-to-talk (hold-to-speak) — toggle only for now.
- Global keyboard shortcut — button only for now.
- Auto-submit option.
- Model selection UI / multiple models — `small` is fixed.
- On-demand model download — bundled only.
- Language auto-detect tuning — rely on Whisper's default multilingual model.

## Verification before "done"

Per `CLAUDE.md`: `npm run typecheck`, `npm run lint`, `npm test` must pass, plus
the manual dev-run check above. Native rebuild (`npm install`) must succeed with
`smart-whisper` added.
