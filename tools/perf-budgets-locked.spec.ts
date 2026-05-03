/**
 * tools/perf-budgets-locked.spec.ts
 *
 * FOREVER-STABLE per design spec ch15 §3 #27:
 *   "Re-tuning the Listener-A perf budget for v0.4 reasons. The performance
 *    budgets pinned for Listener A (ch12 §7 — `SendInput` p99, snapshot encode
 *    p99, etc.) are forever-stable for Listener A only. v0.4 Listener B
 *    (cf-access via cloudflared) sets its own budget under its own descriptor
 *    file (`listener-b.json`) and its own ship-gate variant; v0.4 MUST NOT
 *    widen, narrow, or otherwise mutate Listener-A's budget to 'make room' for
 *    Listener B. Mechanism: human review with reference test as smoke check —
 *    ch12 §7 budget table is a checked-in markdown table; this spec parses it
 *    and asserts the Listener-A rows are byte-identical to the v0.3 release-tag
 *    content. Listener-B budget rows are appended (not in-place edits) when
 *    v0.4 ships."
 *
 * What this test does:
 *   1. Reads ch12 §7 from the merged design doc on disk.
 *   2. Extracts every table row whose first column corresponds to a v0.3
 *      Listener-A budget metric (the "Listener-A rows").
 *   3. Asserts each row matches a frozen byte-identical reference.
 *   4. Positive control: a synthetic doc with appended Listener-B rows after
 *      the Listener-A rows still passes (additivity).
 *   5. Negative control: a synthetic doc that mutates a Listener-A row in
 *      place fails (in-place edits forbidden).
 *
 * Layer 1 notes:
 *   - No new npm deps. Uses only `node:fs` + `node:path`.
 *   - Line-ending normalization: the design doc may be checked out as CRLF on
 *     Windows. We normalize CRLF→LF before comparison so the lock survives
 *     `core.autocrlf` round-trips. The frozen strings below are LF-only.
 *   - Run with: `npx vitest run --config tools/vitest.config.ts
 *               tools/perf-budgets-locked.spec.ts`
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const DESIGN_DOC_PATH = resolve(
  REPO_ROOT,
  'docs/superpowers/specs/2026-05-03-v03-daemon-split-design.md',
);

/**
 * Frozen v0.3 Listener-A perf budget rows from ch12 §7.
 *
 * DO NOT EDIT. Each entry is a single markdown table row, byte-identical to
 * the v0.3 release-tag content. Adding entries here is a v0.3 contract change
 * and requires R0 sign-off. v0.4 Listener-B rows are appended to the markdown
 * table on disk — NOT inserted into this array.
 *
 * Source: docs/superpowers/specs/2026-05-03-v03-daemon-split-design.md
 *         ch12 §7 (Performance budgets) at commit on `working` after PR #847
 *         consolidated merge. Captured byte-for-byte; normalized to LF only.
 */
const FROZEN_LISTENER_A_ROWS: readonly string[] = [
  '| Daemon cold start to Listener A bind | < 500 ms (no sessions) / < 2 s (50 sessions to restore) | `bench/cold-start.spec.ts` |',
  '| `Hello` RPC RTT over Listener A | < 5 ms p99 (loopback) | `bench/hello-rtt.spec.ts` |',
  '| `SendInput` RTT | < 5 ms p99 | `bench/sendinput-rtt.spec.ts` (advisory) **AND** sampled-during-soak in `pty-soak-1h.spec.ts` (blocking via gate (c) — see §4.3) |',
  '| Snapshot encode (80×24 + 10k scrollback) | < 50 ms | `bench/snapshot-encode.spec.ts` |',
  '| Daemon RSS at idle (5 sessions) | < 200 MB | nightly `bench/rss.spec.ts` |',
] as const;

/**
 * The header rows of the table (column headers + alignment row). These are
 * locked too — re-shaping the table (adding columns, renaming "Metric") would
 * silently invalidate the row strings above.
 */
const FROZEN_TABLE_HEADER: readonly string[] = [
  '| Metric | Budget | Enforced by |',
  '| --- | --- | --- |',
] as const;

/**
 * Section heading. Locked so a typo / rename / re-numbering of §7 trips here
 * with a clear error rather than the more confusing "row not found" failure.
 */
const FROZEN_SECTION_HEADING = '#### 7. Performance budgets (regressions = test failures)';

/**
 * Extract the markdown table that follows the §7 heading from a doc body.
 * Returns the lines that start with `|` (header + body rows) in order, and
 * stops at the first non-table line (blank line or prose).
 *
 * Throws if the heading is not found.
 */
function extractPerfBudgetTable(docBody: string): string[] {
  const normalized = docBody.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n');

  const headingIdx = lines.findIndex((l) => l === FROZEN_SECTION_HEADING);
  if (headingIdx < 0) {
    throw new Error(
      `ch12 §7 heading not found. Expected a line equal to:\n  ${FROZEN_SECTION_HEADING}\n` +
        `Heading rename or re-numbering trips this — fix the doc, do not edit the lock.`,
    );
  }

  // Skip ahead until first table line (starts with `|`).
  let i = headingIdx + 1;
  while (i < lines.length && !lines[i].startsWith('|')) i++;

  const tableLines: string[] = [];
  while (i < lines.length && lines[i].startsWith('|')) {
    tableLines.push(lines[i]);
    i++;
  }

  if (tableLines.length === 0) {
    throw new Error('ch12 §7 has no markdown table after the heading.');
  }
  return tableLines;
}

