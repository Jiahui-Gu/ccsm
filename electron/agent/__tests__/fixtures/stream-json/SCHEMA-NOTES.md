# Stream-JSON fixture provenance & schema audit

All `*.jsonl` files in this directory are **hand-crafted** from the
reverse-engineering docs:

- `migration/M1-spawn-claude-exe-guide.md` §3 (lines 175-367)
- `sections/S2-session-engine.md` §4-5 (lines 283-480)

**No file here was recorded from a live `claude.exe` session.** They exist so
the parser unit tests can run without a binary. Phase 2 (record real samples
with `--debug --debug-to-stderr` and a throwaway gateway token) will replace
each fixture with a real-world line and we will diff to flush out missing
fields.

---

## What we're confident about (cited)

| Field path | Source |
|---|---|
| `system.subtype = "init"` first frame | M1 §3.1 table (line 183) |
| `system.session_id` | M1 §3.4 SystemFrame; S2 line 339 |
| `system.tools / model / mcp_servers / permissionMode / apiKeySource / cwd` | M1 §3.4 lines 275-285 |
| `assistant.message.{id, role, model, content[], stop_reason, usage}` | M1 §3.4 lines 287-299 |
| `user.message.{role, content[]}` (echo + tool_result injection) | M1 §3.4 lines 301-306; S2 line 342 |
| ContentBlock variants: `text` / `thinking` / `tool_use` / `tool_result` | M1 §3.4 lines 264-273 |
| `server_tool_use` block type | S2 line 301 |
| `result.{subtype, is_error, session_id, duration_ms, duration_api_ms, num_turns, total_cost_usd, usage, result}` | M1 §3.4 lines 308-319 |
| `control_request.request_id`, `request.subtype` discriminator | M1 §3.4 lines 321-344; S2 §5.2 lines 397-413 |
| `can_use_tool` request fields: `tool_name, tool_use_id, agent_id, input, permission_suggestions, blocked_path, decision_reason, title, display_name, description` | M1 §3.4 lines 326-336; S2 §5.2 lines 401-411 |
| `hook_callback`: `callback_id, input, tool_use_id?` | M1 §3.4 lines 338-340; S2 §5.3 line 468 |
| `mcp_message`: `server_name, message` | M1 §3.4 lines 341-342; S2 §5.3 line 472 |
| outbound `user`: `type, uuid, session_id, parent_tool_use_id, isSynthetic, message` | M1 §3.2 lines 198-207 |
| outbound `control_response`: `type, request_id, response.{behavior, message?, updatedInput?, toolUseID}` | M1 §3.2 lines 209-216; S2 §5.2 lines 415-426 |
| outbound control commands `interrupt / set_permission_mode {mode} / set_model {model} / set_max_thinking_tokens {tokens}` | M1 §3.2 lines 218-228 |

## What's inferred / partially confirmed

| Field path | Status | Reason |
|---|---|---|
| `system.subtype = "compact_boundary" / "api_retry"` and their fields | Inferred from existing `src/agent/sdk-to-blocks.ts` `systemBlocks()` handler. SDK message likely == stream-json frame here. Fixtures `compact_boundary.jsonl` / `api_retry.jsonl` reverse-engineered from those reads (`compact_metadata.{trigger,pre_tokens,post_tokens,duration_ms}` and `attempt/max_retries/retry_delay_ms/error_status`). Real samples still pending. |
| `result.subtype` enum values | M1 lists `success/error/cancelled/error_max_turns/error_during_execution` but warns it's not exhaustive. Schema accepts any string. |
| `result.error` field | Used by current `sdk-to-blocks.ts` (line 234) but not in M1's ResultFrame. Likely SDK-side enrichment; might or might not exist on raw stream-json. Marked optional. |
| `assistant.error` field (sibling of `message`) | Confirmed against `src/agent/sdk-to-blocks.ts:85-101` `assistantBlocksWithError()` — read as `msg.error` (string codes: `rate_limit`, `billing_error`, `authentication_failed`, `invalid_request`, `server_error`, `max_output_tokens`). Now typed at AssistantEventSchema level so the rewrite cannot silently drop the error banner. |
| `assistant.message.usage` fine-grained shape | Treated as `unknown` — Anthropic's usage schema evolves often (cache_*_tokens, server_tool_use_count, etc.). We expose UsageSchema for `result.usage` only. |
| `stream_event.event` payload shape | Wraps Anthropic Messages streaming events (`message_start / content_block_delta / ...`). Inner shape varies; left as `unknown`. S2 §4.1 lines 296-326 documents the shape but it's better delegated to a dedicated partial-stream handler than baked into the top-level union. |
| `agent_metadata` fields beyond `agent_id / parent_agent_id` | M1 only mentions those two. Likely has more (subagent name, tool budget, etc.). Passthrough catches them. |
| `rewind_files` control command payload | Confirmed against sibling worktree `agentory-wt-control-rpc/electron/agent/control-rpc.ts:368` — `rewindFiles(toMessageId)` sends `{ subtype: 'rewind_files', message_id }`. Schema upgraded from `UnknownCommandSchema` to a named `RewindFilesCommandSchema`. |

