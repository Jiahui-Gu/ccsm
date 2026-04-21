/**
 * Stream-JSON protocol types & runtime schemas (zod) for talking to `claude.exe`
 * spawned with `--output-format stream-json --input-format stream-json --verbose`.
 *
 * Sources (line refs into reverse-engineering docs):
 *   - migration/M1-spawn-claude-exe-guide.md §3 (protocol overview, lines 175-367)
 *   - sections/S2-session-engine.md §4 (stream-json detail, lines 283-379)
 *   - sections/S2-session-engine.md §5 (control_request RPC, lines 381-480)
 *
 * Design rules:
 *   - Every object schema uses `.passthrough()` so unknown fields survive — anthropic
 *     adds fields without bumping any version, and silently dropping them = bugs.
 *   - Discriminated unions on `type` (and on `subtype` for control_request.request)
 *     so TypeScript can narrow.
 *   - `unknown` is preferred over `any` everywhere.
 *   - Many fields here are confirmed only from S2/M1 docs, not from a real recorded
 *     session. See fixtures/stream-json/SCHEMA-NOTES.md for the audit.
 */

import { z } from 'zod';

// =====================================================================
// Content blocks — shared between assistant / user messages
// =====================================================================

export const TextBlockSchema = z
  .object({
    type: z.literal('text'),
    text: z.string()
  })
  .passthrough();

export const ThinkingBlockSchema = z
  .object({
    type: z.literal('thinking'),
    thinking: z.string(),
    signature: z.string().optional()
  })
  .passthrough();

export const ToolUseBlockSchema = z
  .object({
    type: z.literal('tool_use'),
    id: z.string(),
    name: z.string(),
    input: z.unknown()
  })
  .passthrough();

// `server_tool_use` appears in S2 line 301 alongside tool_use; same shape.
export const ServerToolUseBlockSchema = z
  .object({
    type: z.literal('server_tool_use'),
    id: z.string(),
    name: z.string(),
    input: z.unknown()
  })
  .passthrough();

export const ToolResultBlockSchema = z
  .object({
    type: z.literal('tool_result'),
    tool_use_id: z.string(),
    // Anthropic API allows either a plain string or an array of content parts
    // (`{type:'text', text}` / `{type:'image', source:...}`). Keep it loose.
    content: z.union([z.string(), z.array(z.unknown())]).optional(),
    is_error: z.boolean().optional()
  })
  .passthrough();

export const ContentBlockSchema = z.discriminatedUnion('type', [
  TextBlockSchema,
  ThinkingBlockSchema,
  ToolUseBlockSchema,
  ServerToolUseBlockSchema,
  ToolResultBlockSchema
]);

export type TextBlock = z.infer<typeof TextBlockSchema>;
export type ThinkingBlock = z.infer<typeof ThinkingBlockSchema>;
export type ToolUseBlock = z.infer<typeof ToolUseBlockSchema>;
export type ServerToolUseBlock = z.infer<typeof ServerToolUseBlockSchema>;
export type ToolResultBlock = z.infer<typeof ToolResultBlockSchema>;
export type ContentBlock = z.infer<typeof ContentBlockSchema>;

// =====================================================================
// MCP server descriptor (appears in system init)
// =====================================================================

export const McpServerInfoSchema = z
  .object({
    name: z.string(),
    status: z.string()
  })
  .passthrough();
export type McpServerInfo = z.infer<typeof McpServerInfoSchema>;

// =====================================================================
// 1) SystemEvent — first frame after spawn (init handshake)
//    M1 §3.1 table; M1 §3.4 SystemFrame; S2 §4.2 lines 339-342.
//    Also covers later system frames with subtype: compact_boundary / api_retry
//    (those are confirmed against existing src/agent/sdk-to-blocks.ts
//    systemBlocks() handler).
// =====================================================================

export const SystemInitSchema = z
  .object({
    type: z.literal('system'),
    subtype: z.literal('init'),
    session_id: z.string(),
    tools: z.array(z.string()).optional(),
    mcp_servers: z.array(McpServerInfoSchema).optional(),
    model: z.string().optional(),
    cwd: z.string().optional(),
    permissionMode: z.string().optional(),
    apiKeySource: z.string().optional(),
    uuid: z.string().optional()
  })
  .passthrough();

