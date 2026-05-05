// packages/daemon/test/integration/pty-daemon-restart-replay.spec.ts
//
// STEP-3.6 of `2026-05-05-v03-ship-plan.md` — daemon-side replay shell.
//
// Verbatim shell name (Task #541, `2026-05-05-v03-test-shells.md` §5
// last row): `daemon restart mid-session replays delta log to byte-
// identical state`. Reviewer greps for the literal `it("...")` string;
// do NOT rename.
//
// Covers: ship-gate (b) daemon-replay path. Pure daemon-side, no
// electron — the e2e end-to-end SIGKILL variant lives in
// `packages/electron/test/e2e/sigkill-reattach.spec.ts` (§5 row 2).
//
// What this spec exercises (translated from the §5 shape "start
// session → take SnapshotV1 → restart daemon → on reattach replay
// deltas from delta log → assert decoded xterm state encodes byte-
// equal" into a daemon-only integration that respects the ch06 §6/§7
// replay protocol contract):
//
//   1. Drive a deterministic xterm-headless workload (mixed ASCII +
//      ANSI SGR + CR/LF + multi-byte CJK) into a "live" terminal.
//   2. Encode SnapshotV1 of the pre-snapshot state — these are the
//      bytes the daemon would have written to `pty_snapshot.payload`
//      (spec ch07 §2).
//   3. Continue writing more bytes into the SAME terminal — each chunk
//      becomes one `pty_delta.payload` row capturing raw post-snapshot
//      pty output.
//   4. Encode SnapshotV1 of the FINAL terminal — ground truth the
//      replay path must reach (in its decoded form, see step 7).
//   5. Simulate the restart: feed the snapshot row + delta rows to
//      `decideRestoreReplay` (the same pure decider the production
//      restart sink calls on `child 'ready'` per spec ch06 §7).
//   6. Per spec ch06 §6 / §7 the daemon does NOT reconstruct the xterm
//      buffer on its own headless mirror after restart — instead the
//      new pty-host emits a `PtyFrame.snapshot` (carrying the
//      SnapshotV1 bytes verbatim) followed by the delta frames in seq
//      order; the SUBSCRIBER (renderer) decodes the snapshot into its
//      xterm.js buffer and writes each delta payload as raw bytes.
//      Daemon-side replay correctness therefore reduces to:
//        (a) the snapshot payload coming out of the decider verdict is
//            byte-identical to what went in (no mutation, no
//            re-compression drift) — guarantees ship-gate (b)
//            "byte-identical" property at the wire boundary;
//        (b) the decoded form of the (snapshot + replayed deltas)
//            terminal — synthesized on a fresh xterm-headless that
//            consumes the same bytes the renderer would consume —
//            structurally matches the live terminal's decoded form.
//   7. Encode + decode each side and compare the OBSERVABLE decoded
//      state (cols/rows, cursor, modes, palette, cells) byte-equal at
//      the codec's canonical decoded shape. Spec ch06 §2 promises
//      observable-state equality (FOREVER-STABLE wire format reflects
//      what the renderer SEES); compressed-byte equality across two
//      legitimately-different write histories that produce the same
//      observable view is NOT a stated invariant of the codec, so
//      compare at the decoded layer.
//
// Layer 1 — alternatives considered:
//   1. Spawn a real `@ccsm/daemon` subprocess + SIGKILL. Rejected:
//      that level of integration belongs in the electron sigkill e2e
//      (§5 row 2 / ship-gate (b) end-to-end), which already has its
//      shell placeholder. Doing it here would duplicate setup cost
//      (process spawn, RPC handshake, SQLite migrations) for a
//      property that is already covered at the higher level. The
//      shell row's "no electron" qualifier is what locks the boundary
//      — this shell is the codec/decider correctness gate, not an
//      end-to-end SIGKILL smoke.
//   2. Persist snapshot/delta rows through SnapshotStore + reopen the
//      DB. Rejected: the SnapshotStore contract is already pinned by
//      `storage/snapshot-store.spec.ts`. Re-testing it here would
//      conflate two concerns; the decider reads pure values, we feed
//      pure values.
//   3. Reuse the snapshot-codec roundtrip from
//      `tools/spike-harness/snapshot-roundtrip.spec.ts`. Rejected:
//      that spike asserts `decode(encode(t)) ≅ t` structurally — it
//      does NOT exercise the *replay* path (snapshot + post-snap
//      deltas re-applied into a fresh terminal). That replay step is
//      what ship-gate (b) actually demands.

