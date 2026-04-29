import { useEffect } from 'react';
import { subscribeAgentEvents } from '../agent/lifecycle';

/**
 * Mounts the agent-lifecycle IPC subscription that pipes
 * `session:state` events from main into the store via
 * `_applySessionState`. This is what drives the AgentIcon attention halo
 * (waiting/idle) for non-active sessions. Bridge install is idempotent
 * so StrictMode double-mount does not double-pipe events.
 *
 * Extracted from App.tsx for SRP under Task #724.
 */
export function useAgentEventBridge(): void {
  useEffect(() => {
    return subscribeAgentEvents();
  }, []);
}