export const SystemCompactBoundarySchema = z
  .object({
    type: z.literal('system'),
    subtype: z.literal('compact_boundary'),
    session_id: z.string().optional(),
    uuid: z.string().optional(),
    compact_metadata: z
      .object({
        trigger: z.string().optional(),
        pre_tokens: z.number().optional(),
        post_tokens: z.number().optional(),
        duration_ms: z.number().optional()
      })
      .passthrough()
      .optional()
  })
  .passthrough();

export const SystemApiRetrySchema = z
  .object({
    type: z.literal('system'),
    subtype: z.literal('api_retry'),
    session_id: z.string().optional(),
    uuid: z.string().optional(),
    attempt: z.number().optional(),
    max_retries: z.number().optional(),
    retry_delay_ms: z.number().optional(),
    error_status: z.union([z.number(), z.string()]).optional()
  })
  .passthrough();

// Catch-all for any other system subtype we haven't pinned down (rate_limit etc.)
export const SystemOtherSchema = z
  .object({
    type: z.literal('system'),
    subtype: z.string().optional(),
    session_id: z.string().optional(),
    uuid: z.string().optional()
  })
  .passthrough();

// Note: we deliberately don't use z.discriminatedUnion on subtype here because
// SystemOtherSchema would conflict with the literal subtypes. The union order
// matters for parse() — try the most specific schemas first.
export const SystemEventSchema = z.union([
  SystemInitSchema,
  SystemCompactBoundarySchema,
  SystemApiRetrySchema,
  SystemOtherSchema
]);
export type SystemEvent = z.infer<typeof SystemEventSchema>;

// =====================================================================
// 2) AssistantEvent — fully accumulated assistant message
//    M1 §3.4 AssistantFrame; S2 §4.2 lines 344-346.
// =====================================================================

export const AssistantMessageSchema = z
  .object({
    id: z.string(),
    type: z.literal('message').optional(),
    role: z.literal('assistant'),
    model: z.string().optional(),
    content: z.array(ContentBlockSchema),
    stop_reason: z.string().nullable().optional(),
    stop_sequence: z.string().nullable().optional(),
    usage: z.unknown().optional()
  })
  .passthrough();

export const AssistantEventSchema = z
  .object({
    type: z.literal('assistant'),
    session_id: z.string(),
    parent_tool_use_id: z.string().nullable().optional(),
    uuid: z.string().optional(),
    message: AssistantMessageSchema
  })
  .passthrough();
export type AssistantEvent = z.infer<typeof AssistantEventSchema>;

// =====================================================================
// 3) UserEvent — echo of user input or injected tool_result
//    M1 §3.4 UserFrame; S2 §4.2 line 342.
// =====================================================================

export const UserMessagePayloadSchema = z
  .object({
    role: z.literal('user'),
    content: z.union([z.string(), z.array(ContentBlockSchema)])
  })
  .passthrough();

export const UserEventSchema = z
  .object({
    type: z.literal('user'),
    session_id: z.string(),
    parent_tool_use_id: z.string().nullable().optional(),
    uuid: z.string().optional(),
    isSynthetic: z.boolean().optional(),
    message: UserMessagePayloadSchema
  })
  .passthrough();
export type UserEvent = z.infer<typeof UserEventSchema>;

// =====================================================================
// 4) ResultEvent — turn done
//    M1 §3.4 ResultFrame.
// =====================================================================

// Subtype list from M1 §3.4 (line ~310). NOT exhaustive — we keep it as a
// passthrough string so unknown subtypes don't get rejected.
export const RESULT_SUBTYPES = [
  'success',
  'error',
  'cancelled',
  'error_max_turns',
  'error_during_execution'
] as const;

export const UsageSchema = z
  .object({
    input_tokens: z.number().optional(),
    output_tokens: z.number().optional(),
    cache_creation_input_tokens: z.number().optional(),
    cache_read_input_tokens: z.number().optional()
  })
  .passthrough();

