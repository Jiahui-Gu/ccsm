import { readFileSync } from 'node:fs';

import { expect, test } from 'vitest';

test('routes static assets through the Worker security-header path', () => {
  const config = JSON.parse(
    readFileSync(new URL('../../cloudflare/wrangler.jsonc', import.meta.url), 'utf8'),
  );

  expect(config.assets.run_worker_first).toBe(true);
});
