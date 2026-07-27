import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

describe('phone page CSP', () => {
  it('allows data JPEG mirror frames', () => {
    const html = readFileSync(path.resolve('src/phone.html'), 'utf8');
    const policy = html.match(/Content-Security-Policy"[\s\S]*?content="([^"]+)"/)?.[1] ?? '';

    expect(policy).toMatch(/img-src[^;]*\bdata:/);
  });
});
