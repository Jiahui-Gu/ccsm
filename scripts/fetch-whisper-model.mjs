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
