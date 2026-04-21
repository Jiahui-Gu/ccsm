/**
 * Live discovery probe.
 *
 * Exercises the tiered DiscoveryPipeline against a real endpoint the developer
 * points at via env vars. Skips gracefully (exit 0) when env is unset so CI
 * doesn't fail for devs without credentials.
 *
 *   AGENTORY_BASE_URL=https://... AGENTORY_AUTH_TOKEN=sk-... \
 *     node scripts/probe-discovery-pipeline.mjs
 *
 * Runs entirely in Node — no Electron, no DB. Asserts ≥1 model is discovered.
 */

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const baseUrl = process.env.AGENTORY_BASE_URL;
const apiKey = process.env.AGENTORY_AUTH_TOKEN ?? process.env.AGENTORY_API_KEY;

if (!baseUrl || !apiKey) {
  console.log(
    '[probe-discovery-pipeline] AGENTORY_BASE_URL / AGENTORY_AUTH_TOKEN not set — skipping live probe.'
  );
  process.exit(0);
}

const here = path.dirname(fileURLToPath(import.meta.url));

let DiscoveryPipeline;
try {
  const require = createRequire(import.meta.url);
  const distPath = path.join(here, '..', 'dist', 'electron', 'endpoints-discovery.js');
  const mod = require(distPath);
  DiscoveryPipeline = mod.DiscoveryPipeline;
} catch {
  console.log('[probe-discovery-pipeline] dist not found, compiling TS...');
  const r = spawnSync(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['tsc', '-p', 'tsconfig.electron.json'],
    { stdio: 'inherit' }
  );
  if (r.status !== 0) {
    console.error('[probe-discovery-pipeline] TypeScript compile failed.');
    process.exit(1);
  }
  const require = createRequire(import.meta.url);
  const distPath = path.join(here, '..', 'dist', 'electron', 'endpoints-discovery.js');
  const mod = require(distPath);
  DiscoveryPipeline = mod.DiscoveryPipeline;
}

if (!DiscoveryPipeline) {
  console.error('[probe-discovery-pipeline] DiscoveryPipeline not exported.');
  process.exit(1);
}

const pipeline = new DiscoveryPipeline();
const started = Date.now();
const result = await pipeline.discover({ baseUrl, apiKey });
const elapsed = Date.now() - started;

console.log(JSON.stringify(
  {
    ok: result.ok,
    status: result.status,
    error: result.error,
    detectedKind: result.detectedKind,
    modelCount: result.models?.length ?? 0,
    sourceStats: result.sourceStats,
    elapsedMs: elapsed,
    sampleIds: (result.models ?? []).slice(0, 10).map((m) => m.id),
  },
  null,
  2
));

if (!result.ok) {
  console.error('[probe-discovery-pipeline] discovery returned ok:false');
  process.exit(2);
}
const count = result.models?.length ?? 0;
if (count < 1) {
  console.error('[probe-discovery-pipeline] discovery returned 0 models — expected ≥1');
  process.exit(3);
}
console.log(`[probe-discovery-pipeline] OK — ${count} models discovered in ${elapsed}ms`);