## What's UNCONFIRMED — must be revisited with real samples

These are fields/frames I deliberately did NOT invent names for. They exist
according to the docs but no field schema is published. Phase 2 must record
real samples and update the schemas.

1. **`apply_flag_settings` control command** (M1 line 230-231): subtype name
   confirmed, payload fields completely unknown. Currently caught by
   `UnknownCommandSchema`. **Risk: HIGH** — we can't actually send this command
   today.
2. **`get_settings` control command**: same as above.
3. **`summary` control command**: same as above.
4. **`hook_event` inbound frame** (S2 line 293): mentioned in the SDK message
   list but no schema published. Currently NOT in `ClaudeStreamEventSchema` —
   it will fall into the `unknown` bucket, which is the safer default. Add a
   schema once we record one.
5. **`tool_use_start` / `tool_result` as standalone top-level frames** (S2 line
   292-293): mentioned but no schema. Most tool data flows through
   `assistant.message.content[].tool_use` / `user.message.content[].tool_result`
   blocks instead, so these top-level frames may be vestigial. Not in the union
   today — will be `unknown` if encountered.
6. **`system.subtype` complete enum**: docs only show `init / compact_boundary
   / api_retry`. There may be more (`rate_limit_warning`?, `mcp_error`?). Our
   `SystemOtherSchema` catch-all preserves them.
7. **Permission rule fields on `can_use_tool` / `permission_suggestions[]`
   inner shape**: M1 says `Array<unknown>` and lists "behavior, updatedInput"
   from S2 §5.2 line 406, but no full schema. Left as `unknown`.

## Cross-worktree interface decisions (R4 review follow-up)

- **Outbound `user` `session_id` is OPTIONAL.** claude.exe accepts the very
  first user message without one (the cliSessionId is only minted and echoed
  back on the first inbound `system.init` frame). control-rpc therefore sends
  the first turn omitting `session_id`; `UserMessageEventSchema` reflects that.
- **`serializeOutgoing` accepts `object` as well as `ClaudeOutgoingEvent`.**
  control-rpc constructs control-request payloads as plain objects (e.g.
  `{ subtype: 'rewind_files', message_id }`) and sends them via the parser
  helper without first casting through `ClaudeOutgoingEvent`. The overload
  keeps typed callers type-checked while the object overload removes the
  cross-module type plumbing burden.
- **`type='control_request'` is used by BOTH inbound and outbound frames** but
  with different shapes. Inbound `ControlRequestEventSchema` carries
  `request.subtype ∈ { can_use_tool | hook_callback | mcp_message | ... }`
  (claude.exe asks us). Outbound `ControlCommandEventSchema` carries
  `request.subtype ∈ { interrupt | set_permission_mode | set_model |
  set_max_thinking_tokens | rewind_files | ... }` (we ask claude.exe). The
  top-level `type` literal is the same string but the discriminator that
  matters is `request.subtype`. Don't try to merge them — direction is the
  context, not a wire field.
- **Inbound `control_response` (CLI → us) is NESTED, not flat.** Bug K /
  Task #142: pre-fix the schema expected `{ type, request_id, response }` but
  captured wire frames look like:
    success: `{ type: "control_response", response: { subtype: "success", request_id, response: {...payload} } }`
    error:   `{ type: "control_response", response: { subtype: "error",   request_id, error: "..." } }`
  This is the OPPOSITE direction from outbound `control_response` (us → CLI),
  which uses the FLAT `{ type, request_id, response }` shape — confirmed by
  the fact that `can_use_tool` / `hook_callback` ack flows have always
  worked. Don't unify the two: outbound stays flat, inbound is nested.
  Discriminate on `response.subtype` to distinguish success vs error.
- **`ControlRequestPayloadSchema` is `z.union`, not `discriminatedUnion`.**
  `discriminatedUnion('subtype')` would reject any unknown subtype and force
  the parser into the `'unknown'` bucket — meaning control-rpc would never
  see future subtypes (e.g. `permission_decision_v2`) and couldn't even log
  them. The union order is specific-first with `UnknownControlRequestSchema`
  as the catch-all, so known shapes still narrow correctly under TS.

## Forward-compat policy

- Every `z.object(...)` ends in `.passthrough()` so unknown fields ride along.
- `subtype` on `result` is `z.string()`, not enum.
- Top-level inbound is `z.union(...)` (not strict discriminatedUnion on `type`)
  because the `system` family is itself a union of subtypes; the parser falls
  through to `'unknown'` rather than throwing on shapes we haven't pinned down.
- `ControlRequestPayloadSchema` uses `z.union(...)` with a catch-all so
  unknown control_request subtypes still parse as `control_request` frames.

## Test-only convention

All fixtures in this directory MUST be valid NDJSON: one JSON object per line,
trailing `\n` on every line, no comments inside JSON. Comments live here.
