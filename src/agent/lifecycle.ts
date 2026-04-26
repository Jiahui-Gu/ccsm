import { useStore } from '../stores/store';
import { streamEventToTranslation, PartialAssistantStreamer } from './stream-to-blocks';
import { parseQuestions } from './ask-user-question';
import { dispatchNotification, handleNotificationFocus } from '../notifications/dispatch';
import { buildUserContentBlocks } from '../lib/attachments';
import { i18next } from '../i18n';
import type { MessageBlock, SkillProvenance } from '../types';

let installed = false;

const streamers = new Map<string, PartialAssistantStreamer>();
// Per-turn skill provenance for each session. Set when the assistant invokes
// the `Skill` tool, cleared on `result`. Threaded into streamEventToTranslation
// so subsequent assistant text blocks in the same turn carry `viaSkill` for
// the AssistantBlock badge (Task #318).
const activeSkillBySession = new Map<string, SkillProvenance | null>();
// Wall-clock timestamps for currently-running turns. We use elapsed time as
// one of the signals for whether a `turn_done` is worth notifying about — a
// fast turn that wraps in <15s is rarely worth surfacing, but a long-running
// one almost always is.
const turnStartedAt = new Map<string, number>();
const TURN_DONE_THRESHOLD_MS = 15_000;
function streamerFor(sessionId: string): PartialAssistantStreamer {
  let s = streamers.get(sessionId);
  if (!s) {
    s = new PartialAssistantStreamer();
    streamers.set(sessionId, s);
  }
  return s;
}

/**
 * Drop the streamer accumulator for a session. Called from deleteSession() so
 * a deleted session doesn't leave its partial-assistant-streamer state hanging
 * around forever (tiny leak, but piles up on sessions that never emit a final
 * `result` frame — e.g. force-killed via delete). Idempotent.
 */
export function disposeStreamer(sessionId: string): void {
  streamers.delete(sessionId);
  turnStartedAt.delete(sessionId);
  activeSkillBySession.delete(sessionId);
}

type BackgroundWaitingHandler = (info: { sessionId: string; sessionName: string; prompt: string }) => void;
let backgroundWaitingHandler: BackgroundWaitingHandler = () => {};

export function setBackgroundWaitingHandler(h: BackgroundWaitingHandler): void {
  backgroundWaitingHandler = h;
}