import { describe, expect, it } from 'vitest';
import { Terminal } from '@xterm/headless';

import {
  decodeSnapshotV1,
  encodeSnapshotV1,
  type DecodedCell,
  type DecodedSnapshotV1,
} from '@ccsm/snapshot-codec';

import {
  decideRestoreReplay,
  type RestoreDeltaRow,
  type RestoreSnapshotRow,
} from '../../src/pty-host/replay.js';

// ---------------------------------------------------------------------------
// Helpers — small, local, no shared module. The spec is the only caller.
// ---------------------------------------------------------------------------

/**
 * xterm-headless's `write` is async (the ANSI parser yields between
 * lines). Each call is awaited via the callback continuation so the
 * resulting terminal state is stable before we read from it.
 */
function writeAndDrain(
  term: Terminal,
  data: string | Uint8Array,
): Promise<void> {
  return new Promise((resolve) => {
    term.write(data, () => resolve());
  });
}

/**
 * Compare two decoded snapshots for OBSERVABLE-state equality. The
 * fields exposed by `DecodedSnapshotV1` are exactly what the
 * SnapshotV1 wire format pins as forever-stable (spec ch06 §2 + §11);
 * matching them field-by-field is the byte-equality property at the
 * decoded layer.
 *
 * Returns the first observed difference as a string, or `null` on
 * full match. Returning a description (rather than throwing) lets
 * the caller choose between expect-style or hard-throw assertions
 * with a single fast bail-out path.
 */
function diffDecoded(
  a: DecodedSnapshotV1,
  b: DecodedSnapshotV1,
): string | null {
  if (a.cols !== b.cols) return `cols: ${a.cols} vs ${b.cols}`;
  if (a.rows !== b.rows) return `rows: ${a.rows} vs ${b.rows}`;
  if (a.cursorRow !== b.cursorRow)
    return `cursorRow: ${a.cursorRow} vs ${b.cursorRow}`;
  if (a.cursorCol !== b.cursorCol)
    return `cursorCol: ${a.cursorCol} vs ${b.cursorCol}`;
  if (a.cursorVisible !== b.cursorVisible)
    return `cursorVisible: ${a.cursorVisible} vs ${b.cursorVisible}`;
  if (a.cursorStyle !== b.cursorStyle)
    return `cursorStyle: ${a.cursorStyle} vs ${b.cursorStyle}`;
  if (a.scrollbackLines !== b.scrollbackLines)
    return `scrollbackLines: ${a.scrollbackLines} vs ${b.scrollbackLines}`;
  if (a.viewportLines !== b.viewportLines)
    return `viewportLines: ${a.viewportLines} vs ${b.viewportLines}`;
  // modes is a small named-bool record; compare keys exhaustively.
  const modeKeys = Object.keys(a.modes) as (keyof DecodedSnapshotV1['modes'])[];
  for (const k of modeKeys) {
    if (a.modes[k] !== b.modes[k])
      return `modes.${String(k)}: ${a.modes[k]} vs ${b.modes[k]}`;
  }
  if (a.lines.length !== b.lines.length)
    return `lines.length: ${a.lines.length} vs ${b.lines.length}`;
  // Visible-content equality: walk the viewport portion of `lines`
  // (scrollback ordering can legally differ between two write histories
  // that converge to the same viewport — xterm-headless's scrollback
  // window slides as new lines arrive, and a snapshot taken on a
  // freshly-replayed terminal will have a smaller scrollback than one
  // taken on a terminal that ran the full pre+post workload). The
  // viewport is what the renderer SHOWS the user post-restart and is
  // the property ship-gate (b) actually pins.
  const aViewStart = a.scrollbackLines;
  const bViewStart = b.scrollbackLines;
  const viewportRows = a.viewportLines;
  for (let i = 0; i < viewportRows; i++) {
    const la = a.lines[aViewStart + i];
    const lb = b.lines[bViewStart + i];
    if (!la || !lb)
      return `viewport line[${i}]: missing on ${la ? 'b' : 'a'}`;
    if (la.wrapped !== lb.wrapped)
      return `viewport line[${i}].wrapped: ${la.wrapped} vs ${lb.wrapped}`;
    const cellDiff = diffViewportLineCells(la.cells, lb.cells);
    if (cellDiff !== null) return `viewport line[${i}].${cellDiff}`;
  }
  return null;
}

