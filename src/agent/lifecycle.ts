import { useStore } from '../stores/store';
import { sdkMessageToBlocks } from './sdk-to-blocks';

let installed = false;

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
    const blocks = sdkMessageToBlocks(e.message);
    const store = useStore.getState();
    if (blocks.length > 0) store.appendBlocks(e.sessionId, blocks);
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
    store.appendBlocks(req.sessionId, [
      {
        kind: 'waiting',
        id: `wait-${req.requestId}`,
        prompt: describePermission(req.toolName, req.input),
        intent: 'permission',
        requestId: req.requestId
      }
    ]);
  });
}
