import { useStore } from '../stores/store';
import { sdkMessageToTranslation } from './sdk-to-blocks';
import type { MessageBlock, QuestionSpec } from '../types';

let installed = false;

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
    const { append, toolResults } = sdkMessageToTranslation(e.message);
    const store = useStore.getState();
    if (append.length > 0) store.appendBlocks(e.sessionId, append);
    for (const tr of toolResults) {
      store.setToolResult(e.sessionId, tr.toolUseId, tr.result, tr.isError);
    }
    if (e.message.type === 'result') {
      store.setRunning(e.sessionId, false);
    }
  });

  api.onAgentExit((e) => {
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
    if (req.sessionId !== store.activeId) {
      const session = store.sessions.find((s) => s.id === req.sessionId);
      let prompt = '';
      if (block.kind === 'question') {
        prompt = block.questions[0]?.question ?? 'Question awaiting answer';
      } else if (block.kind === 'waiting') {
        prompt = block.intent === 'plan' ? 'Plan ready for review' : block.prompt;
      }
      backgroundWaitingHandler({
        sessionId: req.sessionId,
        sessionName: session?.name ?? 'Background session',
        prompt
      });
    }
  });
}
