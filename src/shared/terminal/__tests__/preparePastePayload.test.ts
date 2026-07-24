// Browser-safe (no Node/Electron deps) contract for the shared paste
// normalizer. Desktop (`src/terminal/paste.ts`) and mobile submission
// (`electron/ptyHost/lifecycle.ts`) both prepare the SAME payload shape
// before writing to a PTY: CRLF/lone-CR normalized to LF, optionally
// wrapped exactly once in bracketed-paste sentinels.

import { describe, expect, it } from 'vitest';
import { preparePastePayload } from '../preparePastePayload';

describe('preparePastePayload', () => {
  it('normalizes CRLF and lone CR without changing LF', () => {
    expect(preparePastePayload('a\r\nb\rc\n', false)).toBe('a\nb\nc\n');
  });

  it('wraps the complete normalized draft once in bracketed paste', () => {
    expect(preparePastePayload('你好\r\nworld', true)).toBe(
      '\x1b[200~你好\nworld\x1b[201~',
    );
  });
});
