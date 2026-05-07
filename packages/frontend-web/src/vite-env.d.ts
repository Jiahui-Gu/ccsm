/// <reference types="vite/client" />

// Task #712 (S2-T3): build-time injected daemon base URL.
// Cloudflare Pages build pipeline sets this; daemon-embedded build leaves
// it undefined and the SPA falls back to `window.location.origin`.
interface ImportMetaEnv {
  readonly VITE_DAEMON_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
