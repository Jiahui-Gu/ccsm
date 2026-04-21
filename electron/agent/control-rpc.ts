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
  request:
    | CanUseToolRequest
    | HookCallbackRequest
    | McpMessageRequest
    // Forward-compat: unknown subtypes are tolerated (logged + ignored).
    | { subtype: string; [k: string]: unknown };
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
 * Outbound serializer. Real impl will live alongside the parser; for now we
 * inline the trivial JSON.stringify+"\n" form that M1 §3.2 specifies.
 */
function serializeOutgoing(obj: unknown): string {
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
   */
  interruptHardKillTimeoutMs?: number;
  /** Optional logger; defaults to console.warn for unknown subtypes / errors. */
  logger?: { warn: (msg: string, meta?: unknown) => void };
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

export class ControlRpc {
  private readonly stdin: NodeJS.WritableStream;
  private readonly opts: Required<Pick<ControlRpcOpts, 'interruptHardKillTimeoutMs'>> & ControlRpcOpts;
  private readonly outbound = new Map<string, PendingOutbound>();
  private readonly inbound = new Map<string, PendingInbound>();
  private closed = false;
  private stdinUsable = true;

  constructor(stdin: NodeJS.WritableStream, opts: ControlRpcOpts) {
    this.stdin = stdin;
    this.opts = {
      interruptHardKillTimeoutMs: 5_000,
      ...opts,
    };

    // EPIPE / closed stream: mark unusable so subsequent writes throw friendly
    // errors instead of crashing the main process.
    const markBroken = () => {
      this.stdinUsable = false;
    };
    stdin.on('error', markBroken);
    stdin.on('close', markBroken);
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
    const controller = new AbortController();
    this.inbound.set(request_id, { controller });

    const finish = (response: unknown) => {
      this.inbound.delete(request_id);
      this.writeFrame({ type: 'control_response', request_id, response });
    };

    const fail = (err: unknown, fallback: Record<string, unknown>) => {
      this.opts.logger?.warn?.('[control-rpc] handler failed', {
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

      default: {
        // Forward-compat: log + drop. Don't reply — replying with a nonsense
        // shape could confuse newer claude.exe versions more than silence.
        this.opts.logger?.warn?.('[control-rpc] unknown control_request subtype', {
          request_id,
          subtype,
        });
        this.inbound.delete(request_id);
        return;
      }
    }
  }

  private handleControlResponse(frame: ControlResponseFrame): void {
    const pending = this.outbound.get(frame.request_id);
    if (!pending) {
      this.opts.logger?.warn?.('[control-rpc] orphan control_response', {
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
    if (this.closed || !this.stdinUsable) {
      return Promise.reject(new Error('ControlRpc: stdin is closed; cannot send control_request'));
    }
    const request_id = `req_${randomUUID()}`;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.outbound.delete(request_id);
        reject(
          new Error(
            `ControlRpc: control_request "${request.subtype}" timed out after ${this.opts.interruptHardKillTimeoutMs}ms`,
          ),
        );
      }, this.opts.interruptHardKillTimeoutMs);
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
   * sessionId is the claude.exe-issued cliSessionId (from system frame). For
   * the very first turn before init, callers may pass undefined and claude.exe
   * will fill it in.
   */
  sendUserMessage(text: string, sessionId?: string): void {
    if (this.closed || !this.stdinUsable) {
      throw new Error('ControlRpc: stdin is closed; cannot send user message');
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

  private writeFrame(obj: unknown): void {
    if (!this.stdinUsable) {
      throw new Error('ControlRpc: stdin is closed; cannot write frame');
    }
    try {
      this.stdin.write(serializeOutgoing(obj));
    } catch (err) {
      this.stdinUsable = false;
      throw err instanceof Error ? err : new Error(String(err));
    }
  }
}
