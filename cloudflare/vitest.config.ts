import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          // Pin the *test* runtime to a compatibility date before workerd made
          // the SQLite storage backend the default for Durable Objects
          // (2024-09-23). The SQLite backend opens its DB in WAL mode, leaving
          // ".sqlite-wal"/".sqlite-shm" sidecars in the DO persist dir; the
          // pool's isolated-storage push/pop asserts every file there ends in
          // ".sqlite" and throws "Expected .sqlite, got …-shm". The classic
          // (blob/KV) backend used at this date writes a single ".sqlite"
          // metadata file with no sidecars, so isolated storage works. This
          // only affects the miniflare test harness — production deploy keeps
          // wrangler.toml's compatibility_date. The worker relies only on
          // crypto.subtle, WebSocketPair, and fetch/Response, all available at
          // this date with nodejs_compat.
          compatibilityDate: "2024-01-01",
          compatibilityFlags: ["nodejs_compat"],
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
      },
    },
  },
});
