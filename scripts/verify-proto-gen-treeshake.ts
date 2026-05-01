/**
 * Tree-shake verification for `@ccsm/proto-gen/v1`.
 *
 * Spec: docs/superpowers/specs/2026-05-01-v0.4-web-design.md ch02 §5
 * Task: #1084 v0.4 T03
 *
 * Builds a minimal Vite/Rollup bundle whose ONLY entry is a single import
 * from the wrapper barrel, then asserts the resulting bundle:
 *   1. contains the imported symbol (proves the import path resolves)
 *   2. does NOT contain identifiers from unrelated proto domains (proves
 *      the wrapper is tree-shakeable)
 *
 * The build is run programmatically via the Vite Node API so this also
 * doubles as a CI smoke test that the wrapper is bundler-clean.
 *
 * Exposed both as a standalone script (run via `tsx`) and as a function
 * imported by the vitest test in `tests/scripts/`.
 */

import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { build, type InlineConfig } from "vite";

export interface TreeShakeResult {
  bundlePath: string;
  bundleBytes: number;
  bundleSource: string;
  presentSymbols: string[];
  absentSymbols: string[];
}

const REPO_ROOT = path.resolve(__dirname, "..");

// Symbol that MUST appear in the bundle (we import it).
const PRESENT_SYMBOL = "CcsmService";

// Domain-specific schema constants that MUST NOT leak into the bundle.
// We pick one per non-service domain that is unique to that domain (i.e.
// not also re-exported through the umbrella service file).
//
// `service_pb.ts` only re-exports `file_*` markers and the umbrella
// service const; it does NOT pull in the domain `*Schema` constants.
// So a tree-shaken bundle that imports only `CcsmService` should be
// missing every `*Schema` const from these domains.
const ABSENT_SYMBOLS = [
  "GetPtyBufferSnapshotResponseSchema", // pty
  "NotifyUserInputResponseSchema",      // notify
  "GetSessionTitleResponseSchema",      // session_titles
  "ScanImportableResponseSchema",       // import
  "GetDefaultModelResponseSchema",      // settings
  "GetUpdatesStatusResponseSchema",     // updater
  "SetSessionActiveResponseSchema",     // session
  "GetAppVersionResponseSchema",        // core
];

export async function runTreeShakeVerification(): Promise<TreeShakeResult> {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ccsm-treeshake-"));
  const entryFile = path.join(tmpRoot, "entry.ts");
  const outDir = path.join(tmpRoot, "dist");

  // Single-import entry: only `CcsmService` is referenced. A correctly
  // tree-shakeable barrel must not drag in the other 8 domains' Schema
  // constants. We `console.log` the symbol so Rollup can't dead-code it
  // away as fully unused.
  const entrySource = [
    'import { CcsmService } from "@ccsm/proto-gen/v1";',
    "if (typeof CcsmService === 'undefined') { throw new Error('missing'); }",
    "// eslint-disable-next-line no-console",
    "console.log(CcsmService.typeName);",
    "",
  ].join("\n");

  await fs.writeFile(entryFile, entrySource, "utf8");

  const config: InlineConfig = {
    root: tmpRoot,
    logLevel: "warn",
    configFile: false,
    resolve: {
      alias: {
        "@ccsm/proto-gen/v1": path.join(REPO_ROOT, "gen/ts/ccsm/v1/index.ts"),
        "@ccsm/proto-gen": path.join(REPO_ROOT, "gen/ts/index.ts"),
      },
    },
    build: {
      outDir,
      emptyOutDir: true,
      target: "es2022",
      minify: false, // unminified so identifier names survive for grep
      lib: {
        entry: entryFile,
        formats: ["es"],
        fileName: () => "bundle.js",
      },
      rollupOptions: {
        // Keep @bufbuild/protobuf as a regular dep so its identifiers stay
        // visible. We still want to bundle our own gen output to test
        // tree-shaking through the barrel.
        external: [],
      },
      reportCompressedSize: false,
      write: true,
    },
  };

  await build(config);

  const bundlePath = path.join(outDir, "bundle.js");
  const bundleSource = await fs.readFile(bundlePath, "utf8");
  const bundleBytes = Buffer.byteLength(bundleSource, "utf8");

  const presentSymbols = [PRESENT_SYMBOL].filter((s) =>
    bundleSource.includes(s),
  );
  const absentSymbols = ABSENT_SYMBOLS.filter((s) => bundleSource.includes(s));

  return {
    bundlePath,
    bundleBytes,
    bundleSource,
    presentSymbols,
    absentSymbols,
  };
}

// CLI entry: `tsx scripts/verify-proto-gen-treeshake.ts`
async function main(): Promise<void> {
  const result = await runTreeShakeVerification();
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        bundlePath: result.bundlePath,
        bundleBytes: result.bundleBytes,
        bundleKB: (result.bundleBytes / 1024).toFixed(2),
        present: result.presentSymbols,
        leaked: result.absentSymbols,
      },
      null,
      2,
    ),
  );
  if (result.presentSymbols.length === 0) {
    // eslint-disable-next-line no-console
    console.error("FAIL: imported symbol not found in bundle");
    process.exit(1);
  }
  if (result.absentSymbols.length > 0) {
    // eslint-disable-next-line no-console
    console.error(
      `FAIL: tree-shake leak — these unimported symbols appear in bundle: ${result.absentSymbols.join(", ")}`,
    );
    process.exit(1);
  }
  // eslint-disable-next-line no-console
  console.log(
    `OK: tree-shake passed — bundle ${(result.bundleBytes / 1024).toFixed(2)} KB`,
  );
}

// Only run as CLI when invoked directly (not when imported by vitest).
const isCli =
  typeof require !== "undefined" && require.main === module;
if (isCli) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
}