export const ResultEventSchema = z
  .object({
    type: z.literal('result'),
    subtype: z.string(), // not enum — Anthropic adds new subtypes silently
    is_error: z.boolean(),
    session_id: z.string(),
    uuid: z.string().optional(),
    duration_ms: z.number().optional(),
    duration_api_ms: z.number().optional(),
    num_turns: z.number().optional(),
    total_cost_usd: z.number().optional(),
    usage: UsageSchema.optional(),
    result: z.string().optional(),
    error: z.string().optional()
  })
  .passthrough();
export type ResultEvent = z.infer<typeof ResultEventSchema>;

// =====================================================================
// 5) ControlRequestEvent — RPC from claude.exe asking us to do something
//    M1 §3.4 ControlRequestFrame; S2 §5.2 lines 393-426.
// =====================================================================

export const CanUseToolRequestSchema = z
  .object({
    subtype: z.literal('can_use_tool'),
    tool_name: z.string(),
    tool_use_id: z.string(),
    agent_id: z.string().optional(),
    input: z.unknown(),
    permission_suggestions: z.array(z.unknown()).optional(),
    blocked_path: z.string().optional(),
    decision_reason: z.string().optional(),
    title: z.string().optional(),
    display_name: z.string().optional(),
    description: z.string().optional()
  })
  .passthrough();

export const HookCallbackRequestSchema = z
  .object({
    subtype: z.literal('hook_callback'),
    callback_id: z.string(),
    input: z.unknown(),
    tool_use_id: z.string().optional()
  })
  .passthrough();

export const McpMessageRequestSchema = z
  .object({
    subtype: z.literal('mcp_message'),
    server_name: z.string(),
    message: z.unknown()
  })
  .passthrough();

export const ControlRequestPayloadSchema = z.discriminatedUnion('subtype', [
  CanUseToolRequestSchema,
  HookCallbackRequestSchema,
  McpMessageRequestSchema
]);

export const ControlRequestEventSchema = z
  .object({
    type: z.literal('control_request'),
    request_id: z.string(),
    request: ControlRequestPayloadSchema
  })
  .passthrough();
export type ControlRequestEvent = z.infer<typeof ControlRequestEventSchema>;

// =====================================================================
// Auxiliary inbound frames (kept in the discriminated union so callers see
// them but they aren't on the "5 big buckets" list)
// =====================================================================

export const ControlResponseEventSchema = z
  .object({
    type: z.literal('control_response'),
    request_id: z.string(),
    response: z.unknown()
  })
  .passthrough();
export type ControlResponseEvent = z.infer<typeof ControlResponseEventSchema>;

export const ControlCancelRequestEventSchema = z
  .object({
    type: z.literal('control_cancel_request'),
    request_id: z.string()
  })
  .passthrough();
export type ControlCancelRequestEvent = z.infer<typeof ControlCancelRequestEventSchema>;

// stream_event wraps Anthropic Messages streaming events when
// --include-partial-messages is on. Inner shape varies wildly so we keep the
// payload as `unknown` for now — see SCHEMA-NOTES.md.
export const StreamEventFrameSchema = z
  .object({
    type: z.literal('stream_event'),
    session_id: z.string(),
    event: z.unknown(),
    parent_tool_use_id: z.string().nullable().optional(),
    uuid: z.string().optional()
  })
  .passthrough();
export type StreamEventFrame = z.infer<typeof StreamEventFrameSchema>;

export const AgentMetadataEventSchema = z
  .object({
    type: z.literal('agent_metadata'),
    agent_id: z.string(),
    parent_agent_id: z.string().nullable().optional(),
    session_id: z.string().optional()
  })
  .passthrough();
export type AgentMetadataEvent = z.infer<typeof AgentMetadataEventSchema>;

// =====================================================================
// Top-level inbound discriminated union
// =====================================================================

// We can't use z.discriminatedUnion on `type` because SystemEventSchema is
// itself a union (subtype split). Use z.union and let the parser try each.
export const ClaudeStreamEventSchema = z.union([
  SystemEventSchema,
  AssistantEventSchema,
  UserEventSchema,
  ResultEventSchema,
  ControlRequestEventSchema,
  ControlResponseEventSchema,
  ControlCancelRequestEventSchema,
  StreamEventFrameSchema,
  AgentMetadataEventSchema
]);

