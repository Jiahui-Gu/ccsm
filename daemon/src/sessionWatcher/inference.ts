// Pure JSONL → state inference (daemon-side).
//
// Task #106 (v0.3 SessionWatcher 搬 daemon). Ported from
// `electron/sessionWatcher/inference.ts` — the file-watch / JSONL-tail
// pipeline now lives on the daemon, so the inference rules move with
// it. Algorithm is byte-for-byte the same; the only delta is dropping
// the `import type { SessionState } from '../../src/shared/sessionState'`
// (daemon has rootDir=src, can't reach into electron's shared dir) and
// inlining the literal union, which IS the SDK's authoritative
// vocabulary (`SDKSessionStateChangedMessage.state`).
//
// Reuses the SDK's authoritative state names:
//   'idle'             → claude finished its turn, waiting for the user
//   'running'          → claude is mid-turn (tool call in flight, or user
//                        just typed and the assistant frame hasn't landed)
//   'requires_action'  → claude paused on a permission prompt
//
// Inference rules (matches the research in #549):
//   * Last assistant frame has `stop_reason ∈ {end_turn, stop_sequence}`
//     AND its `tool_use` blocks (if any) all have matching `tool_result`
//     ids in the trailing user frames → idle.
//   * Last assistant frame has `stop_reason: tool_use` with at least one
//     `tool_use` block whose id is NOT yet matched by a `tool_result` →
//     running.
//   * Latest frame is `permission-mode` with mode != 'default' →
//     conservatively classify as `requires_action`.
//   * Latest frame is `user` and no subsequent assistant frame yet →
//     running.
//   * Empty / nothing parseable → 'running' (file just created).

/**
 * Watcher-internal state vocabulary. Mirrors the SDK's
 * `SDKSessionStateChangedMessage.state`. Crossed to the proto enum
 * `ccsm.v1.SessionState` at the wire boundary by `toProtoSessionState`
 * in `./protoConvert.ts`.
 */
export type WatcherState = 'idle' | 'running' | 'requires_action';

interface ToolUseRef { id: string }

export function classifyFrames(frames: unknown[]): WatcherState {
  if (!Array.isArray(frames) || frames.length === 0) return 'running';

  const outstanding = new Set<string>();
  let lastAssistant: {
    stopReason: string | null;
    toolUseIds: string[];
  } | null = null;
  let userFrameAfterLastAssistant = false;
  let lastFrameType: string | null = null;
  let pendingPermission = false;

  for (const f of frames) {
    if (!f || typeof f !== 'object') continue;
    const o = f as Record<string, unknown>;
    const type = typeof o.type === 'string' ? o.type : null;
    if (!type) continue;
    lastFrameType = type;

    if (type === 'assistant') {
      const msg = (o.message as Record<string, unknown> | undefined) ?? {};
      const stopReason = typeof msg.stop_reason === 'string' ? msg.stop_reason : null;
      const content = Array.isArray(msg.content) ? (msg.content as unknown[]) : [];
      const toolUseIds: string[] = [];
      for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        const b = block as Record<string, unknown>;
        if (b.type === 'tool_use' && typeof b.id === 'string') {
          toolUseIds.push(b.id);
          outstanding.add(b.id);
        }
      }
      lastAssistant = { stopReason, toolUseIds };
      userFrameAfterLastAssistant = false;
      pendingPermission = false;
    } else if (type === 'user') {
      const msg = (o.message as Record<string, unknown> | undefined) ?? {};
      const content = Array.isArray(msg.content) ? (msg.content as unknown[]) : [];
      for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        const b = block as Record<string, unknown>;
        if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
          outstanding.delete(b.tool_use_id);
        }
      }
      if (lastAssistant) userFrameAfterLastAssistant = true;
    } else if (type === 'permission-mode') {
      pendingPermission = true;
    }
  }

  if (pendingPermission && lastFrameType === 'permission-mode') {
    return 'requires_action';
  }

  if (!lastAssistant) {
    return 'running';
  }

  if (userFrameAfterLastAssistant) return 'running';

  const endedTurn =
    lastAssistant.stopReason === 'end_turn' ||
    lastAssistant.stopReason === 'stop_sequence';
  if (endedTurn && outstanding.size === 0) {
    return 'idle';
  }

  return 'running';
}

export function classifyJsonlText(text: string): WatcherState {
  const lines = text.split(/\r?\n/);
  const frames: unknown[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    try {
      frames.push(JSON.parse(line));
    } catch {
      continue;
    }
  }
  return classifyFrames(frames);
}

export type _ToolUseRef = ToolUseRef;
