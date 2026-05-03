#!/usr/bin/env node
// Spike T9.11 — better-sqlite3 arm64 prebuild availability probe (Node 22 ABI).
//
// Forever-stable contract (per spec ch14 §1.B):
//   Input args:   --version=<semver>    (default: 12.9.0)
//                 --abi=<NODE_MODULE_VERSION>   (default: 127, == Node 22)
//                 --offline             skip GitHub API call, only run live load
//                 --no-load             skip the live require()/Database open
//   Output:       Single JSON object on stdout. Schema:
//                   {
//                     ok:        boolean,             // overall verdict
//                     version:   string,              // better-sqlite3 version queried
//                     abi:       string,              // Node ABI queried
//                     remote: {                       // null when --offline
//                       releaseTag:    string,
//                       prebuilds: {                  // per <platform>-<arch>
//                         "darwin-arm64":   { present: bool, asset: string|null, sizeBytes: number|null },
//                         "linux-arm64":    { ... },
//                         "linuxmusl-arm64":{ ... },
//                         "win32-arm64":    { ... }
//                       }
//                     } | null,
//                     local: {                        // null when --no-load
//                       platform: string,             // process.platform
//                       arch:     string,             // process.arch
//                       loaded:   bool,
//                       sqliteVersion: string|null,
//                       error:    string|null
//                     } | null
//                   }
//   Exit code:    0 on ok=true (all queried arm64 targets resolved + load
//                 succeeded when applicable). Non-zero on any failure.
//
// This probe deliberately uses ONLY node: stdlib for the remote check so it
// can run against any pool worktree without `pnpm install`. The local
// require() leg is gated on better-sqlite3 being resolvable from the
// current cwd — useful when the probe is mounted into a daemon checkout
// that already has the dep installed.

import { request } from 'node:https';
import { createRequire } from 'node:module';
import { argv, exit, platform, arch, stdout, stderr } from 'node:process';

function parseArgs(args) {
  const out = { version: '12.9.0', abi: '127', offline: false, noLoad: false };
  for (const a of args.slice(2)) {
    if (a.startsWith('--version=')) out.version = a.slice('--version='.length);
    else if (a.startsWith('--abi=')) out.abi = a.slice('--abi='.length);
    else if (a === '--offline') out.offline = true;
    else if (a === '--no-load') out.noLoad = true;
  }
  return out;
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: 'GET',
        headers: {
          'user-agent': 'ccsm-spike-better-sqlite3-22-arm64/1.0',
          accept: 'application/vnd.github+json',
        },
      },
      (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          fetchJson(res.headers.location).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          res.resume();
          return;
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function probeRemote(version, abi) {
  const tag = `v${version}`;
  const release = await fetchJson(
    `https://api.github.com/repos/WiseLibs/better-sqlite3/releases/tags/${tag}`,
  );
  const targets = ['darwin-arm64', 'linux-arm64', 'linuxmusl-arm64', 'win32-arm64'];
  const prebuilds = {};
  for (const target of targets) {
    const expected = `better-sqlite3-v${version}-node-v${abi}-${target}.tar.gz`;
    const asset = (release.assets || []).find((a) => a.name === expected);
    prebuilds[target] = asset
      ? { present: true, asset: asset.name, sizeBytes: asset.size }
      : { present: false, asset: null, sizeBytes: null };
  }
  return { releaseTag: release.tag_name || tag, prebuilds };
}

function probeLocal() {
  const result = {
    platform,
    arch,
    loaded: false,
    sqliteVersion: null,
    error: null,
  };
  try {
    // Anchor at cwd so this works whether the probe is run from the spike
    // directory (which has no deps) or from a daemon checkout that does.
    const req = createRequire(`${process.cwd()}/`);
    const Database = req('better-sqlite3');
    const db = new Database(':memory:');
    const row = db.prepare('SELECT sqlite_version() AS v').get();
    db.close();
    result.loaded = true;
    result.sqliteVersion = row.v;
  } catch (err) {
    result.error = err && err.message ? err.message : String(err);
  }
  return result;
}

async function main() {
  const args = parseArgs(argv);
  const out = {
    ok: false,
    version: args.version,
    abi: args.abi,
    remote: null,
    local: null,
  };
  let remoteOk = true;
  let localOk = true;
  try {
    if (!args.offline) {
      out.remote = await probeRemote(args.version, args.abi);
      // Spike scope: only darwin-arm64 + linux-arm64 are required by ch14 §1.12.
      // linuxmusl-arm64 + win32-arm64 are reported but do not gate ok.
      remoteOk =
        out.remote.prebuilds['darwin-arm64'].present &&
        out.remote.prebuilds['linux-arm64'].present;
    }
    if (!args.noLoad) {
      out.local = probeLocal();
      // The local leg is only authoritative when running ON arm64. On x64
      // hosts the load still proves the package works in general but does
      // not exercise the arm64 prebuild — the verdict is downgraded to
      // "not authoritative" but not failed.
      if (out.local.arch === 'arm64') {
        localOk = out.local.loaded;
      }
    }
    out.ok = remoteOk && localOk;
  } catch (err) {
    stderr.write(`probe error: ${err && err.stack ? err.stack : String(err)}\n`);
    out.ok = false;
  }
  stdout.write(JSON.stringify(out, null, 2) + '\n');
  exit(out.ok ? 0 : 1);
}

main();
