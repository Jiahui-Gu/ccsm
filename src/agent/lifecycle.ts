import { useStore } from '../stores/store';
import { streamEventToTranslation, PartialAssistantStreamer } from './stream-to-blocks';
import { parseQuestions } from './ask-user-question';
import { dispatchNotification, handleNotificationFocus } from '../notifications/dispatch';
import { buildUserContentBlocks } from '../lib/attachments';
import { i18next } from '../i18n';
import type { MessageBlock } from '../types';

let installed = false;

const streamers = new Map<string, PartialAssistantStreamer>();
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
  const api = window.agentory;
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

export function subscribeAgentEvents(): void {
  if (installed) return;
  const api = window.agentory;
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
        useStore
          .getState()
          .streamAssistantText(e.sessionId, patch.blockId, patch.appendText, patch.done);
      }
      return;
    }
    const store = useStore.getState();
    const ctx =
      e.message.type === 'result'
        ? { interrupted: store.consumeInterrupted(e.sessionId) }
        : {};
    const { append, toolResults } = streamEventToTranslation(e.message, ctx);
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
      // Persist the finalized turn so reloading the app restores history.
      // Saving on `result` rather than on every delta avoids writing partial
      // streaming blocks; the bulk DELETE+INSERT is idempotent.
      const blocks = useStore.getState().messagesBySession[e.sessionId];
      if (blocks && blocks.length > 0 && typeof window.agentory?.saveMessages === 'function') {
        void window.agentory.saveMessages(e.sessionId, blocks);
      }
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
        void dispatchNotification({
          sessionId: e.sessionId,
          eventType: 'turn_done',
          title,
          body
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

  api.onAgentPermissionRequest((req) => {
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
      body
    });
  });

  api.onNotificationFocus?.(handleNotificationFocus);
}
