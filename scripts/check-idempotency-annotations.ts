#!/usr/bin/env tsx
/**
 * check-idempotency-annotations.ts
 *
 * Per spec ch02 §9: every `rpc <Name>(...)` declaration in `proto/ccsm/v1/`
 * MUST carry an immediately-preceding `// idempotency: <category>` comment
 * with one of three category values:
 *   - naturally idempotent
 *   - dedup-via-server-key
 *   - non-idempotent
 *
 * Exits 1 with a list of violations on missing or invalid annotations.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const PROTO_DIR = resolve(process.cwd(), "proto/ccsm/v1");
const VALID = new Set([
  "naturally idempotent",
  "dedup-via-server-key",
  "non-idempotent",
]);

interface Violation {
  file: string;
  line: number;
  rpc: string;
  reason: string;
}

function checkFile(filePath: string): Violation[] {
  const content = readFileSync(filePath, "utf8");
  const lines = content.split(/\r?\n/);
  const violations: Violation[] = [];
  const rpcRegex = /^\s*rpc\s+(\w+)\s*\(/;

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(rpcRegex);
    if (!m) continue;
    const rpcName = m[1];

    // Walk backward, skipping non-annotation comment lines and blanks, to
    // find the most recent `// idempotency:` annotation before this rpc.
    // The annotation MUST appear within the contiguous comment block
    // immediately preceding the rpc line (no blank line gap allowed once
    // we leave the comment block).
    let found: string | null = null;
    let sawComment = false;
    for (let j = i - 1; j >= 0; j--) {
      const prev = lines[j];
      const trimmed = prev.trim();
      if (trimmed === "") {
        // Blank line: only allowed BEFORE we start seeing the comment block.
        if (sawComment) break;
        continue;
      }
      if (!trimmed.startsWith("//")) {
        // Hit a non-comment, non-blank line — annotation block ended.
        break;
      }
      sawComment = true;
      const idem = trimmed.match(/^\/\/\s*idempotency:\s*(.+?)\s*$/);
      if (idem) {
        found = idem[1];
        break;
      }
    }

    if (found === null) {
      violations.push({
        file: filePath,
        line: i + 1,
        rpc: rpcName,
        reason: "missing `// idempotency:` annotation",
      });
    } else if (!VALID.has(found)) {
      violations.push({
        file: filePath,
        line: i + 1,
        rpc: rpcName,
        reason: `invalid idempotency category: "${found}" (must be one of: ${[...VALID].join(", ")})`,
      });
    }
  }

  return violations;
}

function main(): void {
  let entries: string[];
  try {
    entries = readdirSync(PROTO_DIR);
  } catch (err) {
    console.error(`error: cannot read ${PROTO_DIR}: ${(err as Error).message}`);
    process.exit(1);
  }

  const protoFiles = entries
    .filter((f) => f.endsWith(".proto"))
    .map((f) => join(PROTO_DIR, f))
    .sort();

  const violations: Violation[] = [];
  for (const f of protoFiles) {
    violations.push(...checkFile(f));
  }

  if (violations.length === 0) {
    console.log(`ok: ${protoFiles.length} proto files scanned, all rpcs annotated.`);
    process.exit(0);
  }

  console.error(`FAIL: ${violations.length} idempotency annotation violation(s):`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  rpc ${v.rpc}  — ${v.reason}`);
  }
  process.exit(1);
}

main();
