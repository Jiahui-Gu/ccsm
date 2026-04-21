/**
 * Control RPC layer for spawned `claude.exe` child process.
 *
 * Owns the bidirectional control channel:
 *   - Inbound  control_request  (can_use_tool / hook_callback / mcp_message)
 *     -> dispatches to handlers, writes back control_response with matching request_id.
 *   - Outbound control_request  (interrupt / set_permission_mode / set_model /
 *     set_max_thinking_tokens / rewind_files)
 *     -> tracks pending control_response by request_id, resolves/rejects accordingly.
 *   - Plain user messages (type:"user") are also written through here for convenience.
 *
 * Scope NOT covered by this module:
 *   - Spawning / killing the child process.
 *   - NDJSON splitting from stdout (callers feed already-parsed events via handleIncoming).
 *   - Hard-kill on interrupt timeout. interrupt() only sends the soft control_request and
 *     resolves when claude.exe acknowledges (or rejects on timeout). The spawner layer is
 *     responsible for SIGTERM/SIGKILL escalation when interrupt() rejects.
 *
 * Frame shapes follow M1 §3 / S2 §5.2.
 */

import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// Placeholder types — MOVE TO real module after batch merge.
// These mirror the shapes defined in M1 §3.4 (stream-json types) and the
// outbound serializer that the stream-json-parser worktree will export. We keep
// minimal local copies so this module is self-contained for tests/typecheck.
//
// Cross-worktree contract (locked with stream-json fixer):
//   - `UserMessageEventSchema.session_id` is OPTIONAL (claude.exe accepts the
//     first user turn before any system frame, with no session_id field).
//   - `serializeOutgoing(event: ClaudeOutgoingEvent | object): string` —
//     dual signature so this module can pass its locally-typed outbound objects
//     without a cast after the merge.
//   - `rewind_files` command schema uses `message_id` (named field, confirmed
//     in stream-json fixer's schema upgrade).
// ---------------------------------------------------------------------------

/**
 * MOVE TO ./stream-json-types after batch merge.
 * Subset of `ClaudeFrame` we actually consume here. Other inbound types
 * (system / assistant / user / result / stream_event / agent_metadata) are
 * passed through and ignored by this layer.
 */
export type ParsedStreamEvent =
  | ControlRequestFrame
  | ControlResponseFrame
  | ControlCancelRequestFrame
  // Catch-all so callers can forward every parsed frame here without filtering.
  | { type: string; [k: string]: unknown };

export interface ControlRequestFrame {
  type: 'control_request';
  request_id: string;
  request: CanUseToolRequest | HookCallbackRequest | McpMessageRequest;
}

export interface CanUseToolRequest {
  subtype: 'can_use_tool';
  tool_name: string;
  tool_use_id: string;
  agent_id?: string;
  input: unknown;
  permission_suggestions?: unknown[];
  blocked_path?: string;
  decision_reason?: string;
  title?: string;
  display_name?: string;
  description?: string;
}

export interface HookCallbackRequest {
  subtype: 'hook_callback';
  callback_id: string;
  input: unknown;
  tool_use_id?: string;
}

export interface McpMessageRequest {
  subtype: 'mcp_message';
  server_name: string;
  message: unknown;
}

export interface ControlResponseFrame {
  type: 'control_response';
  request_id: string;
  response: unknown;
}

export interface ControlCancelRequestFrame {
  type: 'control_cancel_request';
  request_id: string;
}

/**
 * MOVE TO ./stream-json-parser after batch merge.
 * Outbound serializer. Real impl exposes the dual signature
 * `(event: ClaudeOutgoingEvent | object) => string`; this stub keeps the same
 * shape so swapping the import is a no-op.
 */
function serializeOutgoing(obj: object): string {
  return JSON.stringify(obj) + '\n';
}

// ---------------------------------------------------------------------------
// Public handler interfaces
// ---------------------------------------------------------------------------

export type CanUseToolDecision =
  | { allow: true; updatedInput?: unknown }
  | { allow: false; deny_reason?: string };

export interface CanUseToolHandler {
  (toolName: string, input: unknown, ctx: CanUseToolContext): Promise<CanUseToolDecision>;
}

export interface CanUseToolContext {
  toolUseId: string;
  agentId?: string;
  signal: AbortSignal;
  suggestions?: unknown[];
  blockedPath?: string;
  decisionReason?: string;
  title?: string;
  displayName?: string;
  description?: string;
}

export interface HookCallbackHandler {
  (event: string, payload: unknown, signal: AbortSignal): Promise<unknown>;
}

export interface McpMessageHandler {
  (serverName: string, message: unknown, signal: AbortSignal): Promise<unknown>;
}

