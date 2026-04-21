import { useStore } from '../stores/store';
import { streamEventToTranslation, PartialAssistantStreamer } from './stream-to-blocks';
import type { MessageBlock, QuestionSpec } from '../types';

let installed = false;

const streamers = new Map<string, PartialAssistantStreamer>();
function streamerFor(sessionId: string): PartialAssistantStreamer {
  let s = streamers.get(sessionId);
  if (!s) {
    s = new PartialAssistantStreamer();
    streamers.set(sessionId, s);
  }
  return s;
}

// Auto-prompt watchdog: when a session finishes a turn without uttering the
// configured "done token", reply on the user's behalf so the agent keeps
// going. Capped per-session so a runaway loop can't spam the SDK.
function maybeFireWatchdog(sessionId: string): void {
  const store = useStore.getState();
  const cfg = store.watchdog;
  if (!cfg.enabled) return;

  // Don't fire while a permission prompt is pending — the agent isn't really
  // idle, it's waiting on the user to approve a tool call.
  const blocks = store.messagesBySession[sessionId] ?? [];
  const hasPendingPermission = blocks.some(
    (b) => (b.kind === 'waiting' && b.requestId) || (b.kind === 'question' && b.requestId)
  );
  if (hasPendingPermission) return;

  // If the latest non-info signal is an error or rate-limit / API failure,
  // bail too — auto-replying into a broken session just spams the SDK and
  // racks up failed turns. The user needs to intervene.
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (b.kind === 'error') return;
    if (b.kind === 'status' && b.tone === 'warn') return;
    if (b.kind === 'assistant') break;
    if (b.kind === 'user') break;
  }

  // Find the last assistant text block. Streaming blocks count too — by the
  // time `result` lands, streaming has been finalized (streaming flag false).
  let lastAssistantText = '';
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (b.kind === 'assistant') {
      lastAssistantText = b.text;
      break;
    }
  }
  if (lastAssistantText.includes(cfg.doneToken)) return;

  const count = store.watchdogCountsBySession[sessionId] ?? 0;
  // maxAutoReplies <= 0 means unlimited.
  if (cfg.maxAutoReplies > 0 && count >= cfg.maxAutoReplies) {
    store.appendBlocks(sessionId, [
      {
        kind: 'status',
        id: `watchdog-cap-${Date.now().toString(36)}`,
        tone: 'warn',
        title: 'Autopilot paused',
        detail: `Reached ${cfg.maxAutoReplies} auto-replies without the done token; over to you.`
      }
    ]);
    return;
  }

  const next = store.bumpWatchdogCount(sessionId);
  const cap = cfg.maxAutoReplies > 0 ? `${cfg.maxAutoReplies}` : '∞';
  const prompt = `如果你真的做完了，请回复我：${cfg.doneToken}\n\n否则：${cfg.otherwisePostfix}`;
  store.appendBlocks(sessionId, [
    {
      kind: 'status',
      id: `watchdog-${Date.now().toString(36)}`,
      tone: 'info',
      title: `Autopilot ${next}/${cap}`,
      detail: 'Sent automatic follow-up because the agent stopped without the done token.'
    }
  ]);
  void window.agentory?.agentSend(sessionId, prompt);
  store.setRunning(sessionId, true);
}

type BackgroundWaitingHandler = (info: { sessionId: string; sessionName: string; prompt: string }) => void;
let backgroundWaitingHandler: BackgroundWaitingHandler = () => {};

export function setBackgroundWaitingHandler(h: BackgroundWaitingHandler): void {
  backgroundWaitingHandler = h;
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
    plan: planText
  };
}

function parseQuestions(input: Record<string, unknown>): QuestionSpec[] {
  const raw = input.questions;
  if (!Array.isArray(raw)) return [];
  const out: QuestionSpec[] = [];
  for (const q of raw) {
    if (!q || typeof q !== 'object') continue;
    const obj = q as Record<string, unknown>;
    const question = typeof obj.question === 'string' ? obj.question : '';
    if (!question) continue;
    const options = Array.isArray(obj.options)
      ? obj.options
          .filter((o): o is Record<string, unknown> => !!o && typeof o === 'object')
          .map((o) => ({
            label: typeof o.label === 'string' ? o.label : '',
            description: typeof o.description === 'string' ? o.description : undefined
          }))
          .filter((o) => o.label)
      : [];
    if (options.length === 0) continue;
    out.push({
      question,
      header: typeof obj.header === 'string' ? obj.header : undefined,
      multiSelect: obj.multiSelect === true,
      options
    });
  }
  return out;
}

export function subscribeAgentEvents(): void {
  if (installed) return;
  const api = window.agentory;
  if (!api) return;
  installed = true;

  api.onAgentEvent((e) => {
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
    const { append, toolResults } = streamEventToTranslation(e.message);
    const store = useStore.getState();
    if (append.length > 0) store.appendBlocks(e.sessionId, append);
    for (const tr of toolResults) {
      store.setToolResult(e.sessionId, tr.toolUseId, tr.result, tr.isError);
    }
    if (e.message.type === 'result') {
      store.setRunning(e.sessionId, false);
      maybeFireWatchdog(e.sessionId);
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
      const session = store.sessions.find((s) => s.id === req.sessionId);
      let prompt = '';
      if (block.kind === 'question') {
        prompt = block.questions[0]?.question ?? 'Question awaiting answer';
      } else if (block.kind === 'waiting') {
        prompt = block.intent === 'plan' ? 'Plan ready for review' : block.prompt;
      }
      const sessionName = session?.name ?? 'Background session';
      backgroundWaitingHandler({ sessionId: req.sessionId, sessionName, prompt });
    }
    // OS-level notification when the user almost certainly missed the in-app
    // toast: window unfocused, or active-session toast suppressed in-app for
    // a non-active session. Only ping for "needs your attention" requests
    // (any permission/plan/question), never on routine assistant streaming.
    const windowFocused = typeof document !== 'undefined' && document.hasFocus();
    if (isBackground || !windowFocused) {
      const session = store.sessions.find((s) => s.id === req.sessionId);
      const sessionName = session?.name ?? 'Background session';
      let title = `${sessionName} needs your input`;
      let body: string | undefined;
      if (block.kind === 'question') {
        body = block.questions[0]?.question;
      } else if (block.kind === 'waiting') {
        body = block.intent === 'plan' ? 'Plan ready for review' : block.prompt;
      }
      void api.notify({ sessionId: req.sessionId, title, body });
    }
  });
}