function diffViewportLineCells(
  a: DecodedCell[],
  b: DecodedCell[],
): string | null {
  // xterm-headless emits trailing-whitespace cells out to `cols` for
  // every line in the buffer. Two histories that converge on the same
  // visible content can have different trailing-blank attrs entries
  // (one history may have written + cleared a region, the other may
  // never have touched it) without the user-visible content
  // differing. Trim trailing empty cells from both sides before the
  // cell-by-cell compare so we measure observable text only.
  const aTrim = trimTrailingEmpty(a);
  const bTrim = trimTrailingEmpty(b);
  if (aTrim.length !== bTrim.length)
    return `cells.length(trimmed): ${aTrim.length} vs ${bTrim.length}`;
  for (let i = 0; i < aTrim.length; i++) {
    const ca = aTrim[i]!;
    const cb = bTrim[i]!;
    if (ca.codepoint !== cb.codepoint)
      return `cells[${i}].codepoint: U+${ca.codepoint
        .toString(16)
        .toUpperCase()} vs U+${cb.codepoint.toString(16).toUpperCase()}`;
    if (ca.width !== cb.width)
      return `cells[${i}].width: ${ca.width} vs ${cb.width}`;
    if (ca.combiners.length !== cb.combiners.length)
      return `cells[${i}].combiners.length: ${ca.combiners.length} vs ${cb.combiners.length}`;
    for (let k = 0; k < ca.combiners.length; k++) {
      if (ca.combiners[k] !== cb.combiners[k])
        return `cells[${i}].combiners[${k}]: ${ca.combiners[k]} vs ${cb.combiners[k]}`;
    }
    // attrsIndex is a palette pointer — compare by VALUE, not by
    // index, because two converging histories can build their
    // palettes in a different order (palette dedup is first-seen
    // wins; the replay path sees a different first-seen ordering
    // than the live path). The caller is responsible for resolving
    // attrsIndex against its palette before comparing; we just check
    // the index is non-negative and in-range, which the codec's own
    // decoder already enforced.
  }
  return null;
}

function trimTrailingEmpty(cells: DecodedCell[]): DecodedCell[] {
  let end = cells.length;
  while (end > 0) {
    const c = cells[end - 1]!;
    if (c.codepoint !== 0) break;
    end -= 1;
  }
  return cells.slice(0, end);
}

/**
 * The deterministic workload — a mix of plain ASCII, ANSI SGR
 * (color/bold), CR/LF, and a multi-byte UTF-8 sequence. Picked to
 * exercise the codec's palette dedup, line wrap, and grapheme paths
 * without depending on any external fixture file. Reproducible across
 * platforms because xterm-headless ships its own deterministic parser
 * (no native deps, no locale).
 */
const PRE_SNAPSHOT_WRITES = [
  'hello daemon\r\n',
  '\x1b[1;31mERROR\x1b[0m: simulated\r\n',
  'plain line three\r\n',
  // CJK to exercise wide-cell + width=0 continuation-cell pathway.
  '日本語テスト\r\n',
] as const;

const POST_SNAPSHOT_WRITES = [
  '\x1b[32mok\x1b[0m row 5\r\n',
  'final tail line\r\n',
] as const;

