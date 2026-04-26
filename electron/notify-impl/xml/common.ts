// Shared helpers for building Windows Adaptive Toast XML.
//
// We hand-roll the XML rather than pulling in a templating dep — the schema
// is small, fully documented by Microsoft, and golden-file tests catch any
// regression. Output is a single line with no leading/trailing whitespace so
// fixture diffs stay readable.

const XML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};

/** Escape a string for safe inclusion in an XML attribute or text node. */
export function xmlEscape(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => XML_ESCAPES[ch] ?? ch);
}

/**
 * Build a `key=value&key=value` query string for the toast `arguments=`
 * attribute. Values are URI-encoded so they survive the round-trip through
 * Windows Notification Platform → activation event → our parser.
 *
 * Order is preserved — golden-file tests rely on stable output.
 */
export function buildActionArgs(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

/**
 * Inverse of `buildActionArgs`. Tolerates missing values and `?`-prefixed
 * strings (defensive — the OS occasionally hands back the raw launch URL).
 */
export function parseActionArgs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  const trimmed = raw.startsWith('?') ? raw.slice(1) : raw;
  if (trimmed.length === 0) return out;
  for (const part of trimmed.split('&')) {
    if (part.length === 0) continue;
    const eq = part.indexOf('=');
    const key = eq === -1 ? part : part.slice(0, eq);
    const value = eq === -1 ? '' : part.slice(eq + 1);
    out[decodeURIComponent(key)] = decodeURIComponent(value);
  }
  return out;
}

/** Common per-build options injected by the WindowsAdapter. */
export interface XmlBuildOptions {
  /** Absolute path to a square PNG icon (rendered as appLogoOverride). */
  iconPath?: string;
  /** When true, emits `<audio silent="true"/>`. */
  silent?: boolean;
}

/** Render the optional <audio> element. */
export function audioElement(silent: boolean | undefined): string {
  return silent === true ? '<audio silent="true"/>' : '';
}

/** Render the optional appLogoOverride image inside a binding. */
export function appLogoElement(iconPath: string | undefined): string {
  if (!iconPath) return '';
  // hint-crop="circle" matches the chat avatar treatment used elsewhere in
  // CCSM and keeps the toast visually anchored.
  return `<image placement="appLogoOverride" hint-crop="circle" src="${xmlEscape(
    iconPath,
  )}"/>`;
}
