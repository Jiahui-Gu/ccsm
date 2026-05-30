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
