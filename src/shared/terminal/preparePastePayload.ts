// Browser-safe (no Node/Electron deps) paste/submission normalizer shared
// by desktop clipboard paste (`src/terminal/paste.ts`) and the mobile
// composer's complete-draft submission (`electron/ptyHost/lifecycle.ts`).
//
// Transparent-transport invariant (project memory): the ONLY rewrite this
// function performs is CRLF/lone-CR → LF normalization, plus wrapping the
// WHOLE normalized text exactly once in bracketed-paste sentinels when the
// target PTY has bracketed-paste mode active. No chunking, no length cap,
// no content-shaped rewriting — every other byte passes through unchanged.

export const BRACKETED_PASTE_START = '\x1b[200~';
export const BRACKETED_PASTE_END = '\x1b[201~';

export function preparePastePayload(text: string, bracketed: boolean): string {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return bracketed
    ? `${BRACKETED_PASTE_START}${normalized}${BRACKETED_PASTE_END}`
    : normalized;
}
