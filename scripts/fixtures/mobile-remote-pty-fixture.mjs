// Deterministic ANSI PTY fixture for the mobile remote buffer-parity and
// fault-injection dogfood (composer/terminal-sync plan, Task 6).
//
// Every chunk carries text that is unique across the *entire* fixture (each
// numbered line has its own `FIXTURE-LINE-NNN` marker; every structural
// chunk — start, progress-done, after-clear, alt-screen, end — has its own
// distinct marker too). That is what makes duplicate/stale/gap assertions
// unambiguous: a single unintended re-application of any one chunk (a
// duplicate that should have been dropped, a stale frame that should never
// have been written, a gap that should have been closed by exactly one
// snapshot) shows up as a plain, exact substring-count mismatch on the
// final serialized buffer — no fuzzy/partial matching, no guessing which
// line moved.
//
// The fixture still exercises every ANSI behavior the read-only xterm
// adapter must round-trip byte-for-byte:
//   - CR overwrite           -> `progress 0%` -> 50% -> 100% via \r + EL
//   - clear-screen + home    -> \x1b[2J\x1b[H before FIXTURE-AFTER-CLEAR
//   - long lines             -> 120 numbered lines, scrollback + line-wrap
//   - alternate screen       -> enter/write/exit \x1b[?1049h ... \x1b[?1049l
//
// ORDERING IS LOAD-BEARING. A full-screen erase (`\x1b[2J`) only blanks
// whatever is *currently on screen* — rows that have already scrolled into
// scrollback survive untouched, but the terminal's exact viewport height is
// unknown until the real phone browser reports it (Task 6 Step C determines
// dimensions from the phone's own `session.resize`), so this fixture must
// never depend on a specific row count to decide what a clear-screen does
// or doesn't destroy. To stay dimension-independent:
//   1. FIXTURE-START and the CR-overwrite progress marker are written FIRST
//      and are immediately erased by the one clear-screen chunk that
//      follows them — they are deterministically ABSENT from any correct
//      final buffer, regardless of terminal size. Their presence would mean
//      the clear-screen chunk itself was dropped or never applied.
//   2. FIXTURE-AFTER-CLEAR, all 120 numbered lines, and FIXTURE-END are
//      written AFTER that single clear-screen and are never erased again —
//      they are deterministically present EXACTLY ONCE in any correct final
//      buffer, regardless of terminal size.
//   3. The alternate-screen demonstration is isolated by construction: it
//      enters, writes, and exits the alt buffer within one chunk, so
//      FIXTURE-ALT-SCREEN-ONLY is deterministically ABSENT from the normal
//      buffer's serialize() no matter where it sits in the stream or what
//      the terminal's dimensions are.

export const FIXTURE_START_MARKER = 'FIXTURE-START';
export const FIXTURE_PROGRESS_DONE_MARKER = 'FIXTURE-PROGRESS-100';
export const FIXTURE_AFTER_CLEAR_MARKER = 'FIXTURE-AFTER-CLEAR';
export const FIXTURE_ALT_SCREEN_MARKER = 'FIXTURE-ALT-SCREEN-ONLY';
export const FIXTURE_END_MARKER = 'FIXTURE-END';

// Markers that are deterministically ERASED by the fixture's own
// clear-screen chunk — a correct final buffer must never contain them.
// Their disappearance is itself an assertion: it proves the clear-screen
// chunk (and only that chunk) was applied.
export const FIXTURE_ERASED_MARKERS = [FIXTURE_START_MARKER, FIXTURE_PROGRESS_DONE_MARKER];

// Number of long numbered lines (each individually unique via its marker).
// All are written after the fixture's one clear-screen, so every single one
// is safe to assert "appears exactly once" regardless of terminal size.
export const FIXTURE_LINE_COUNT = 120;

/** The unique, greppable marker embedded in numbered line `n` (1-based). */
export function fixtureLineMarker(n) {
  return `FIXTURE-LINE-${String(n).padStart(3, '0')}`;
}

function fixtureLine(n) {
  // 96 'x' payload -> comfortably wraps/scrolls at any realistic phone
  // terminal width while keeping the marker itself trivially greppable.
  return `${fixtureLineMarker(n)} ${'x'.repeat(96)}\r\n`;
}

export const MOBILE_TERMINAL_FIXTURE = [
  `${FIXTURE_START_MARKER}\r\n`,
  'progress 0%',
  '\r\x1b[2Kprogress 50%',
  `\r\x1b[2K${FIXTURE_PROGRESS_DONE_MARKER}\r\n`,
  `\x1b[2J\x1b[H${FIXTURE_AFTER_CLEAR_MARKER}\r\n`,
  `\x1b[?1049h${FIXTURE_ALT_SCREEN_MARKER}\r\n\x1b[?1049l`,
  ...Array.from({ length: FIXTURE_LINE_COUNT }, (_, index) => fixtureLine(index + 1)),
  `${FIXTURE_END_MARKER}\r\n`,
];

export const FIXTURE_CHUNK_COUNT = MOBILE_TERMINAL_FIXTURE.length;

// Every marker guaranteed present EXACTLY ONCE in a correct final buffer,
// regardless of terminal dimensions (see the ordering note above).
export const FIXTURE_SURVIVING_MARKERS = [
  FIXTURE_AFTER_CLEAR_MARKER,
  ...Array.from({ length: FIXTURE_LINE_COUNT }, (_, index) => fixtureLineMarker(index + 1)),
  FIXTURE_END_MARKER,
];

/**
 * Attaches a monotonically increasing `seq` (starting at `startSeq`, default
 * 1) to every fixture chunk, matching the wire shape of a server `pty.data`
 * message body (`{ seq, chunk }`).
 */
export function sequencedFixture(startSeq = 1) {
  return MOBILE_TERMINAL_FIXTURE.map((chunk, index) => ({
    seq: startSeq + index,
    chunk,
  }));
}