function localQueuedEchoId(): string {
  return `u-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Drain the next queued message for `sessionId` and dispatch it through the
 * same IPC path InputBar.send() uses. Mirrors the local-echo + setRunning
 * sequence so the queued turn looks identical to one the user pressed Send
 * on. Tolerant of races: if the queue is empty, the agent isn't started, or
 * the IPC bridge is missing, this is a no-op.
 *
 * Why here instead of InputBar: InputBar only mounts for the active session.
 * The queue must drain even if the user has switched away mid-turn, so the
 * trigger lives next to the canonical `setRunning(false)` call.
 */
async function drainNextQueued(sessionId: string): Promise<void> {
  const store = useStore.getState();
  const queue = store.messageQueues[sessionId];
  if (!queue || queue.length === 0) return;
  const api = window.ccsm;
  if (!api) return;
  const session = store.sessions.find((s) => s.id === sessionId);
  if (!session) return;
  // Don't drain into a session that never started — without a live agent
  // process the IPC will fail. The next user-driven send will start it
  // and at that point the queue can drain naturally.
  if (!store.startedSessions[sessionId]) return;
  const head = store.dequeueMessage(sessionId);
  if (!head) return;
  store.appendBlocks(sessionId, [
    {
      kind: 'user',
      id: localQueuedEchoId(),
      text: head.text,
      ...(head.attachments.length > 0 ? { images: head.attachments } : {})
    }
  ]);
  store.setRunning(sessionId, true);
  let ok: boolean;
  if (head.attachments.length > 0) {
    const content = buildUserContentBlocks(head.text, head.attachments);
    ok = await api.agentSendContent(sessionId, content);
  } else {
    ok = await api.agentSend(sessionId, head.text);
  }
  if (!ok) {
    store.setRunning(sessionId, false);
    store.appendBlocks(sessionId, [
      {
        kind: 'error',
        id: `send-${Date.now().toString(36)}`,
        text: 'Failed to deliver queued message to agent.'
      }
    ]);
  }
}

function describePermission(toolName: string, input: Record<string, unknown>): string {
  const pick = (...keys: string[]): string => {
    for (const k of keys) {
      const v = input[k];
      if (typeof v === 'string') return v;
    }
    return '';
  };
  const detail = pick('command', 'file_path', 'path', 'pattern', 'url') || '';
  return detail ? `${toolName}: ${detail}` : toolName;
}

export function permissionRequestToWaitingBlock(req: {
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
}): MessageBlock {
  if (req.toolName === 'AskUserQuestion') {
    const questions = parseQuestions(req.input);
    if (questions.length > 0) {
      return {
        kind: 'question',
        id: `q-${req.requestId}`,
        requestId: req.requestId,
        questions
      };
    }
  }
  const isPlan = req.toolName === 'ExitPlanMode';
  const planText = isPlan && typeof req.input.plan === 'string' ? (req.input.plan as string) : undefined;
  const prompt = isPlan
    ? 'Approve this plan to start executing it.'
    : describePermission(req.toolName, req.input);
  return {
    kind: 'waiting',
    id: `wait-${req.requestId}`,
    prompt,
    intent: isPlan ? 'plan' : 'permission',
    requestId: req.requestId,
    plan: planText,
    toolName: req.toolName,
    toolInput: req.input
  };
}

/**
 * If the user previously ticked "Allow always" for this tool in the current
 * app session, dispatch an Allow decision and return true so the caller can
 * skip rendering a waiting block. `AskUserQuestion` / `ExitPlanMode` are
 * always treated as user-interaction — they never auto-resolve.
 *
 * Exported so probes can exercise the fast-path without wiring a real
 * `onAgentPermissionRequest` IPC payload.
 */
export function maybeAutoResolveAllowAlways(req: {
  sessionId: string;
  requestId: string;
  toolName: string;
}): boolean {
  const interactive = req.toolName === 'AskUserQuestion' || req.toolName === 'ExitPlanMode';
  if (interactive) return false;
  const store = useStore.getState();
  if (!store.allowAlwaysTools.includes(req.toolName)) return false;
  // Route through the store action rather than calling the preload IPC
  // directly — keeps the decision path consistent (single callsite for
  // `agent:resolvePermission` IPC) and lets tests / future listeners observe
  // the decision by wrapping the store action. `resolvePermission` no-ops on
  // the messagesBySession branch when no matching waiting block exists
  // (idx === -1), then still fires the preload IPC, which is exactly what we
  // want here — we intentionally never appended a waiting block.
  store.resolvePermission(req.sessionId, req.requestId, 'allow');
  return true;
}

export function subscribeAgentEvents(): void {
  if (installed) return;
  const api = window.ccsm;
  if (!api) return;
  installed = true;

  api.onAgentEvent((e) => {
    // Record the wall-clock start of the current turn so we can decide later
    // whether `turn_done` is worth a toast. We treat the first non-result
    // message after a result (or the very first ever) as the turn start.
    if (e.message.type !== 'stream_event' && e.message.type !== 'result') {
      if (!turnStartedAt.has(e.sessionId)) {
        turnStartedAt.set(e.sessionId, Date.now());
      }
    }
    if (e.message.type === 'stream_event') {
      const streamer = streamerFor(e.sessionId);
      const patch = streamer.consume(e.message);
      if (patch) {
        if (patch.kind === 'text') {
          useStore
            .getState()
            .streamAssistantText(e.sessionId, patch.blockId, patch.appendText, patch.done);
        } else {
          // bash-input (#336): live preview of the Bash command as the
          // model generates the tool_use input JSON. The canonical
          // assistant tool_use event arrives shortly after and replaces
          // this placeholder via appendBlocks coalesce-by-id.
          useStore
            .getState()
            .streamBashToolInput(
              e.sessionId,
              patch.toolBlockId,
              patch.toolUseId,
              patch.bashPartialCommand,
              patch.done
            );
        }
      }
      return;
    }
    const store = useStore.getState();
    const ctx =
      e.message.type === 'result'
        ? { interrupted: store.consumeInterrupted(e.sessionId), activeSkill: activeSkillBySession.get(e.sessionId) ?? null }
        : { activeSkill: activeSkillBySession.get(e.sessionId) ?? null };
    const { append, toolResults, nextActiveSkill } = streamEventToTranslation(e.message, ctx);
    if (nextActiveSkill !== undefined) {
      if (nextActiveSkill === null) activeSkillBySession.delete(e.sessionId);
      else activeSkillBySession.set(e.sessionId, nextActiveSkill);
    }
    if (append.length > 0) store.appendBlocks(e.sessionId, append);
    for (const tr of toolResults) {
      store.setToolResult(e.sessionId, tr.toolUseId, tr.result, tr.isError);
    }
    if (e.message.type === 'result') {
      store.setRunning(e.sessionId, false);
      // Kick off any user messages enqueued during the just-finished turn.
      // Fire-and-forget; the drain helper is itself idempotent on empty queues.
      void drainNextQueued(e.sessionId);
      // Aggregate per-session cost / token counters for `/cost` and any
      // future footer widgets. We accumulate every result frame (success or
      // error subtypes still carry usage).
      const r = e.message as {
        num_turns?: number;
        total_cost_usd?: number;
        usage?: {
          input_tokens?: number;
          output_tokens?: number;
          cache_creation_input_tokens?: number;
          cache_read_input_tokens?: number;
        };
        // SDK surface name from claude-agent-sdk's `SDKResultSuccess`. We
        // don't depend on the SDK at the renderer layer (raw stream-json
        // is parsed by `electron/agent/stream-json-types.ts` and survives
        // unknown fields via .passthrough()), so this is a structural cast
        // rather than an import. Each entry's `contextWindow` is the
        // model-aware token cap (e.g. 200_000 for sonnet/opus) — we use it
        // to size the StatusBar context-pie chip without hardcoding a per-
        // model map.
        modelUsage?: Record<string, { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number; contextWindow?: number }>;
      };
      const usage = r.usage ?? {};
      store.addSessionStats(e.sessionId, {
        turns: typeof r.num_turns === 'number' ? 1 : 1,
        inputTokens:
          (usage.input_tokens ?? 0) +
          (usage.cache_creation_input_tokens ?? 0) +
          (usage.cache_read_input_tokens ?? 0),
        outputTokens: usage.output_tokens ?? 0,
        costUsd: typeof r.total_cost_usd === 'number' ? r.total_cost_usd : 0
      });
      // Snapshot LATEST-turn context-window usage for the StatusBar pie chip.
      // Note: SessionStats sums every turn's usage (cumulative API spend),
      // which can exceed contextWindow once cache_read accumulates over a
      // long conversation. The pie chip needs the absolute current prompt
      // size — that's exactly what `result.usage` reports for the just-
      // finished turn, so we snapshot rather than accumulate.
      const turnTotalTokens =
        (usage.input_tokens ?? 0) +
        (usage.cache_creation_input_tokens ?? 0) +
        (usage.cache_read_input_tokens ?? 0);
      let contextWindow: number | null = null;
      let modelId: string | null = null;
      if (r.modelUsage && typeof r.modelUsage === 'object') {
        // Pick whichever model entry actually carries a contextWindow. With
        // a single primary model the map has one entry; sub-agents may add
        // more, but the parent turn's window is what governs the chip.
        for (const [m, mu] of Object.entries(r.modelUsage)) {
          if (mu && typeof mu.contextWindow === 'number' && mu.contextWindow > 0) {
            contextWindow = mu.contextWindow;
            modelId = m;
            break;
          }
        }
      }
      store.setSessionContextUsage(e.sessionId, {
        totalTokens: turnTotalTokens,
        contextWindow,
        model: modelId
      });
      // PR-H: ccsm no longer persists message history. The CLI / Agent SDK
      // already writes every frame to ~/.claude/projects/<key>/<sid>.jsonl
      // as it streams; we just read from there on load. The previous
      // `saveMessages` call here was a redundant secondary write that
      // mirrored the SDK's own transcript into ccsm's SQLite.
      // `turn_done` notification policy: only ping when the turn meaningfully
      // consumed the user's patience — long (>15s), or errored, or this
      // session isn't the one being watched. Fast, successful, focused turns
      // are noise; we skip them.
      const startedAt = turnStartedAt.get(e.sessionId);
      turnStartedAt.delete(e.sessionId);
      const durationMs = startedAt ? Date.now() - startedAt : 0;
      const result = e.message as { subtype?: string; is_error?: boolean };
      const errored =
        !!result.is_error ||
        result.subtype === 'error_max_turns' ||
        result.subtype === 'error_during_execution';
      const isActive = store.activeId === e.sessionId;
      const windowFocused = typeof document !== 'undefined' && document.hasFocus();
      const sessionFocused = isActive && windowFocused;
      // Pulse the sidebar icon when the user isn't actively watching this
      // session's chat. Cleared by selectSession on click. Same focus rule as
      // the OS notification below — if the user has eyes on it, no pulse.
      if (!sessionFocused) {
        store.setSessionState(e.sessionId, 'waiting');
      }
      if (errored || durationMs >= TURN_DONE_THRESHOLD_MS || !sessionFocused) {
        const session = store.sessions.find((s) => s.id === e.sessionId);
        const sessionName = session?.name ?? 'Session';
        const title = errored
          ? i18next.t('notifications.turnErrorTitle', { name: sessionName })
          : i18next.t('notifications.turnDoneTitle', { name: sessionName });
        const body = errored ? i18next.t('notifications.turnErrorBody') : undefined;
        // Wave 1D: build extras for the the inlined notify module Adaptive Toast pipeline.
        // Last user / assistant message previews come from the in-store block
        // history; we cap them to 200 chars to keep the toast body readable.
        const blocks = useStore.getState().messagesBySession[e.sessionId] ?? [];
        const lastUser = [...blocks].reverse().find((b) => b.kind === 'user');
        const lastAssistant = [...blocks]
          .reverse()
          .find((b) => b.kind === 'assistant');
        const truncate = (s: string, n = 200): string =>
          s.length > n ? `${s.slice(0, n - 1)}…` : s;
        const groupName = session
          ? store.groups.find((g) => g.id === session.groupId)?.name ?? ''
          : '';
        const toolCount = blocks.filter((b) => b.kind === 'tool').length;
        void dispatchNotification({
          sessionId: e.sessionId,
          eventType: 'turn_done',
          title,
          body,
          extras: {
            toastId: `done-${e.sessionId}-${Date.now().toString(36)}`,
            sessionName,
            groupName,
            cwd: session?.cwd,
            elapsedMs: durationMs,
            toolCount,
            lastUserMsg:
              lastUser && 'text' in lastUser && typeof lastUser.text === 'string'
                ? truncate(lastUser.text)
                : '',
            lastAssistantMsg:
              lastAssistant && 'text' in lastAssistant && typeof lastAssistant.text === 'string'
                ? truncate(lastAssistant.text)
                : '',
          },
        });
      }
    }
  });

  api.onAgentExit((e) => {
    streamers.delete(e.sessionId);
    const store = useStore.getState();
    store.setRunning(e.sessionId, false);
    if (!e.error) return;
    store.appendBlocks(e.sessionId, [
      { kind: 'error', id: `exit-${Date.now().toString(36)}`, text: e.error }
    ]);
  });

  // Wire agent-layer diagnostics (F1). The electron main process emits these
  // on `agent:diagnostic` for init-handshake failures, control_request
  // timeouts, etc. — transient signals that aren't hard session-ending errors.
  // Land them in the store so AgentDiagnosticBanner can surface the latest one
  // non-intrusively above ChatStream.
  api.onAgentDiagnostic?.((e) => {
    useStore.getState().pushDiagnostic({
      sessionId: e.sessionId,
      level: e.level,
      code: e.code,
      message: e.message,
      timestamp: Date.now(),
    });
  });

  api.onAgentPermissionRequest((req) => {
    // Session-scoped "Allow always" fast-path: if the user previously ticked
    // "Allow always" for this tool name, auto-resolve Allow and skip rendering
    // a waiting block.
    if (maybeAutoResolveAllowAlways(req)) return;
    const store = useStore.getState();
    const block = permissionRequestToWaitingBlock(req);
    store.appendBlocks(req.sessionId, [block]);
    const isBackground = req.sessionId !== store.activeId;
    if (isBackground) {
      // Pulse the sidebar icon — same signal as turn_done, but raised
      // immediately because a permission request is the highest-priority
      // "agent needs you" event.
      store.setSessionState(req.sessionId, 'waiting');
      const session = store.sessions.find((s) => s.id === req.sessionId);
      let prompt = '';
      if (block.kind === 'question') {
        prompt = block.questions[0]?.question ?? i18next.t('questionBlock.title');
      } else if (block.kind === 'waiting') {
        prompt = block.intent === 'plan' ? i18next.t('chat.planTitle') : block.prompt;
      }
      const sessionName = session?.name ?? i18next.t('notifications.backgroundSessionFallback');
      backgroundWaitingHandler({ sessionId: req.sessionId, sessionName, prompt });
    }
    // OS-level notification dispatch is deduped/suppressed inside dispatch:
    // mute, focus, debounce, and per-event-type toggles all live there. We
    // just hand it the semantic event and let it decide whether to ping the OS.
    const session = store.sessions.find((s) => s.id === req.sessionId);
    const sessionName = session?.name ?? i18next.t('notifications.backgroundSessionFallback');
    const eventType = block.kind === 'question' ? 'question' : 'permission';
    const title =
      block.kind === 'question'
        ? i18next.t('notifications.questionTitle', { name: sessionName })
        : i18next.t('notifications.inputNeededTitle', { name: sessionName });
    let body: string | undefined;
    if (block.kind === 'question') {
      body = block.questions[0]?.question;
    } else if (block.kind === 'waiting') {
      body = block.intent === 'plan' ? i18next.t('chat.planTitle') : block.prompt;
    }
    void dispatchNotification({
      sessionId: req.sessionId,
      eventType,
      title,
      body,
      // Wave 1D: rich extras for the the inlined notify module Adaptive Toast. The toastId
      // for permission events is the requestId itself so the main-process
      // action router can resolve back into the same agent permission gate.
      // For question events we prefix with `q-` to mirror the in-app block id.
      extras:
        block.kind === 'question'
          ? {
              toastId: `q-${req.requestId}`,
              sessionName,
              cwd: session?.cwd,
              question: block.questions[0]?.question ?? '',
              selectionKind: block.questions[0]?.multiSelect ? 'multi' : 'single',
              optionCount: block.questions[0]?.options.length ?? 0,
            }
          : {
              toastId: req.requestId,
              sessionName,
              cwd: session?.cwd,
              toolName: req.toolName,
              toolBrief: typeof body === 'string' ? body : '',
            },
    });
  });

  api.onNotificationFocus?.(handleNotificationFocus);

  // Wave 1D: route Windows toast button activations back into the renderer
  // store. Main has already called `sessions.resolvePermission()` (so the
  // agent CLI is unblocked); we just need to clear the in-app waiting block
  // and seed `allowAlwaysTools` for `allow-always` so the same tool doesn't
  // re-prompt this session.
  api.onNotifyToastAction?.((e) => {
    const store = useStore.getState();
    if (e.action === 'allow' || e.action === 'allow-always' || e.action === 'reject') {
      const decision = e.action === 'reject' ? 'deny' : 'allow';
      store.resolvePermission(e.sessionId, e.requestId, decision);
      if (e.action === 'allow-always') {
        // The waiting block carries the toolName; look it up from the live
        // messages array. If it's already gone (race with the in-app prompt),
        // skip the seed — the user clearly didn't need the persistence.
        const blocks = store.messagesBySession[e.sessionId] ?? [];
        const block = blocks.find(
          (b) => b.kind === 'waiting' && b.requestId === e.requestId,
        );
        if (block && block.kind === 'waiting' && block.toolName) {
          store.addAllowAlways(block.toolName);
        }
      }
    }
    // `focus` carries no decision — the click already raised the window via
    // `notification:focusSession`, no further action needed here.
  });

  // Mirror notification runtime state into main (#307). The ask-question
  // retry timer fires in main ~30s after the original toast; by then the
  // user may have toggled notifications off or focused the question's
  // session. We push the two fields the retry gate needs whenever they
  // change. Push initial values immediately so a renderer that wires this
  // before the user touches anything still has a true mirror.
  const pushRuntimeState = (s: ReturnType<typeof useStore.getState>) => {
    void api.notifySetRuntimeState?.({
      notificationsEnabled: s.notificationSettings.enabled,
      activeSessionId: s.activeId || null,
    });
  };
  pushRuntimeState(useStore.getState());
  let lastEnabled = useStore.getState().notificationSettings.enabled;
  let lastActive = useStore.getState().activeId;
  useStore.subscribe((state) => {
    const enabled = state.notificationSettings.enabled;
    const active = state.activeId;
    if (enabled !== lastEnabled || active !== lastActive) {
      lastEnabled = enabled;
      lastActive = active;
      pushRuntimeState(state);
    }
  });
}
