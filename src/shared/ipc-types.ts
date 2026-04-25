// Canonical IPC type definitions shared by the Electron main/preload layer
// and the React renderer. Keeping a single source here avoids the previous
// drift where preload.ts, src/global.d.ts, and src/stores/store.ts each
// declared structurally-identical copies of these shapes.
//
// Rules:
//   - Types here must be pure structural (no runtime imports, no values)
//     so both the CommonJS electron tsconfig and the ESM renderer tsconfig
//     can pull them in without pulling in DOM/Node globals.
//   - No enum/const literals that aren't already string-union primitives.
//   - Keep IPC channel return shapes here; keep IPC channel *names* in the
//     modules that use them (channel names aren't types).

export type ModelSource =
  | 'settings'
  | 'env'
  | 'manual'
  | 'cli-picker'
  | 'env-override'
  | 'fallback';

export interface DiscoveredModel {
  id: string;
  source: ModelSource;
}

export interface ConnectionInfo {
  baseUrl: string | null;
  model: string | null;
  hasAuthToken: boolean;
}

export type OpenSettingsResult = { ok: true } | { ok: false; error: string };

export interface CliInstallHints {
  os: string;
  arch: string;
  commands: {
    native?: string;
    packageManager?: string;
    npm: string;
  };
  docsUrl: string;
}

export type CliRetryResult =
  | { found: true; path: string; version: string | null }
  | { found: false; searchedPaths: string[] };

export type CliSetBinaryResult =
  | { ok: true; version: string | null }
  | { ok: false; error: string };

export type CommandSource = 'user' | 'project' | 'plugin' | 'skill' | 'agent';

export interface LoadedCommand {
  name: string;
  description?: string;
  argumentHint?: string;
  source: CommandSource;
  pluginId?: string;
}
