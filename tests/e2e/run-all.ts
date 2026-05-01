#!/usr/bin/env tsx
/**
 * tests/e2e/run-all.ts — discover and run all L8 e2e probes serially.
 *
 * Discovery: every `*.probe.test.ts` file under `tests/e2e/probes/` (recursive).
 * Execution: serial, each probe via `tsx <path>` in a child process.
 * Output: one line per probe (PASS/FAIL + ms); summary footer with counts.
 * Exit: 0 if all pass (or zero probes discovered), 1 if any probe fails.
 */

import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(__dirname, 'probes');
const REPO = join(__dirname, '..', '..');

function discover(dir: string): string[] {
  let out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      out = out.concat(discover(full));
    } else if (st.isFile() && name.endsWith('.probe.test.ts')) {
      out.push(full);
    }
  }
  return out.sort();
}

function runOne(probe: string): { ok: boolean; ms: number; code: number } {
  const start = Date.now();
  const res = spawnSync('npx', ['tsx', probe], {
    cwd: REPO,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  const ms = Date.now() - start;
  const code = res.status ?? 1;
  return { ok: code === 0, ms, code };
}

function main(): void {
  const probes = discover(ROOT);
  if (probes.length === 0) {
    console.log('[e2e] 0 probes discovered under tests/e2e/probes/');
    process.exit(0);
  }
  console.log(`[e2e] discovered ${probes.length} probe(s)`);
  const results: Array<{ probe: string; ok: boolean; ms: number; code: number }> = [];
  for (const probe of probes) {
    const rel = relative(REPO, probe).replaceAll('\\', '/');
    console.log(`[e2e] >>> ${rel}`);
    const r = runOne(probe);
    results.push({ probe: rel, ...r });
    console.log(`[e2e] <<< ${rel} ${r.ok ? 'PASS' : `FAIL (exit ${r.code})`} ${r.ms}ms`);
  }
  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  console.log('');
  console.log('[e2e] === summary ===');
  for (const r of results) {
    console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.ms.toString().padStart(6)}ms  ${r.probe}`);
  }
  console.log(`[e2e] total=${results.length} passed=${passed} failed=${failed}`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