describe('Listener-A perf budgets locked (design ch15 §3 #27)', () => {
  const docBytes = readFileSync(DESIGN_DOC_PATH);
  const docText = docBytes.toString('utf8');
  const tableLines = extractPerfBudgetTable(docText);

  it('table header row is byte-identical to frozen', () => {
    expect(
      tableLines.slice(0, FROZEN_TABLE_HEADER.length),
      'ch12 §7 table header must stay `| Metric | Budget | Enforced by |`. ' +
        'Adding/renaming columns would silently invalidate the locked Listener-A rows. ' +
        'See design ch15 §3 #27.',
    ).toEqual([...FROZEN_TABLE_HEADER]);
  });

  it('every frozen Listener-A row is present byte-identical and in order', () => {
    // Body rows = lines after the 2-line header.
    const bodyRows = tableLines.slice(FROZEN_TABLE_HEADER.length);

    // The first N body rows MUST be the frozen Listener-A rows in order.
    // (Listener-B rows, if any, are appended AFTER — additive only.)
    const prefix = bodyRows.slice(0, FROZEN_LISTENER_A_ROWS.length);

    expect(
      prefix,
      'Listener-A perf budget rows in ch12 §7 are FROZEN per design ch15 §3 #27. ' +
        'Each row must be byte-identical to the v0.3 release-tag content. ' +
        'v0.4 Listener-B rows MUST be APPENDED below these rows, not edited in place. ' +
        'If you need to "fix a typo" in a Listener-A row, you do not — that row is the contract.',
    ).toEqual([...FROZEN_LISTENER_A_ROWS]);
  });

  it('positive control: appending Listener-B rows after the locked rows still passes', () => {
    const synthetic =
      'irrelevant prose\n\n' +
      `${FROZEN_SECTION_HEADING}\n\n` +
      `${FROZEN_TABLE_HEADER.join('\n')}\n` +
      `${FROZEN_LISTENER_A_ROWS.join('\n')}\n` +
      // Hypothetical v0.4 Listener-B append:
      '| `Hello` RPC RTT over Listener B (cf-access) | < 50 ms p99 (WAN) | `bench/hello-rtt-listener-b.spec.ts` |\n' +
      '| Listener B JWT verification | < 2 ms p99 | `bench/jwt-verify.spec.ts` |\n' +
      '\nfollowing prose\n';

    const synthLines = extractPerfBudgetTable(synthetic);
    const synthBody = synthLines.slice(FROZEN_TABLE_HEADER.length);
    expect(synthBody.slice(0, FROZEN_LISTENER_A_ROWS.length)).toEqual([
      ...FROZEN_LISTENER_A_ROWS,
    ]);
    // And there ARE additional rows — proves we tolerated them.
    expect(synthBody.length).toBeGreaterThan(FROZEN_LISTENER_A_ROWS.length);
  });

  it('negative control: mutating a Listener-A row in place fails the lock', () => {
    // Take the real doc, mutate the SendInput budget from "< 5 ms" to "< 7 ms",
    // and assert the same comparison logic rejects it.
    const normalized = docText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const mutated = normalized.replace(
      '| `SendInput` RTT | < 5 ms p99 |',
      '| `SendInput` RTT | < 7 ms p99 |',
    );
    expect(mutated, 'sanity: mutation must actually change the doc').not.toBe(normalized);

    const mutatedLines = extractPerfBudgetTable(mutated);
    const mutatedBody = mutatedLines.slice(FROZEN_TABLE_HEADER.length);
    const mutatedPrefix = mutatedBody.slice(0, FROZEN_LISTENER_A_ROWS.length);

    expect(
      mutatedPrefix,
      'Negative control failed: a mutated Listener-A row was accepted. ' +
        'The lock would not catch real regressions.',
    ).not.toEqual([...FROZEN_LISTENER_A_ROWS]);
  });

  it('CRLF-checked-out doc still passes the lock (line-ending agnostic)', () => {
    // Re-read the raw bytes; if git delivered CRLF on this machine, the doc
    // text will contain \r\n. The extractor normalizes — assert that the
    // already-passing assertion above is not accidentally LF-only.
    const raw = docBytes.toString('utf8');
    const looksLikeCrlf = raw.includes('\r\n');
    // We do not REQUIRE CRLF; we just assert that whichever encoding shipped,
    // the extracted Listener-A rows match the frozen LF-only constants.
    const lines = extractPerfBudgetTable(raw);
    const body = lines.slice(FROZEN_TABLE_HEADER.length);
    expect(body.slice(0, FROZEN_LISTENER_A_ROWS.length)).toEqual([
      ...FROZEN_LISTENER_A_ROWS,
    ]);
    // Surface the encoding in test output for debuggability (no assertion).
    void looksLikeCrlf;
  });
});
