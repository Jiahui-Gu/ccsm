#!/usr/bin/env node
// Thin launcher so `npx ccsm` resolves to the compiled daemon entry.
import('../dist/index.mjs').catch((err) => {
  console.error('[ccsm] launcher failed:', err);
  process.exit(1);
});