export interface Logger {
  warn: (msg: string, meta?: unknown) => void;
}

export interface ControlRpcOpts {
  onCanUseTool: CanUseToolHandler;
  /** If absent, hook_callback is acknowledged with `{}` (no-op). */
  onHookCallback?: HookCallbackHandler;
  /**
   * If absent, mcp_message is acknowledged with `{}` (no-op pass-through). M1
   * §6.3 explicitly notes in-process MCP is MVP-out-of-scope, so the default is
   * "drop on the floor but don't hang the child".
   */
  onMcpMessage?: McpMessageHandler;
  /**
   * Timeout for outbound control_request → control_response round-trip. Beyond
   * this, the returned promise rejects so the spawner layer can decide whether
   * to hard-kill. Defaults to 5_000ms (matches the M1 §5.3 5s SIGKILL grace).
   *
   * NOTE: applies to ALL outbound subtypes (interrupt / set_model /
   * set_permission_mode / set_max_thinking_tokens / rewind_files). If a future
   * command needs a different budget, add a per-subtype override.
   */
  outboundResponseTimeoutMs?: number;
  /** Optional logger; defaults to console.warn for unknown subtypes / errors. */
  logger?: Logger;
}

// ---------------------------------------------------------------------------
// ControlRpc
// ---------------------------------------------------------------------------

interface PendingOutbound {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

interface PendingInbound {
  controller: AbortController;
}

const DEFAULT_OUTBOUND_TIMEOUT_MS = 5_000;

const consoleLogger: Logger = {
  warn: (msg, meta) => {
    if (meta !== undefined) console.warn(msg, meta);
    else console.warn(msg);
  },
};

export class ControlRpc {
  private readonly stdin: NodeJS.WritableStream;
  private readonly opts: ControlRpcOpts;
  private readonly logger: Logger;
  private readonly outboundTimeoutMs: number;
  private readonly outbound = new Map<string, PendingOutbound>();
  private readonly inbound = new Map<string, PendingInbound>();
  private closed = false;
  private stdinUsable = true;
  private brokenReason: string | null = null;

  constructor(stdin: NodeJS.WritableStream, opts: ControlRpcOpts) {
    this.stdin = stdin;
    this.opts = opts;
    this.logger = opts.logger ?? consoleLogger;
    this.outboundTimeoutMs = opts.outboundResponseTimeoutMs ?? DEFAULT_OUTBOUND_TIMEOUT_MS;

    // EPIPE / closed stream: mark unusable so subsequent writes throw friendly
    // errors AND fail any in-flight outbound immediately (don't make the caller
    // wait the full outboundResponseTimeoutMs to find out the channel is dead).
    stdin.on('error', (err: unknown) => {
      const reason = err instanceof Error ? err.message : String(err);
      this.markBroken(`stdin error: ${reason}`);
    });
    stdin.on('close', () => {
      this.markBroken('stdin closed');
    });
  }

  // ---------------- inbound dispatch ----------------

  /**
   * Feed a parsed stream-json frame. Non-control frames are ignored (caller is
   * free to forward every frame here without filtering).
   */
  handleIncoming(event: ParsedStreamEvent): void {
    if (this.closed) return;
    switch (event.type) {
      case 'control_request':
        this.handleControlRequest(event as ControlRequestFrame);
        return;
      case 'control_response':
        this.handleControlResponse(event as ControlResponseFrame);
        return;
      case 'control_cancel_request':
        this.handleControlCancel(event as ControlCancelRequestFrame);
        return;
      default:
        // Not our concern.
        return;
    }
  }

