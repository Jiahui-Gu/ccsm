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
    const store = useStore.getState();
    if (blocks.length > 0) store.appendBlocks(e.sessionId, blocks);
    // Result message means the SDK turn is complete — clear the running flag
    // so InputBar re-enables. Any other message means a turn is in flight.
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
}