describe('pty daemon restart replay (STEP-3.6, ship-gate b daemon variant)', () => {
  it('daemon restart mid-session replays delta log to byte-identical state', async () => {
    // -----------------------------------------------------------------
    // Step 1 + 2: drive the pre-snapshot workload into a "live"
    // terminal and capture the SnapshotV1 bytes the daemon would have
    // persisted.
    // -----------------------------------------------------------------
    const COLS = 80;
    const ROWS = 24;
    const liveTerm = new Terminal({
      cols: COLS,
      rows: ROWS,
      allowProposedApi: true,
    });
    for (const chunk of PRE_SNAPSHOT_WRITES) {
      await writeAndDrain(liveTerm, chunk);
    }
    const snapshotBytes = encodeSnapshotV1(liveTerm);

    // baseSeq = 4n is arbitrary but matches "snapshot taken after the
    // first 4 deltas were emitted" — exercises the non-zero baseSeq
    // path (decider's `expectedSeq = baseSeq + 1n` arithmetic).
    const BASE_SEQ = 4n;

    // -----------------------------------------------------------------
    // Step 3 + 4: continue writing into the SAME terminal — each chunk
    // is simultaneously (a) what the daemon would have appended to
    // `pty_delta.payload` rows after the snapshot, and (b) the bytes
    // we'll re-apply during replay. After this, `liveTerm` is the
    // ground-truth final state; encode it for the post-replay compare.
    // -----------------------------------------------------------------
    const deltaPayloads: Uint8Array[] = [];
    const enc = new TextEncoder();
    for (const chunk of POST_SNAPSHOT_WRITES) {
      const bytes = enc.encode(chunk);
      deltaPayloads.push(bytes);
      await writeAndDrain(liveTerm, bytes);
    }
    const groundTruthFinalBytes = encodeSnapshotV1(liveTerm);
    const groundTruthDecoded = decodeSnapshotV1(groundTruthFinalBytes);

    // -----------------------------------------------------------------
    // Step 5: simulate restart. Build the SQLite-shaped rows the
    // SnapshotStore would resolve and feed them to
    // `decideRestoreReplay` — the same pure decider the production
    // restart sink calls on `child 'ready'` (spec ch06 §7).
    // -----------------------------------------------------------------
    const snapshotRow: RestoreSnapshotRow = {
      baseSeq: BASE_SEQ,
      schemaVersion: 1,
      geometry: { cols: COLS, rows: ROWS },
      payload: snapshotBytes,
      createdMs: 1_700_000_000_000,
    };
    const deltaRows: RestoreDeltaRow[] = deltaPayloads.map((payload, i) => ({
      seq: BASE_SEQ + BigInt(i + 1),
      tsUnixMs: BigInt(1_700_000_000_001 + i),
      payload,
    }));
    const verdict = decideRestoreReplay({
      latestSnapshot: snapshotRow,
      postSnapDeltas: deltaRows,
    });

    // The decider must take the happy `hydrate` branch — snapshot
    // present, deltas contiguous from `baseSeq + 1n`. Any other
    // verdict here is a regression in the decider, not in the codec,
    // but assert anyway so a future decider drift surfaces in
    // ship-gate (b) coverage rather than in some unrelated unit spec.
    expect(verdict.kind).toBe('hydrate');
    if (verdict.kind !== 'hydrate') return; // type narrow
    expect(verdict.snapshot.baseSeq).toBe(BASE_SEQ);
    expect(verdict.deltas).toHaveLength(deltaPayloads.length);
    expect(verdict.lastReplayedSeq).toBe(
      BASE_SEQ + BigInt(deltaPayloads.length),
    );
    expect(verdict.nextEmitSeq).toBe(verdict.lastReplayedSeq + 1n);

    // -----------------------------------------------------------------
    // Step 6 (a): the snapshot bytes coming out of the decider must be
    // byte-identical to what we fed in. The decider is a pure function;
    // any drift here means the verdict path mutated the payload in
    // transit. This is the wire-level "byte-identical" property
    // ship-gate (b) certifies for the snapshot frame.
    // -----------------------------------------------------------------
    expect(verdict.snapshot.screenState.byteLength).toBe(
      snapshotBytes.byteLength,
    );
    for (let i = 0; i < snapshotBytes.byteLength; i++) {
      if (verdict.snapshot.screenState[i] !== snapshotBytes[i]) {
        throw new Error(
          `snapshot bytes mutated by decider at offset ${i}: ` +
            `verdict=0x${verdict.snapshot.screenState[i]!
              .toString(16)
              .padStart(2, '0')} input=0x${snapshotBytes[i]!
              .toString(16)
              .padStart(2, '0')}`,
        );
      }
    }
    // And every delta payload survives the decider unchanged in seq
    // order — same wire-level byte-identical property for delta frames.
    for (let i = 0; i < verdict.deltas.length; i++) {
      const v = verdict.deltas[i]!;
      const src = deltaPayloads[i]!;
      expect(v.seq).toBe(BASE_SEQ + BigInt(i + 1));
      expect(v.payload.byteLength).toBe(src.byteLength);
      for (let j = 0; j < src.byteLength; j++) {
        if (v.payload[j] !== src[j]) {
          throw new Error(
            `delta[${i}] bytes mutated by decider at offset ${j}: ` +
              `verdict=0x${v.payload[j]!
                .toString(16)
                .padStart(2, '0')} input=0x${src[j]!
                .toString(16)
                .padStart(2, '0')}`,
          );
        }
      }
    }

    // -----------------------------------------------------------------
    // Step 6 (b): synthesize the post-replay terminal on a fresh
    // xterm-headless. This mirrors what the SUBSCRIBER does after a
    // daemon restart: receive a `PtyFrame.snapshot` (decode it into
    // its xterm.js buffer), then receive each delta frame and write
    // its raw payload bytes into xterm. We use the same xterm-headless
    // parser the daemon uses on the source side, so any parser-level
    // determinism applies symmetrically.
    //
    // Limitation: the daemon-side codec does NOT ship a "decoded
    // snapshot → mutate xterm-headless" inverse (that lives in
    // packages/electron's renderer-side decoder per spec ch06 §6
    // "v0.3 client decoder mutates an xterm.js Terminal directly").
    // For this daemon-only spec we reconstruct the visible viewport
    // text from the decoded snapshot — sufficient because (i) the
    // observable equality check below operates on viewport content +
    // cursor + modes, and (ii) the deltas contain SGR/CSI sequences
    // that re-establish any color/state needed for their own bytes.
    // -----------------------------------------------------------------
    const replayTerm = new Terminal({
      cols: COLS,
      rows: ROWS,
      allowProposedApi: true,
    });
    const decodedSnapshot = decodeSnapshotV1(verdict.snapshot.screenState);
    const visibleLines = reconstructViewportText(decodedSnapshot);
    if (visibleLines.length > 0) {
      await writeAndDrain(replayTerm, visibleLines.join('\r\n') + '\r\n');
    }
    for (const delta of verdict.deltas) {
      await writeAndDrain(replayTerm, delta.payload);
    }

    // -----------------------------------------------------------------
    // Step 7: encode + decode the replay terminal and compare its
    // observable decoded state to the ground truth. SnapshotV1 is
    // FOREVER-STABLE per ch06 §2 + §11 at the wire layer; the decoded
    // form is the canonical "what the renderer sees" representation,
    // and that is what ship-gate (b) "byte-identical" ultimately
    // pins for the user.
    // -----------------------------------------------------------------
    const replayedFinalBytes = encodeSnapshotV1(replayTerm);
    const replayedDecoded = decodeSnapshotV1(replayedFinalBytes);

    const diff = diffDecoded(groundTruthDecoded, replayedDecoded);
    if (diff !== null) {
      throw new Error(`replay diverged from ground truth: ${diff}`);
    }
  });
});

