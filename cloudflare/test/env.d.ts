// Augments cloudflare:test's `env` (ProvidedEnv) with this worker's bindings so
// the integration tests typecheck. The runtime values come from
// vitest.config.ts -> miniflare bindings + the DO binding in wrangler.toml.
import type { Env } from "../src/lib/config";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}