export type ClaudeStreamEvent =
  | SystemEvent
  | AssistantEvent
  | UserEvent
  | ResultEvent
  | ControlRequestEvent
  | ControlResponseEvent
  | ControlCancelRequestEvent
  | StreamEventFrame
  | AgentMetadataEvent;

// =====================================================================
// Outbound (we → claude.exe). M1 §3.2.
// =====================================================================

// (a) User message — written to stdin.
//     M1 §3.2 lines 198-207.
export const UserMessageEventSchema = z
  .object({
    type: z.literal('user'),
    uuid: z.string(),
    session_id: z.string(),
    parent_tool_use_id: z.string().nullable().default(null),
    isSynthetic: z.boolean().default(false),
    message: z
      .object({
        role: z.literal('user'),
        content: z.union([z.string(), z.array(ContentBlockSchema)])
      })
      .passthrough()
  })
  .passthrough();
export type UserMessageEvent = z.infer<typeof UserMessageEventSchema>;

// (b) Control response — answers a control_request from claude.exe.
//     M1 §3.2 lines 209-216.
export const ControlResponsePayloadSchema = z.union([
  z
    .object({
      behavior: z.literal('allow'),
      updatedInput: z.unknown().optional(),
      toolUseID: z.string().optional()
    })
    .passthrough(),
  z
    .object({
      behavior: z.literal('deny'),
      message: z.string(),
      toolUseID: z.string().optional()
    })
    .passthrough(),
  // Hook callbacks / mcp_message responses don't have a `behavior` field;
  // shape varies. Keep it permissive.
  z.record(z.string(), z.unknown())
]);

export const OutgoingControlResponseSchema = z
  .object({
    type: z.literal('control_response'),
    request_id: z.string(),
    response: ControlResponsePayloadSchema
  })
  .passthrough();
export type OutgoingControlResponse = z.infer<typeof OutgoingControlResponseSchema>;

// (c) Control commands we initiate. M1 §3.2 lines 218-231.
//     Full list (M1 line 230-231): interrupt, set_permission_mode, set_model,
//     set_max_thinking_tokens, apply_flag_settings, get_settings, rewind_files,
//     summary. Field schemas for the latter four are NOT confirmed — see
//     SCHEMA-NOTES.md.

export const InterruptCommandSchema = z
  .object({ subtype: z.literal('interrupt') })
  .passthrough();

export const SetPermissionModeCommandSchema = z
  .object({
    subtype: z.literal('set_permission_mode'),
    mode: z.enum(['default', 'acceptEdits', 'plan', 'bypassPermissions'])
  })
  .passthrough();

export const SetModelCommandSchema = z
  .object({
    subtype: z.literal('set_model'),
    model: z.string()
  })
  .passthrough();

export const SetMaxThinkingTokensCommandSchema = z
  .object({
    subtype: z.literal('set_max_thinking_tokens'),
    tokens: z.number()
  })
  .passthrough();

// rewind_files / apply_flag_settings / get_settings / summary: field shape
// not confirmed. Accept any object with a `subtype` string for forward-compat.
export const UnknownCommandSchema = z
  .object({ subtype: z.string() })
  .passthrough();

export const ControlCommandPayloadSchema = z.union([
  InterruptCommandSchema,
  SetPermissionModeCommandSchema,
  SetModelCommandSchema,
  SetMaxThinkingTokensCommandSchema,
  UnknownCommandSchema
]);

export const ControlCommandEventSchema = z
  .object({
    type: z.literal('control_request'),
    request_id: z.string(),
    request: ControlCommandPayloadSchema
  })
  .passthrough();
export type ControlCommandEvent = z.infer<typeof ControlCommandEventSchema>;

export type ClaudeOutgoingEvent =
  | UserMessageEvent
  | OutgoingControlResponse
  | ControlCommandEvent;

// Re-export a single union schema for callers that want to validate before send.
export const ClaudeOutgoingEventSchema = z.union([
  UserMessageEventSchema,
  OutgoingControlResponseSchema,
  ControlCommandEventSchema
]);
