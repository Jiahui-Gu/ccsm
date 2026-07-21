import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const mobileCss = readFileSync(resolve(process.cwd(), 'src/mobile/mobile.css'), 'utf8');

describe('mobile shell CSS', () => {
  it('visually distinguishes an exited-session banner from transport warnings', () => {
    expect(mobileCss).toMatch(
      /\.phone-banner--exited\s*\{[^}]*color:\s*var\(--ccsm-error\)[^}]*\}/s,
    );
  });
});
