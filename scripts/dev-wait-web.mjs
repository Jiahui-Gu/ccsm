#!/usr/bin/env node
// Tiny wait-on shim for `npm run dev:app`. Resolves the dev server port
// from CCSM_DEV_PORT (set by scripts/dev.mjs) and falls back to 4100 for
// the standalone-debug case. Kept as a separate script so the
// package.json invocation stays readable and doesn't have to fight
// cross-shell quoting of `node -e`.

import waitOn from 'wait-on';

const port = process.env.CCSM_DEV_PORT || '4100';
const url = `http://localhost:${port}`;

try {
  await waitOn({ resources: [url], timeout: 60_000 });
  process.exit(0);
} catch (e) {
  console.error(`[dev-wait-web] timed out waiting for ${url}:`, e?.message ?? e);
  process.exit(1);
}
