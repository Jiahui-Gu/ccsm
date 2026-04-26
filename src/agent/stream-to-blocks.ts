import type {
  AssistantEvent,
  ClaudeStreamEvent,
  ContentBlock,
  ResultEvent,
  SystemEvent,
  ToolResultBlock,
  ToolUseBlock,
  UserEvent
} from '../../electron/agent/stream-json-types';
import type { MessageBlock, SkillProvenance, TodoItem } from '../types';
// `parseQuestions` previously sat here for the AskUserQuestion
// malformed-input fallback (which dumped the rejected payload via
// PrettyInput on top of the SDK retry's correct card — see
// docs/tool-failure-render-research.md). That fallback was removed
// 2026-04-26; lifecycle.ts imports parseQuestions directly from
// ./ask-user-question for the can_use_tool permission path.

export type ToolResultPatch = {
  toolUseId: string;
  result: string;
  isError: boolean;
};

export type StreamTranslation = {
  append: MessageBlock[];
  toolResults: ToolResultPatch[];
  // When the just-translated event mutated the per-turn skill provenance
  // — either the assistant invoked a Skill tool_use (set) or the turn
  // finished via a `result` frame (cleared) — we surface the new value here
  // so callers that hold per-session state can keep their `activeSkill`
  // for the next event in sync. `undefined` (the default) means "no
  // change"; an explicit `null` means "cleared". Live agent path uses this
  // via lifecycle.ts; the import-history projector in store.ts threads it
  // through a local var.
  nextActiveSkill?: SkillProvenance | null;
};

const EMPTY: StreamTranslation = { append: [], toolResults: [] };

// Patch surface for partial assistant streaming. EITHER:
//   - text path (existing): blockId + appendText + done, OR
//   - bash tool input path (#336): toolBlockId + bashPartialCommand + done.
// The two are mutually exclusive — we return at most one shape per event.
export type AssistantStreamPatch =
  | {
      kind: 'text';
      blockId: string;
      appendText: string;
      done: boolean;
    }
  | {
      // Bash tool_use is having its `input` JSON streamed by the model.
      // Until `done` is true, the canonical tool block hasn't landed yet —
      // we surface the command-so-far so the UI can render a "typing" preview.
      kind: 'bash-input';
      // Stable id matching the eventual real ToolBlock id
      // (`${messageId}:${toolUseId}`) so `appendBlocks` coalesces the
      // finalized tool block on top of the streamed placeholder.
      toolBlockId: string;
      toolUseId: string;
      bashPartialCommand: string;
      done: boolean;
    };

