// Augments the `Cloudflare.Env` interface that `cloudflare:test`'s `env` is
// typed against (vitest-pool-workers >= 0.13 / vitest v4 switched `env` from
// the old `ProvidedEnv` to `Cloudflare.Env`). This makes the worker's bindings
// — including the PAIRING Durable Object namespace — visible to the integration
// tests. Runtime values come from vitest.config.ts -> miniflare bindings plus
// the DO binding declared in wrangler.toml.
import type { Env as WorkerEnv } from "../src/lib/config";

declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {}
  }
}

export {};
