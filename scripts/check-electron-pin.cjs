#!/usr/bin/env node
/**
 * T61 (#1018) — Electron pin drift guard.
 *
 * Fails (exit 1) if package.json devDependencies.electron uses a caret (^) or
 * tilde (~) range. Electron must be pinned to an EXACT version per frag-11
 * §11.5 — minor Electron bumps shift installer size by ~3 MB, so the version
 * is the source of truth that the size-budget CI guard (T58 / #1015) is
 * calibrated against.
 *
 * Also cross-checks installer/electron-baseline.json electronVersion matches
 * package.json so a manual bump in one without the other is caught early.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PKG_PATH = path.join(ROOT, 'package.json');
const BASELINE_PATH = path.join(ROOT, 'installer', 'electron-baseline.json');

function fail(msg) {
  process.stderr.write(`[check-electron-pin] FAIL: ${msg}\n`);
  process.exit(1);
}

function ok(msg) {
  process.stdout.write(`[check-electron-pin] OK: ${msg}\n`);
}

const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
const declared = pkg.devDependencies && pkg.devDependencies.electron;

if (!declared) {
  fail('package.json devDependencies.electron is missing.');
}

if (/^[\^~]/.test(declared) || /\s|\|\||\sx\s|\.x$/.test(declared)) {
  fail(
    `package.json devDependencies.electron must be an EXACT version, got "${declared}". ` +
    `Drop the leading ^/~ (frag-11 §11.5 — installer size budget is calibrated against this exact version).`
  );
}

if (!/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(declared)) {
  fail(`package.json devDependencies.electron "${declared}" is not a valid exact semver.`);
}

ok(`package.json electron pinned exact: ${declared}`);

if (fs.existsSync(BASELINE_PATH)) {
  const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
  if (baseline.electronVersion !== declared) {
    fail(
      `installer/electron-baseline.json electronVersion="${baseline.electronVersion}" ` +
      `does not match package.json electron="${declared}". ` +
      `Bump both together (and recompute size baseline per frag-11 §11.5(6)).`
    );
  }
  ok(`installer/electron-baseline.json matches: ${baseline.electronVersion} (abi ${baseline.nodeAbi})`);
} else {
  ok('installer/electron-baseline.json absent — skipping cross-check (T61 not yet landed).');
}

process.exit(0);
