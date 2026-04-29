// OSC 0 title leading-glyph classifier.
//
// The Claude CLI binary emits OSC 0 (`\x1b]0;TITLE\x07`) per agent state
// transition, encoding state via the leading glyph of the title:
//   - `✳ Claude Code` (U+2733)        — idle / waiting for user input
//   - `⠂` / `⠐` / `⠁` ... Braille      — running (one of the spinner frames)
//   - `claude` plain                   — boot / exit (no glyph)
//
// xterm.js exposes `term.onTitleChange(title => ...)`; this classifier turns
// the raw title string into a stable enum the notify bridge can dedupe and
// transition-detect against. Pure function, no side effects.

export type TitleState = 'idle' | 'running' | 'unknown';

// U+2800 .. U+28FF — the Braille Patterns block. The CLI uses these glyphs
// as spinner frames while a turn is in flight.
const BRAILLE_RE = /^[⠀-⣿]/;
// U+2733 sparkle, the leading glyph the CLI uses when it is idle and waiting
// for user input. Match only the leading codepoint; the rest of the title
// is the constant "Claude Code" suffix and we do not depend on it.
const SPARKLE_RE = /^✳/;

export function classifyTitleState(title: string | null | undefined): TitleState {
  if (typeof title !== 'string' || title.length === 0) return 'unknown';
  if (SPARKLE_RE.test(title)) return 'idle';
  if (BRAILLE_RE.test(title)) return 'running';
  return 'unknown';
}
