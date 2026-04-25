/**
 * Translate `SDKMessage` (the @anthropic-ai/claude-agent-sdk surface) into
 * `ClaudeStreamEvent` (the wire-shape ccsm's renderer / stream-to-blocks
 * pipeline already consumes).
 *
 * Why translate at all: ccsm's existing render path was built against the
 * spawn-claude wire protocol (M1 §3, see electron/agent/stream-json-types.ts).
 * The SDK's `SDKMessage` is the SAME protocol re-typed by Anthropic's SDK,
 * with a few field renames and added housekeeping events (status, hook
 * lifecycle, tool progress, etc.).
 *
 * Strategy:
 *   - For the four "big bucket" frames (`system`, `assistant`, `user`,
 *     `result`) the shape is structurally identical — we cast through unknown
 *     so TypeScript doesn't reject incidental field-presence differences
 *     (e.g. SDK includes `claude_code_version` on init that ccsm's schema
 *     marks as passthrough).
 *   - SDK-specific bookkeeping messages (status, hook_started, hook_progress,
 *     hook_response, partial_assistant, tool_progress, task_*, etc.) have no
 *     ccsm-side consumer today and we filter them out (return null).
 *   - Compact_boundary maps directly onto ccsm's existing system event with
 *     subtype `'compact_boundary'`.
 *
 * Anything we can't map gets dropped with a console.warn — better than
 * pushing a malformed frame the renderer might crash on. We deliberately
 * never throw: a single unknown SDK message type must not kill the session.
 */
import type {
  ClaudeStreamEvent,
  SystemEvent,
  AssistantEvent,
  UserEvent,
  ResultEvent,
} from '../agent/stream-json-types';

// We intentionally use a structural type for SDKMessage rather than importing
// the SDK's types at module-load: the SDK is ESM and ccsm is CJS, so importing
// types eagerly would tangle the build. Dynamic import in the runner gives us
// the runtime; here we only need the shape.
export type SdkMessageLike = {
  type: string;
  subtype?: string;
  // Anything else is preserved by passthrough.
  [k: string]: unknown;
};

/**
 * Translate one SDK message into the ccsm ClaudeStreamEvent shape, or return
 * `null` to drop the message (no renderer consumer today).
 */
export function translateSdkMessage(msg: SdkMessageLike): ClaudeStreamEvent | null {
  switch (msg.type) {
    case 'system':
      // All system subtypes ccsm already understands (init, compact_boundary,
      // api_retry) pass straight through. New SDK system subtypes (status,
      // task_notification, hook_started, etc.) have no ccsm consumer — drop
      // them quietly so they don't show up as `unknown` warnings in dogfood.
      if (
        msg.subtype === 'init' ||
        msg.subtype === 'compact_boundary' ||
        msg.subtype === 'api_retry'
      ) {
        return msg as unknown as SystemEvent;
      }
      return null;

    case 'assistant':
      return msg as unknown as AssistantEvent;

    case 'user':
      // SDK emits both `user` (live) and `user_replay` via the same `type:
      // 'user'` discriminator (replay carries `isReplay: true`). ccsm's
      // UserEvent passthrough shape accepts the extra fields; renderer
      // currently treats replays the same as live user messages.
      return msg as unknown as UserEvent;

    case 'result':
      return msg as unknown as ResultEvent;

    // SDK-only messages with no ccsm renderer wiring today. Listed
    // exhaustively (rather than a default-drop) so a future SDK addition
    // shows up as an `unknown` warning in dev — that's how we'll discover
    // we need to add a translation.
    case 'stream_event':
      // Partial assistant streaming. ccsm's PartialAssistantStreamer in the
      // renderer consumes `stream_event` frames; pass through.
      return msg as unknown as ClaudeStreamEvent;
    case 'agent_metadata':
      return msg as unknown as ClaudeStreamEvent;

    case 'status':
    case 'hook_started':
    case 'hook_progress':
    case 'hook_response':
    case 'tool_progress':
    case 'tool_use_summary':
    case 'auth_status':
    case 'memory_recall':
    case 'rate_limit':
    case 'elicitation_complete':
    case 'prompt_suggestion':
    case 'plugin_install':
    case 'mirror_error':
    case 'files_persisted':
    case 'session_state_changed':
    case 'notification':
    case 'local_command_output':
      return null;

    default:
      // Unknown SDK message type — log so we notice in dev, but don't break
      // the session. Renderer would reject it as malformed anyway.
      console.warn('[agent-sdk] dropping unknown SDK message type', msg.type);
      return null;
  }
}