// Tolerant extractor for the `command` field inside a partial JSON object
// like `{"command":"npm ru` or `{"description":"x","command":"echo \"hi`.
// We DO NOT pull a streaming-JSON parser dependency — the regex captures
// everything up to (but not including) the next unescaped `"`, which gives
// us the in-progress string content. JSON-escape sequences (`\"`, `\\`,
// `\n`, etc.) are then minimally decoded so the preview reads naturally.
// Returns null when there's no partial `command` field yet.
export function extractPartialBashCommand(partialJson: string): string | null {
  const m = /"command"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(partialJson);
  if (!m) return null;
  const raw = m[1];
  // Decode the common JSON escapes we might see mid-stream. We deliberately
  // ignore `\uXXXX` half-sequences (`\u00` mid-stream) — they'd render as
  // a literal `\u00` for a few frames, which is fine for a preview.
  return raw.replace(/\\(["\\/bfnrt])/g, (_, c) => {
    switch (c) {
      case 'n': return '\n';
      case 't': return '\t';
      case 'r': return '';
      case 'b': return '';
      case 'f': return '';
      case '/': return '/';
      case '"': return '"';
      case '\\': return '\\';
      default: return c;
    }
  });
}

// Mirrors the SDK-era streamer but consumes stream_event frames coming straight
// from claude.exe stdout. The wire shape (message_start / content_block_start /
// content_block_delta / content_block_stop) is identical between SDK and
// direct spawn — the SDK was a pass-through for these — so the state machine
// is unchanged for text. For tool_use input we additionally accumulate
// `input_json_delta` per content-block index so we can surface the in-flight
// `command` arg of `Bash` tool calls (#336).
type ToolUseAccum = {
  id: string;
  name: string;
  partialJson: string;
  // Last command string we surfaced — used to dedupe no-op deltas (the model
  // can emit input_json_delta chunks that don't change the `command` field
  // yet, e.g. while it's still typing the `description` arg).
  lastCommand: string;
};

export class PartialAssistantStreamer {
  private currentMessageId: string | null = null;
  // Per-message-id → per-content-block-index → accumulator. Cleared on
  // message_stop. Keyed by index because a single assistant turn can contain
  // multiple tool_use blocks (parallel batch), each with its own input stream.
  private toolUseByIndex = new Map<number, ToolUseAccum>();

  consume(msg: unknown): AssistantStreamPatch | null {
    const event = (msg as { event?: unknown } | null)?.event as
      | {
          type?: string;
          message?: { id?: unknown };
          index?: number;
          delta?: { type?: string; text?: unknown; partial_json?: unknown };
          content_block?: { type?: string; id?: unknown; name?: unknown };
        }
      | undefined;
    if (!event || typeof event !== 'object') return null;
    if (event.type === 'message_start') {
      const id = event.message?.id;
      this.currentMessageId = typeof id === 'string' ? id : null;
      this.toolUseByIndex.clear();
      return null;
    }
    if (event.type === 'message_stop') {
      this.currentMessageId = null;
      this.toolUseByIndex.clear();
      return null;
    }
    if (!this.currentMessageId) return null;
    if (event.type === 'content_block_start') {
      const cb = event.content_block;
      if (cb && cb.type === 'tool_use' && typeof event.index === 'number') {
        const id = typeof cb.id === 'string' ? cb.id : '';
        const name = typeof cb.name === 'string' ? cb.name : '';
        if (id) {
          this.toolUseByIndex.set(event.index, {
            id,
            name,
            partialJson: '',
            lastCommand: ''
          });
        }
      }
      return null;
    }
    if (event.type === 'content_block_delta') {
      const d = event.delta;
      if (!d) return null;
      if (d.type === 'text_delta') {
        const text = typeof d.text === 'string' ? d.text : '';
        if (!text) return null;
        return {
          kind: 'text',
          blockId: `${this.currentMessageId}:c${event.index}`,
          appendText: text,
          done: false
        };
      }
      if (d.type === 'input_json_delta' && typeof event.index === 'number') {
        const accum = this.toolUseByIndex.get(event.index);
        if (!accum || accum.name !== 'Bash') return null;
        const chunk = typeof d.partial_json === 'string' ? d.partial_json : '';
        if (!chunk) return null;
        accum.partialJson += chunk;
        const cmd = extractPartialBashCommand(accum.partialJson);
        if (cmd === null || cmd === accum.lastCommand) return null;
        accum.lastCommand = cmd;
        return {
          kind: 'bash-input',
          toolBlockId: `${this.currentMessageId}:${accum.id}`,
          toolUseId: accum.id,
          bashPartialCommand: cmd,
          done: false
        };
      }
      return null;
    }
    if (event.type === 'content_block_stop') {
      // For tool_use blocks we drop the per-index accumulator. The text path
      // continues to emit a `done` patch so the renderer can flip the
      // streaming flag off; the bash-input path doesn't need a final patch
      // because the canonical assistant event will land next and replace
      // the placeholder with the finalized tool block via appendBlocks
      // coalesce-by-id.
      if (typeof event.index === 'number') {
        const accum = this.toolUseByIndex.get(event.index);
        if (accum) {
          this.toolUseByIndex.delete(event.index);
          if (accum.name === 'Bash' && accum.lastCommand) {
            return {
              kind: 'bash-input',
              toolBlockId: `${this.currentMessageId}:${accum.id}`,
              toolUseId: accum.id,
              bashPartialCommand: accum.lastCommand,
              done: true
            };
          }
          return null;
        }
      }
      return {
        kind: 'text',
        blockId: `${this.currentMessageId}:c${event.index}`,
        appendText: '',
        done: true
      };
    }
    return null;
  }
}

export type TranslationContext = {
  // True when the user clicked Stop on this session before the current
  // frame arrived. Used to demote `error_during_execution` from an error
  // block to a neutral "Interrupted" status banner.
  interrupted?: boolean;
  // The skill provenance currently in flight for this session's turn, set
  // by an earlier Skill tool_use and cleared at turn end (`result` frame).
  // When present, assistant text blocks emitted in this call are stamped
  // with `viaSkill` so AssistantBlock can render the badge. (Task #318.)
  activeSkill?: SkillProvenance | null;
};

// Skill tool name as emitted by claude.exe stream-json. Confirmed in
// dogfood-logs/bug-186-2026-04-23T16-55-26-819Z.json (toolName: "Skill",
// input: {"skill":"using-superpowers"}).
const SKILL_TOOL_NAME = 'Skill';

function readSkillName(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  const v = (input as Record<string, unknown>).skill;
  return typeof v === 'string' && v.length > 0 ? v : null;
}

// Best-effort skill source path. Plugin-namespaced skills (e.g. "pua:p7")
// live under ~/.claude/plugins/<plugin>/skills/<skill>; user skills live
// under ~/.claude/skills/<name>. Mirrors the discovery order in
// electron/commands-loader.ts. The renderer can't actually stat disk so
// this is a tooltip hint, not a clickable resolved file.
export function skillSourcePath(name: string): string {
  if (name.includes(':')) {
    const [plugin, skill] = name.split(':', 2);
    return `~/.claude/plugins/${plugin}/skills/${skill}/SKILL.md`;
  }
  return `~/.claude/skills/${name}/SKILL.md`;
}

export function streamEventToTranslation(
  event: ClaudeStreamEvent | { type: string },
  ctx: TranslationContext = {}
): StreamTranslation {
  switch (event.type) {
    case 'assistant':
      return assistantTranslation(event as AssistantEvent, ctx);
    case 'user':
      return { append: [], toolResults: extractToolResults(event as UserEvent) };
    case 'system':
      return { append: systemBlocks(event as SystemEvent), toolResults: [] };
    case 'result':
      // End-of-turn: clear any in-flight skill provenance so the next
      // turn doesn't inherit it.
      return {
        append: resultBlocks(event as ResultEvent, ctx),
        toolResults: [],
        nextActiveSkill: ctx.activeSkill ? null : undefined
      };
    default:
      return EMPTY;
  }
}

function assistantTranslation(msg: AssistantEvent, ctx: TranslationContext): StreamTranslation {
  // Pre-scan content for a Skill tool_use — if present we update the per-turn
  // active skill BEFORE stamping any text blocks in this same event, so a
  // single AssistantEvent that interleaves a Skill call with subsequent text
  // (rare but possible) tags the text correctly.
  let activeSkill: SkillProvenance | null | undefined = ctx.activeSkill ?? null;
  let nextActiveSkill: SkillProvenance | null | undefined = undefined;
  const content: ContentBlock[] = msg.message?.content ?? [];
  for (const c of content) {
    if (c.type === 'tool_use' && (c as ToolUseBlock).name === SKILL_TOOL_NAME) {
      const skillName = readSkillName((c as ToolUseBlock).input);
      if (skillName) {
        const next: SkillProvenance = { name: skillName, path: skillSourcePath(skillName) };
        activeSkill = next;
        nextActiveSkill = next;
      }
    }
  }

  const out = assistantBlocksWithError(msg, activeSkill ?? undefined);
  return { append: out, toolResults: [], nextActiveSkill };
}

function assistantBlocksWithError(msg: AssistantEvent, activeSkill?: SkillProvenance): MessageBlock[] {
  const out = assistantBlocks(msg, activeSkill);
  const err = msg.error;
  if (err === 'rate_limit') {
    out.push({
      kind: 'status',
      id: `${msg.uuid ?? cryptoRandom()}:rate`,
      tone: 'warn',
      title: 'Rate limit hit',
      detail: 'The API is throttling this account. The next request will queue and retry.'
    });
  } else if (typeof err === 'string' && err) {
    out.push({
      kind: 'status',
      id: `${msg.uuid ?? cryptoRandom()}:err`,
      tone: 'warn',
      title: errorTitle(err),
      detail: undefined
    });
  }
  return out;
}

function errorTitle(code: string): string {
  switch (code) {
    case 'authentication_failed': return 'Authentication failed';
    case 'billing_error': return 'Billing error';
    case 'rate_limit': return 'Rate limit hit';
    case 'invalid_request': return 'Invalid request';
    case 'server_error': return 'Server error';
    case 'max_output_tokens': return 'Hit max output tokens';
    default: return 'Assistant error';
  }
}

function systemBlocks(msg: SystemEvent): MessageBlock[] {
  if (msg.subtype === 'compact_boundary') {
    const m = (msg as { compact_metadata?: { trigger?: string; pre_tokens?: number; post_tokens?: number; duration_ms?: number } }).compact_metadata ?? {};
    const detail = m.pre_tokens
      ? `Compacted ${m.pre_tokens.toLocaleString()} → ${m.post_tokens?.toLocaleString() ?? '?'} tokens` +
        (m.duration_ms ? ` in ${m.duration_ms}ms` : '')
      : undefined;
    return [
      {
        kind: 'status',
        id: msg.uuid ?? cryptoRandom(),
        tone: 'info',
        title: m.trigger === 'manual' ? 'Conversation compacted (manual)' : 'Conversation auto-compacted',
        detail
      }
    ];
  }
  if (msg.subtype === 'api_retry') {
    const m = msg as { attempt?: number; max_retries?: number; retry_delay_ms?: number; error_status?: number | string };
    const delay = typeof m.retry_delay_ms === 'number' ? Math.round(m.retry_delay_ms / 1000) : '?';
    const max = m.max_retries ?? '?';
    return [
      {
        kind: 'status',
        id: msg.uuid ?? cryptoRandom(),
        tone: 'warn',
        title: `Retrying API request (${m.attempt}/${max})`,
        detail: `Next attempt in ~${delay}s${m.error_status ? ` · HTTP ${m.error_status}` : ''}`
      }
    ];
  }
  return [];
}

function assistantBlocks(msg: AssistantEvent, activeSkill?: SkillProvenance): MessageBlock[] {
  const out: MessageBlock[] = [];
  const baseId = msg.message?.id ?? msg.uuid ?? cryptoRandom();
  const content: ContentBlock[] = msg.message?.content ?? [];
  for (let idx = 0; idx < content.length; idx++) {
    const c = content[idx];
    if (c.type === 'text' && typeof c.text === 'string') {
      const block: MessageBlock = { kind: 'assistant', id: `${baseId}:c${idx}`, text: c.text };
      if (activeSkill) (block as { viaSkill?: SkillProvenance }).viaSkill = activeSkill;
      out.push(block);
    } else if (c.type === 'tool_use') {
      const tu = c as ToolUseBlock;
      // Block id MUST be derived from the globally-unique `tool_use.id`
      // (e.g. `toolu_vrtx_…`), NOT from a per-event positional counter.
      // Reason: claude.exe streams parallel tool batches as MULTIPLE
      // assistant events with the SAME `message.id` but each carrying only
      // ONE tool_use in `content[]`. A positional counter resets to 0 in
      // every event, so all N parallel tool blocks would receive the same
      // id `${msgId}:tu0` and `appendBlocks` (which coalesces by id) would
      // collapse them into a single block — N-1 of N tool_results then have
      // nowhere to attach. (Bug L parallel-batch follow-up; PR #172 fixed
      // the IPC envelope, this fixes the renderer-side block id collision.)
      const blockId = `${baseId}:${tu.id}`;
      if (tu.name === 'TodoWrite') {
        out.push({
          kind: 'todo',
          id: blockId,
          toolUseId: tu.id,
          todos: parseTodos(tu.input)
        });
      } else if (tu.name === 'AskUserQuestion') {
        // Suppressed on purpose: every tool — including AskUserQuestion —
        // is intercepted by `can_use_tool` first (we send
        // `--permission-prompt-tool stdio` + the SDK-style `initialize`
        // control request when starting claude.exe). That path has already
        // appended a question block keyed by `requestId` via
        // `permissionRequestToWaitingBlock` in lifecycle.ts, with the
        // requestId wired so submit can resolve the pending permission
        // promise on the main side.
        //
        // If we ALSO emitted a question block here, two cards would render
        // for one logical AskUserQuestion: the second card has no
        // requestId, so submitting it would route through `agentSend`
        // (raw user message) instead of `agentResolvePermission`, leaving
        // claude.exe blocked on a permission promise that never settles.
        // claude.exe then exits with code 1 and the UI stays "running"
        // forever waiting for a `result` frame that never arrives.
        // (See feedback_bugfix_requires_e2e — Bugs A+B reported 2026-04-23.)
        //
        // Malformed-input fallback REMOVED (tool-failure render dogfood,
        // 2026-04-26): when `parseQuestions` returned [] (the model
        // emitted `{header, options}` only, missing `question`), we used
        // to push a generic tool block here so the user "had something
        // to inspect". In practice that block paired with the CLI's
        // synthetic `<tool_use_error>InputValidationError…` tool_result
        // and auto-expanded into a 50-line PrettyInput dump of the
        // rejected payload — directly above the SDK's correct retry
        // card. Zero user value, lots of noise. The retry path
        // guarantees the real question card lands; we drop the failed
        // attempt entirely. Generic non-AskUserQuestion validation
        // failures are still rendered (collapsed pill in ToolBlock,
        // see Fix B for that branch).
        //
        // `parseQuestions` is intentionally NOT called here anymore —
        // even when it returns a non-empty array, the can_use_tool
        // permission path has already mounted the question card, so
        // there is nothing for us to add.
      } else {
        out.push({
          kind: 'tool',
          id: blockId,
          toolUseId: tu.id,
          name: tu.name,
          brief: briefForTool(tu.name, tu.input),
          expanded: false,
          input: tu.input
        });
      }
    }
  }
  return out;
}

function extractToolResults(msg: UserEvent): ToolResultPatch[] {
  const content = msg.message?.content;
  if (!Array.isArray(content)) return [];
  const out: ToolResultPatch[] = [];
  for (const c of content) {
    if (!c || typeof c !== 'object' || (c as { type?: string }).type !== 'tool_result') continue;
    const tr = c as ToolResultBlock;
    out.push({
      toolUseId: tr.tool_use_id,
      result: stringifyToolResult(tr.content),
      isError: tr.is_error === true
    });
  }
  return out;
}

function stringifyToolResult(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return JSON.stringify(content ?? '', null, 2);
  const parts: string[] = [];
  for (const part of content) {
    if (part && typeof part === 'object' && (part as { type?: string }).type === 'text') {
      const t = (part as { text?: unknown }).text;
      if (typeof t === 'string') parts.push(t);
    } else {
      parts.push(JSON.stringify(part));
    }
  }
  return parts.join('\n');
}

function resultBlocks(msg: ResultEvent, ctx: TranslationContext): MessageBlock[] {
  if (msg.subtype === 'success' || msg.is_error === false) {
    // Suppress the per-turn "Done" status banner — it's noisy and Claude
    // Desktop doesn't render one. resultStatsFooter() is kept below in case
    // we want to re-enable a compact footer later.
    return [];
  }
  // User-initiated interrupt: claude.exe emits `error_during_execution`
  // when `agentInterrupt` lands mid-turn. Render it as a neutral status,
  // not a red error block.
  if (msg.subtype === 'error_during_execution' && ctx.interrupted) {
    return [
      {
        kind: 'status',
        id: msg.uuid ?? cryptoRandom(),
        tone: 'info',
        title: 'Interrupted',
        detail: undefined
      }
    ];
  }
  const text = typeof msg.error === 'string' ? msg.error : msg.subtype ?? 'Run failed';
  return [{ kind: 'error', id: msg.uuid ?? cryptoRandom(), text }];
}

function _resultStatsFooter(msg: ResultEvent): MessageBlock {
  const parts: string[] = [];
  if (typeof msg.num_turns === 'number') parts.push(`${msg.num_turns} turn${msg.num_turns === 1 ? '' : 's'}`);
  if (typeof msg.duration_ms === 'number') parts.push(formatDuration(msg.duration_ms));
  const usage = msg.usage ?? {};
  const inTok = (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
  const outTok = usage.output_tokens ?? 0;
  if (inTok || outTok) {
    parts.push(`${formatTokens(inTok)} in / ${formatTokens(outTok)} out`);
  }
  if (typeof msg.total_cost_usd === 'number' && msg.total_cost_usd > 0) {
    parts.push(`$${msg.total_cost_usd.toFixed(msg.total_cost_usd < 0.01 ? 4 : 3)}`);
  }
  return {
    kind: 'status',
    id: msg.uuid ?? cryptoRandom(),
    tone: 'info',
    title: 'Done',
    detail: parts.join(' · ')
  };
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s - m * 60);
  return `${m}m${rem}s`;
}

function formatTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function briefForTool(_name: string, input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const i = input as Record<string, unknown>;
  const pick = (...keys: string[]): string => {
    for (const k of keys) {
      const v = i[k];
      if (typeof v === 'string') return v;
    }
    return '';
  };
  const v =
    pick('file_path', 'path', 'pattern', 'command', 'query', 'url', 'description') || JSON.stringify(input);
  return v.length > 80 ? v.slice(0, 77) + '…' : v;
}

function cryptoRandom(): string {
  return Math.random().toString(36).slice(2, 10);
}

function parseTodos(input: unknown): TodoItem[] {
  if (!input || typeof input !== 'object') return [];
  const raw = (input as { todos?: unknown }).todos;
  if (!Array.isArray(raw)) return [];
  const out: TodoItem[] = [];
  for (const t of raw) {
    if (!t || typeof t !== 'object') continue;
    const o = t as Record<string, unknown>;
    const content = typeof o.content === 'string' ? o.content : '';
    if (!content) continue;
    const status = o.status === 'in_progress' || o.status === 'completed' ? o.status : 'pending';
    out.push({
      content,
      status,
      activeForm: typeof o.activeForm === 'string' ? o.activeForm : undefined
    });
  }
  return out;
}
