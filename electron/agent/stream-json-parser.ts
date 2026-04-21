/**
 * Stream-JSON line parser. Operates on a single trimmed NDJSON line at a time;
 * NDJSON splitting / buffering is the caller's job (see M1 §3.3 NdjsonParser).
 *
 * Parser philosophy:
 *   - Never throw. The wire is hostile (forward-compat schema drift, half-broken
 *     mock servers, debug noise). Always return a tagged result.
 *   - Three outcomes:
 *       'event'        — JSON parsed AND zod recognised the shape
 *       'unknown'      — JSON parsed but no zod schema matched (forward-compat)
 *       'parse-error'  — line wasn't valid JSON
 *   - Schema is `.passthrough()` everywhere, so unknown fields ride along on
 *     `event` instead of getting silently dropped.
 */

import {
  ClaudeStreamEventSchema,
  type ClaudeStreamEvent,
  type ClaudeOutgoingEvent
} from './stream-json-types';

export type ParseResult =
  | { type: 'event'; event: ClaudeStreamEvent }
  | { type: 'unknown'; raw: object; reason: string }
  | { type: 'parse-error'; error: Error; raw: string };

/**
 * Parse one raw NDJSON line into a typed event.
 * The input should already be trimmed and non-empty; passing an empty/whitespace
 * line returns a parse-error (treat upstream as a bug).
 */
export function parseStreamJSONLine(raw: string): ParseResult {
  if (typeof raw !== 'string') {
    return {
      type: 'parse-error',
      error: new Error(`expected string, got ${typeof raw}`),
      raw: String(raw)
    };
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    return {
      type: 'parse-error',
      error: new Error('empty line'),
      raw
    };
  }

  let json: unknown;
  try {
    json = JSON.parse(trimmed);
  } catch (e) {
    return {
      type: 'parse-error',
      error: e instanceof Error ? e : new Error(String(e)),
      raw
    };
  }

  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    return {
      type: 'unknown',
      raw: { value: json } as object,
      reason: 'top-level JSON is not an object'
    };
  }

  const result = ClaudeStreamEventSchema.safeParse(json);
  if (result.success) {
    return { type: 'event', event: result.data as ClaudeStreamEvent };
  }

  // Build a compact reason that helps logging without dumping full zod tree.
  const obj = json as Record<string, unknown>;
  const typeField = typeof obj.type === 'string' ? obj.type : '<missing>';
  const subtypeField = typeof obj.subtype === 'string' ? `:${obj.subtype}` : '';
  const firstIssue = result.error.issues[0];
  const issueMsg = firstIssue
    ? `${firstIssue.path.join('.') || '<root>'}: ${firstIssue.message}`
    : 'unknown validation failure';

  return {
    type: 'unknown',
    raw: obj,
    reason: `type=${typeField}${subtypeField} did not match any schema (${issueMsg})`
  };
}

/**
 * Serialize an outbound event to a single NDJSON line (with trailing '\n').
 *
 * Note: we don't validate against the outgoing schema here — callers may want
 * to pass shapes that are not yet pinned down (e.g. apply_flag_settings whose
 * fields are unconfirmed). Validation is opt-in via the schemas if you want it.
 */
export function serializeOutgoing(event: ClaudeOutgoingEvent): string {
  const line = JSON.stringify(event);
  return line + '\n';
}
