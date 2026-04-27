#!/usr/bin/env node
// Regression guard: ensure electron-builder packages the Windows toast native
// modules. Without these in build.files (an explicit allowlist), the installer
// silently ships without electron-windows-notifications + its @nodert peers,
// making toast notifications no-op at runtime.
//
// See: feedback PR #415 shipped without these because asarUnpack only controls
// asar vs asar.unpacked layout, not whether files are copied at all.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgPath = resolve(__dirname, '..', 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));

const REQUIRED_RUNTIME_DEPS = [
  'electron-windows-notifications',
  '@nodert-win10-au/windows.applicationmodel',
  '@nodert-win10-au/windows.data.xml.dom',
  '@nodert-win10-au/windows.foundation',
  '@nodert-win10-au/windows.ui.notifications',
  '@nodert-win10-au/windows.ui.startscreen',
];

const REQUIRED_FILES_PATTERNS = [
  'node_modules/electron-windows-notifications/**',
  'node_modules/@nodert-win10-au/**',
];

const failures = [];

const allDeps = {
  ...(pkg.dependencies ?? {}),
  ...(pkg.optionalDependencies ?? {}),
};
for (const name of REQUIRED_RUNTIME_DEPS) {
  if (!allDeps[name]) {
    failures.push(`missing runtime dep: ${name} (must be in dependencies or optionalDependencies)`);
  }
}

const files = pkg.build?.files ?? [];
for (const pattern of REQUIRED_FILES_PATTERNS) {
  if (!files.includes(pattern)) {
    failures.push(`missing build.files entry: ${pattern}`);
  }
}

const asarUnpack = pkg.build?.asarUnpack ?? [];
const REQUIRED_ASAR_UNPACK = [
  '**/node_modules/electron-windows-notifications/**',
  '**/node_modules/@nodert-win10-au/**',
];
for (const pattern of REQUIRED_ASAR_UNPACK) {
  if (!asarUnpack.includes(pattern)) {
    failures.push(`missing build.asarUnpack entry: ${pattern}`);
  }
}

if (failures.length > 0) {
  console.error('probe-notify-packaging: FAIL');
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}

console.log('probe-notify-packaging: PASS');
console.log('  runtime deps present:', REQUIRED_RUNTIME_DEPS.length);
console.log('  build.files patterns present:', REQUIRED_FILES_PATTERNS.length);
console.log('  build.asarUnpack patterns present:', REQUIRED_ASAR_UNPACK.length);
