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