  private handleControlRequest(frame: ControlRequestFrame): void {
    const { request_id, request } = frame;
    const subtype = (request as { subtype?: string }).subtype;

    // Reject duplicate request_id from claude.exe. Overwriting the inbound map
    // would silently drop the first handler's abort hook; per M1 spec each
    // request_id is unique per session, so a duplicate is a protocol violation.
    // Drop + warn rather than crash or overwrite.
    if (this.inbound.has(request_id)) {
      this.logger.warn('[control-rpc] duplicate inbound control_request request_id, dropped', {
        request_id,
        subtype,
      });
      return;
    }

    const controller = new AbortController();
    this.inbound.set(request_id, { controller });

    const finish = (response: unknown) => {
      // Double-check the request is still tracked. If `control_cancel_request`
      // arrived between the handler resolving and us reaching here, the entry
      // was already removed and we MUST NOT write a response — claude.exe is
      // no longer expecting one and an orphan response could confuse it.
      if (!this.inbound.has(request_id)) return;
      this.inbound.delete(request_id);
      try {
        this.writeFrame({ type: 'control_response', request_id, response });
      } catch (err) {
        // Channel went away mid-write. Already logged inside writeFrame's
        // markBroken path; nothing more to do here.
        this.logger.warn('[control-rpc] failed to write control_response', {
          request_id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    };

    const fail = (err: unknown, fallback: Record<string, unknown>) => {
      this.logger.warn('[control-rpc] handler failed', {
        request_id,
        subtype,
        error: err instanceof Error ? err.message : String(err),
      });
      finish(fallback);
    };

    switch (subtype) {
      case 'can_use_tool': {
        const r = request as CanUseToolRequest;
        Promise.resolve()
          .then(() =>
            this.opts.onCanUseTool(r.tool_name, r.input, {
              toolUseId: r.tool_use_id,
              agentId: r.agent_id,
              signal: controller.signal,
              suggestions: r.permission_suggestions,
              blockedPath: r.blocked_path,
              decisionReason: r.decision_reason,
              title: r.title,
              displayName: r.display_name,
              description: r.description,
            }),
          )
          .then((decision) => {
            const response = decision.allow
              ? {
                  behavior: 'allow' as const,
                  ...(decision.updatedInput !== undefined ? { updatedInput: decision.updatedInput } : {}),
                  toolUseID: r.tool_use_id,
                }
              : {
                  behavior: 'deny' as const,
                  message: decision.deny_reason ?? 'Denied by user',
                  toolUseID: r.tool_use_id,
                };
            finish(response);
          })
          .catch((err) =>
            // Fail-closed: deny on handler crash so claude.exe doesn't hang
            // forever waiting for a verdict. Friendly wording — claude.exe
            // writes deny messages into the conversation history (M2 §9), so
            // the user will see this string.
            fail(err, {
              behavior: 'deny',
              message: 'Permission handler error — denied for safety. Please retry.',
              toolUseID: r.tool_use_id,
            }),
          );
        return;
      }

      case 'hook_callback': {
        const r = request as HookCallbackRequest;
        if (!this.opts.onHookCallback) {
          finish({});
          return;
        }
        Promise.resolve()
          .then(() => this.opts.onHookCallback!(r.callback_id, r.input, controller.signal))
          .then((res) => finish(res ?? {}))
          .catch((err) => fail(err, {}));
        return;
      }

      case 'mcp_message': {
        const r = request as McpMessageRequest;
        if (!this.opts.onMcpMessage) {
          // Default: ack with empty object. We don't have an in-process MCP
          // host (M1 §6.3 — MVP uses external servers via --mcp-config), so any
          // mcp_message we receive is unexpected; an empty response keeps the
          // child unblocked without claiming success.
          finish({});
          return;
        }
        Promise.resolve()
          .then(() => this.opts.onMcpMessage!(r.server_name, r.message, controller.signal))
          .then((res) => finish(res ?? {}))
          .catch((err) => fail(err, {}));
        return;
      }

      // NO default branch: per R1 review, the upstream stream-json parser
      // routes any control_request with an unknown subtype into its `unknown`
      // bucket (discriminatedUnion has no catch-all), so a frame with a novel
      // subtype never reaches handleControlRequest. If the parser ever changes
      // that policy, restore a default branch here that logs + drops.
    }
  }

  private handleControlResponse(frame: ControlResponseFrame): void {
    const pending = this.outbound.get(frame.request_id);
    if (!pending) {
      // Either an orphan from claude.exe (unlikely), or a late response that
      // arrived after we already timed out / rejected and cleared the entry.
      // Either way, nothing to settle — log and move on.
      this.logger.warn('[control-rpc] orphan control_response (no pending or already settled)', {
        request_id: frame.request_id,
      });
      return;
    }
    this.outbound.delete(frame.request_id);
    clearTimeout(pending.timer);
    pending.resolve(frame.response);
  }

  private handleControlCancel(frame: ControlCancelRequestFrame): void {
    const pending = this.inbound.get(frame.request_id);
    if (!pending) return;
    pending.controller.abort();
    // Remove from the map BEFORE the handler finishes so finish() will detect
    // the cancellation and skip writing a response.
    this.inbound.delete(frame.request_id);
  }

  // ---------------- outbound control commands ----------------

  /**
   * Soft interrupt. Resolves when claude.exe acknowledges, rejects on timeout
   * (caller should escalate to SIGTERM/SIGKILL).
   */
  interrupt(): Promise<void> {
    return this.sendControlRequest({ subtype: 'interrupt' }).then(() => undefined);
  }

  setPermissionMode(mode: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions'): Promise<void> {
    return this.sendControlRequest({ subtype: 'set_permission_mode', mode }).then(() => undefined);
  }

  setModel(model: string): Promise<void> {
    return this.sendControlRequest({ subtype: 'set_model', model }).then(() => undefined);
  }

  setMaxThinkingTokens(n: number): Promise<void> {
    return this.sendControlRequest({ subtype: 'set_max_thinking_tokens', tokens: n }).then(
      () => undefined,
    );
  }

  /**
   * Rewind in-memory file edits to the state at `toMessageId`. Field name
   * `message_id` is locked with the stream-json fixer's schema upgrade
   * (cross-worktree contract).
   */
  rewindFiles(toMessageId: string): Promise<void> {
    return this.sendControlRequest({ subtype: 'rewind_files', message_id: toMessageId }).then(
      () => undefined,
    );
  }

  /**
   * Generic outbound control_request. Public for forward-compat / advanced use,
   * but most callers should prefer the typed wrappers above.
   */
  sendControlRequest(request: { subtype: string; [k: string]: unknown }): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new Error('ControlRpc: closed; cannot send control_request'));
    }
    if (!this.stdinUsable) {
      return Promise.reject(
        new Error(`ControlRpc: channel broken (${this.brokenReason ?? 'unknown'}); cannot send control_request`),
      );
    }
    const request_id = `req_${randomUUID()}`;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.outbound.delete(request_id);
        reject(
          new Error(
            `ControlRpc: control_request "${request.subtype}" timed out after ${this.outboundTimeoutMs}ms`,
          ),
        );
      }, this.outboundTimeoutMs);
      // Don't keep the event loop alive just for this timer.
      if (typeof timer.unref === 'function') timer.unref();