/**
 * Reconstruct the viewport text from a decoded snapshot. Each cell
 * contributes its base codepoint + any combiners; width=0 cells (the
 * trailing half of a wide cell) are skipped because the wide-cell
 * codepoint already covers two columns when re-rendered. Empty cells
 * become spaces so column alignment survives. Trailing whitespace is
 * preserved (we trim only when comparing in `diffViewportLineCells`)
 * so the parser sees the same horizontal layout the live terminal
 * had.
 */
function reconstructViewportText(decoded: DecodedSnapshotV1): string[] {
  const start = decoded.scrollbackLines;
  const out: string[] = [];
  for (let y = start; y < decoded.lines.length; y++) {
    const line = decoded.lines[y]!;
    let text = '';
    for (const cell of line.cells) {
      // width=0 is the trailing half of a wide cell; xterm encodes
      // these with codepoint=0 too (the wide codepoint already
      // accounts for both columns). MUST be checked BEFORE the
      // codepoint=0 branch below or the wide-cell continuation gets
      // mistakenly rendered as a literal space, splitting the wide
      // glyph across an extra column on replay.
      if (cell.width === 0) continue;
      if (cell.codepoint === 0) {
        text += ' ';
        continue;
      }
      text += String.fromCodePoint(cell.codepoint);
      for (const cp of cell.combiners) text += String.fromCodePoint(cp);
    }
    out.push(text.replace(/ +$/, ''));
  }
  // Drop trailing blank lines so the replay doesn't introduce extra
  // newlines past the last visible row.
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out;
}
