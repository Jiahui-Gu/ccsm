// Pure JSONL → state inference.
//
// Reuses the SDK's authoritative state names (see
// `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` —
// `SDKSessionStateChangedMessage.state`):
//
//   'idle'             → claude finished its turn, waiting for the user
//   'running'          → claude is mid-turn (tool call in flight, or user
//                        just typed and the assistant frame hasn't landed)
//   'requires_action'  → claude paused on a permission prompt
//
// We DON'T tail the SDK channel — ccsm spawns the CLI as a subprocess and
// the only out-of-band signal we get is the on-disk JSONL transcript that
// the CLI writes after every turn boundary. Inference rule (matches the
// research in #549):
//
//   * Last assistant frame has `stop_reason ∈ {end_turn, stop_sequence}`
//     AND its `tool_use` blocks (if any) all have matching `tool_result`
//     ids in the trailing user frames → idle.
//   * Last assistant frame has `stop_reason: tool_use` with at least one
//     `tool_use` block whose id is NOT yet matched by a `tool_result` →
//     running (the assistant is waiting for the tool to return).
//   * Latest frame is `permission-mode` with mode != 'default' → in some
//     CLI versions that signals an interactive permission prompt;
//     conservatively classify as `requires_action`. (Plain `default` is
//     just the persisted user preference and means nothing about the
//     current turn.)
//   * Latest frame is `user` (typed input or `tool_result`) and no
//     subsequent assistant frame yet → running.
//   * Empty / nothing parseable → 'running' (file just created, claude
//     hasn't written its first frame yet — caller's fs.watch will tick
//     us again as soon as anything lands).

export type WatcherState = 'idle' | 'running' | 'requires_action';

interface ToolUseRef { id: string }

// Walk the parsed frames in order; track outstanding tool_use ids and the
// last meaningful frame. We intentionally only consider the LAST assistant
// frame's stop_reason — earlier frames in the same transcript are history.
export function classifyFrames(frames: unknown[]): WatcherState {
  if (!Array.isArray(frames) || frames.length === 0) return 'running';

  // Track outstanding tool_use ids across the whole transcript. We add when
  // we see an assistant tool_use block, remove when we see a user
  // tool_result block with the matching id.
  const outstanding = new Set<string>();
  let lastAssistant: {
    stopReason: string | null;
    toolUseIds: string[];
  } | null = null;
  // Tracks whether the user has spoken AFTER the last assistant frame —
  // either by typing fresh text, or by the CLI writing a tool_result for
  // an outstanding tool_use. Either way the user frame is "newer" than the
  // assistant turn boundary, so the assistant owes the next move = running.
  let userFrameAfterLastAssistant = false;
  let lastFrameType: string | null = null;
  // permission-mode frames are sticky — only the most recent one matters.
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
      // Any new assistant frame clears pending-permission unless it itself
      // re-asserts one (handled by the permission-mode branch below).
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
      // Conservative: any mode-change frame might be an interactive prompt
      // to the user. The CLI also writes permission-mode frames for the
      // user's persisted default — those are noise. We treat it as
      // requires_action only if it's the most-recent frame AND no later
      // user frame has cleared it (the permission-mode frame is what the
      // CLI emits when claude pauses for an allow/deny decision; the next
      // user frame is the answer).
      pendingPermission = true;
    }
  }

  if (pendingPermission && lastFrameType === 'permission-mode') {
    return 'requires_action';
  }

  if (!lastAssistant) {
    // Only user / system frames seen — claude hasn't responded yet.
    return 'running';
  }

  // If the user has typed/responded after the last assistant turn, the
  // assistant hasn't yet replied to it — running, regardless of the prior
  // turn's stop_reason.
  if (userFrameAfterLastAssistant) return 'running';

  // Idle: assistant ended its turn AND every tool_use it issued has a
  // matching tool_result.
  const endedTurn =
    lastAssistant.stopReason === 'end_turn' ||
    lastAssistant.stopReason === 'stop_sequence';
  if (endedTurn && outstanding.size === 0) {
    return 'idle';
  }

  return 'running';
}

// Convenience for callers tailing the file: parse newline-delimited lines,
// tolerate the last line being mid-write (chokidar / fs.watch can fire
// before the writer has flushed the trailing `\n`).
export function classifyJsonlText(text: string): WatcherState {
  const lines = text.split(/\r?\n/);
  const frames: unknown[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    try {
      frames.push(JSON.parse(line));
    } catch {
      // Tolerate a mid-write trailing line. If a non-trailing line fails to
      // parse, skip it — it's almost certainly partial too and the next
      // event will carry the full content.
      continue;
    }
  }
  return classifyFrames(frames);
}

// ---------------------------------------------------------------------------
// User-frame counting (notify arm-gate, see #631 / #633).
//
// The notify bridge needs to know "did the user just initiate a new turn?"
// so it can fire on the FINAL idle of that turn (case #2 multi-segment
// reply) instead of on every idle the inference engine emits. The on-disk
// JSONL is the only signal we have — we count user frames per category:
//
//   * userTextFrames       — `user` frame whose content has a `text` block
//                            (== the user typed something / sent a prompt).
//   * userToolResultFrames — `user` frame whose content has a `tool_result`
//                            block (== CLI bookkeeping after a tool ran).
//
// A NEW user(text) frame between two reads = the user kicked off a turn →
// arm. A new user(tool_result) frame ALONE doesn't arm (the CLI writes
// these on its own); the only exception is right after `requires_action`,
// where the tool_result IS the user's allow/deny answer and re-arms.
// ---------------------------------------------------------------------------

export interface FrameCounts {
  userTextFrames: number;
  userToolResultFrames: number;
}

// Walks `frames` once and counts user frames by content-block type. A single
// user frame that contains BOTH a text and tool_result block (rare in
// practice but defensible) increments BOTH counters.
export function countUserFrames(frames: unknown[]): FrameCounts {
  const counts: FrameCounts = { userTextFrames: 0, userToolResultFrames: 0 };
  if (!Array.isArray(frames)) return counts;
  for (const f of frames) {
    if (!f || typeof f !== 'object') continue;
    const o = f as Record<string, unknown>;
    if (o.type !== 'user') continue;
    const msg = (o.message as Record<string, unknown> | undefined) ?? {};
    const content = Array.isArray(msg.content) ? (msg.content as unknown[]) : [];
    let hasText = false;
    let hasToolResult = false;
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const b = block as Record<string, unknown>;
      if (b.type === 'text') hasText = true;
      else if (b.type === 'tool_result') hasToolResult = true;
    }
    if (hasText) counts.userTextFrames += 1;
    if (hasToolResult) counts.userToolResultFrames += 1;
  }
  return counts;
}

// Combined parse: avoids double-parsing the same JSONL text in the watcher
// hot path (one classify + one count per fs event). Matches the leniency of
// `classifyJsonlText` (skips unparseable mid-write trailing lines).
export interface ClassifyAndCountResult extends FrameCounts {
  state: WatcherState;
}
export function classifyAndCount(text: string): ClassifyAndCountResult {
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
  const counts = countUserFrames(frames);
  return {
    state: classifyFrames(frames),
    userTextFrames: counts.userTextFrames,
    userToolResultFrames: counts.userToolResultFrames,
  };
}

// Exported for the watcher test harness to validate ToolUseRef typing.
export type _ToolUseRef = ToolUseRef;