      this.outbound.set(request_id, { resolve, reject, timer });
      try {
        this.writeFrame({ type: 'control_request', request_id, request });
      } catch (err) {
        clearTimeout(timer);
        this.outbound.delete(request_id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  // ---------------- user messages ----------------

  /**
   * Convenience: send a plain user text message. Not a control_request, but
   * shares the same stdin so it lives here to keep ownership clean.
   *
   * `sessionId` is the claude.exe-issued cliSessionId (from system frame). For
   * the very first turn before init, callers may pass undefined and claude.exe
   * accepts the message without it. (Cross-worktree contract:
   * `UserMessageEventSchema.session_id` is OPTIONAL in stream-json types.)
   */
  sendUserMessage(text: string, sessionId?: string): void {
    if (this.closed) {
      throw new Error('ControlRpc: closed; cannot send user message');
    }
    if (!this.stdinUsable) {
      throw new Error(
        `ControlRpc: channel broken (${this.brokenReason ?? 'unknown'}); cannot send user message`,
      );
    }
    this.writeFrame({
      type: 'user',
      uuid: randomUUID(),
      ...(sessionId ? { session_id: sessionId } : {}),
      parent_tool_use_id: null,
      isSynthetic: false,
      message: { role: 'user', content: [{ type: 'text', text }] },
    });
  }

  // ---------------- shutdown ----------------

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const err = new Error('ControlRpc: closed');
    for (const [, pending] of this.outbound) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.outbound.clear();
    for (const [, pending] of this.inbound) {
      pending.controller.abort();
    }
    this.inbound.clear();
  }

  // ---------------- internals ----------------

  /**
   * Channel went away (EPIPE / stdin close / synchronous write throw). Mark
   * the channel unusable AND fail every in-flight outbound immediately so
   * callers don't sit waiting `outboundResponseTimeoutMs` for a reply that
   * will never come. Inbound handlers are aborted too — their AbortSignal
   * fires so they can short-circuit, and any subsequent finish() call is a
   * no-op because we drop the inbound entries here.
   *
   * Idempotent: only the first call records a reason and fans out the error.
   */
  private markBroken(reason: string): void {
    if (!this.stdinUsable) return;
    this.stdinUsable = false;
    this.brokenReason = reason;
    const err = new Error(`ControlRpc: channel broken (${reason})`);
    for (const [, pending] of this.outbound) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.outbound.clear();
    for (const [, pending] of this.inbound) {
      pending.controller.abort();
    }
    this.inbound.clear();
  }

  private writeFrame(obj: object): void {
    if (!this.stdinUsable) {
      throw new Error(
        `ControlRpc: channel broken (${this.brokenReason ?? 'unknown'}); cannot write frame`,
      );
    }
    try {
      this.stdin.write(serializeOutgoing(obj));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.markBroken(`write threw: ${reason}`);
      throw err instanceof Error ? err : new Error(String(err));
    }
  }
}
