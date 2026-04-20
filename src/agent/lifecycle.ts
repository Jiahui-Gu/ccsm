import { useStore } from '../stores/store';
import { sdkMessageToTranslation } from './sdk-to-blocks';

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
    const prompt = describePermission(req.toolName, req.input);
    store.appendBlocks(req.sessionId, [
      {
        kind: 'waiting',
        id: `wait-${req.requestId}`,
        prompt,
        intent: 'permission',
        requestId: req.requestId
      }
    ]);
    if (req.sessionId !== store.activeId) {
      const session = store.sessions.find((s) => s.id === req.sessionId);
      backgroundWaitingHandler({
        sessionId: req.sessionId,
        sessionName: session?.name ?? 'Background session',
        prompt
      });
    }
  });
}
