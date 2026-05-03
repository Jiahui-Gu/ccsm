#!/usr/bin/env node
/* global console, process */
// packages/proto/scripts/version-drift-check.mjs
//
// Asserts: PROTO_VERSION at HEAD >= PROTO_VERSION at the most-recent
// `v*` git tag. Run in CI (proto-gen-and-lint job, see spec ch11 §7).
//
// Source of truth: packages/proto/src/version.ts exports
// `export const PROTO_VERSION = <int>;`. This script reads the file at
// HEAD and at the tag (`git show <tag>:packages/proto/src/version.ts`)
// without invoking the TS compiler — a small regex is sufficient because
// the file is hand-edited and intentionally trivial.
//
// Exit codes:
//   0 — no prior tag (first release), or PROTO_VERSION unchanged, or bumped
//   1 — PROTO_VERSION regressed (current < tagged) OR file shape unparseable
//
// Bump rule: edit `version.ts` IF AND ONLY IF a `.proto` file changed in
// a way that affects the wire (additive but consumer-visible counts). The
// `proto-lock-check` step makes proto deltas visible in the same PR.
//
// First-release semantics: when no `v*` tag exists, the check is a no-op.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const VERSION_REL = 'packages/proto/src/version.ts';
const VERSION_ABS = join(REPO_ROOT, VERSION_REL);

// Hand-edited file shape: `export const PROTO_VERSION = <int>;`. Tolerate
// surrounding whitespace, semicolon optional, comments above/around.
const PROTO_VERSION_RE = /export\s+const\s+PROTO_VERSION\s*[:=][^=]*?=?\s*(\d+)\s*;?/;

function parseProtoVersion(source, label) {
  // Two-step: first match `=` form, then accept `: number = N` typed form.
  const direct = source.match(/export\s+const\s+PROTO_VERSION\s*(?::\s*number\s*)?=\s*(\d+)\s*;?/);
  if (!direct) {
    throw new Error(
      `${label}: cannot find \`export const PROTO_VERSION = <int>;\` in ${VERSION_REL}`
    );
  }
  const n = Number.parseInt(direct[1], 10);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`${label}: PROTO_VERSION parsed to invalid integer: ${direct[1]}`);
  }
  return n;
}

function git(...args) {
  return execFileSync('git', args, {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
}

function gitOrNull(...args) {
  try {
    return git(...args);
  } catch {
    return null;
  }
}

function latestVTag() {
  // List tags matching v*, sort by version (descending). `--sort=-v:refname`
  // gives semver-ish ordering (v0.10.0 > v0.2.0). Filter out tags that don't
  // look like a release (e.g. `v0.0.0-dryrun`, `archive/v03-attempt-1`).
  const raw = gitOrNull('tag', '--list', 'v*', '--sort=-v:refname');
  if (!raw) return null;
  const candidates = raw
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => /^v\d+\.\d+\.\d+$/.test(s));
  return candidates.length > 0 ? candidates[0] : null;
}

function readVersionAtTag(tag) {
  // `git show <tag>:<path>` returns null if the path didn't exist at that
  // tag — which is true for every release before this script lands. In
  // that case we treat the tagged PROTO_VERSION as 0 (everything is a
  // valid bump), matching the "first release" semantics from spec ch11 §7.
  const out = gitOrNull('show', `${tag}:${VERSION_REL}`);
  if (out === null) return 0;
  return parseProtoVersion(out, `tag ${tag}`);
}

function readVersionAtHead() {
  const out = readFileSync(VERSION_ABS, 'utf8');
  return parseProtoVersion(out, 'HEAD');
}

function main() {
  const head = readVersionAtHead();
  const tag = latestVTag();
  if (!tag) {
    console.log(
      `proto-version-drift-check: no \`v*.*.* \` tag found; first release. PROTO_VERSION at HEAD = ${head}. OK.`
    );
    process.exit(0);
  }
  const tagged = readVersionAtTag(tag);
  if (head < tagged) {
    console.error(
      `proto-version-drift-check: REGRESSION — PROTO_VERSION at HEAD (${head}) < ${tag} (${tagged}).\n` +
        `  Bump packages/proto/src/version.ts back to >= ${tagged}.\n` +
        `  See spec ch11 §7 / ch04 §3 for the bump rule.`
    );
    process.exit(1);
  }
  if (head === tagged) {
    console.log(
      `proto-version-drift-check: PROTO_VERSION unchanged since ${tag} (${head}). OK.`
    );
  } else {
    console.log(
      `proto-version-drift-check: PROTO_VERSION bumped ${tagged} -> ${head} since ${tag}. OK.`
    );
  }
  process.exit(0);
}

main();

// Exported for tests. Not part of the runtime entry point.
export { parseProtoVersion, latestVTag, readVersionAtTag, PROTO_VERSION_RE };
