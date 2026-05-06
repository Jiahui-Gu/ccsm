// Smoke test for the e2e rig itself (Task #664).
//
// Deliberately does NOT spawn the daemon and does NOT touch the frontend —
// T3 (daemon) and T5 (frontend) may not yet be merged on `main` when this
// rig lands. We just navigate to about:blank, snap, and assert the helper
// produced a non-empty PNG + a TXT containing the URL.
//
// T7 owns the real product e2e covering the cold-start happy path.

import { test, expect } from '@playwright/test';
import { snap } from '../fixtures/screenshot.ts';
import { statSync, readFileSync } from 'node:fs';

test('rig smoke — about:blank produces png + txt', async ({ page }, testInfo) => {
  await page.goto('about:blank');

  const { pngPath, txtPath } = await snap(page, testInfo, 'about-blank');

  const pngStat = statSync(pngPath);
  expect(pngStat.size).toBeGreaterThan(100);

  const txt = readFileSync(txtPath, 'utf8');
  expect(txt).toContain('about:blank');
  expect(txt).toContain('url:');
  expect(txt).toContain('visible-text:');
});
