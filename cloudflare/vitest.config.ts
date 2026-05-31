import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// vitest-pool-workers >= 0.13 (vitest v4) replaced the `defineWorkersConfig`
// + `test.poolOptions.workers` shape with a Vite plugin (`cloudflareTest`).
// We are on this line because it is the first release whose isolated-storage
// teardown tolerates the WAL sidecar files (".sqlite-wal"/".sqlite-shm") that
// modern workerd's SQLite-backed Durable Objects leave in the persist dir.
// Earlier (vitest v3) pool versions asserted every persisted file ends in
// ".sqlite" and crashed on the sidecars ("Expected .sqlite, got …-shm").
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.test.toml" },
      miniflare: {
        bindings: {
          OAUTH_REDIRECT_URI:
            "https://ccsm-worker.jiahuigu.workers.dev/auth/github/callback",
          SESSION_TTL_SECONDS: "900",
          TURN_TTL_SECONDS: "600",
          ROOM_TTL_SECONDS: "60",
          TURN_URLS:
            "turn:turn.cloudflare.com:3478?transport=udp,turns:turn.cloudflare.com:5349?transport=tcp",
          STUN_URLS: "stun:stun.cloudflare.com:3478",
          GITHUB_OAUTH_CLIENT_ID: "test-client-id",
          GITHUB_OAUTH_CLIENT_SECRET: "test-client-secret",
          JWT_SIGNING_KEY: "test-jwt-signing-key-0123456789",
        },
      },
    }),
  ],
});
