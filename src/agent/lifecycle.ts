import { useStore } from '../stores/store';
import { sdkMessageToBlocks } from './sdk-to-blocks';

let installed = false;

export function subscribeAgentEvents(): void {
  if (installed) return;
  const api = window.agentory;
  if (!api) return;
  installed = true;

  api.onAgentEvent((e) => {
    const blocks = sdkMessageToBlocks(e.message);
    if (blocks.length > 0) useStore.getState().appendBlocks(e.sessionId, blocks);
  });

  api.onAgentExit((e) => {
    if (!e.error) return;
    useStore.getState().appendBlocks(e.sessionId, [
      { kind: 'error', id: `exit-${Date.now().toString(36)}`, text: e.error }
    ]);
  });
}
