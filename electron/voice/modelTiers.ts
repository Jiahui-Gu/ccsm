// Whisper model tier catalog. Models are NOT bundled in the installer
// (they were ignored by .gitignore + the fetch script was never wired into
// packaging, which shipped an empty models/ dir → "model not installed").
// They are downloaded on demand at runtime into userData/models/ instead.
//
// Six main tiers, no .en / quantized variants. The renderer mirrors
// `VoiceTier` / `VOICE_TIERS` structurally in src/global.d.ts (renderer can't
// import from electron/ — same convention as VoiceResult / UpdateStatus).

export type VoiceTier =
  | 'tiny'
  | 'base'
  | 'small'
  | 'medium'
  | 'large-v3'
  | 'large-v3-turbo';

export const VOICE_TIERS: readonly VoiceTier[] = [
  'tiny',
  'base',
  'small',
  'medium',
  'large-v3',
  'large-v3-turbo',
] as const;

export const DEFAULT_TIER: VoiceTier = 'base';

// Tiers whose pure-CPU transcription is slow and whose download is large
// (GB-scale). The settings UI warns before picking one of these.
export const HEAVY_TIERS: readonly VoiceTier[] = ['medium', 'large-v3', 'large-v3-turbo'] as const;

export function tierFilename(tier: VoiceTier): string {
  return `ggml-${tier}.bin`;
}

export function isVoiceTier(x: unknown): x is VoiceTier {
  return typeof x === 'string' && (VOICE_TIERS as readonly string[]).includes(x);
}

// Display-only sizes (measured via HEAD Content-Length, 2026-06-03). Used to
// show "~141 MB" before download and to render progress when the live
// Content-Length is missing. NOT a validation gate: HuggingFace re-uploads
// models on `main` (large-v3 changed format historically) and mirrors lag, so
// an exact byte match would false-flag a correctly downloaded file. Download
// integrity is checked against THIS response's Content-Length in the
// downloader; corrupt-but-right-size content is caught by whisper-cli failing
// to load (→ transcribe-failed).
export const TIER_SIZE_BYTES: Record<VoiceTier, number> = {
  tiny: 77691713,
  base: 147951465,
  small: 487601967,
  medium: 1533763059,
  'large-v3': 3095033483,
  'large-v3-turbo': 1624555275,
};

const HF_PRIMARY = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';
const HF_MIRROR = 'https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main';

// Primary (HuggingFace) first, mirror (hf-mirror.com, same path layout) as
// fallback — HF is frequently unreachable from mainland China.
export function buildDownloadUrls(tier: VoiceTier): string[] {
  const f = tierFilename(tier);
  return [`${HF_PRIMARY}/${f}`, `${HF_MIRROR}/${f}`];
}
