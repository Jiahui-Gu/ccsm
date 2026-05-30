import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
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
