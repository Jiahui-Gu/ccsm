// electron/main-crash-wiring.ts
import type { CrashCollector } from './crash/collector';

export interface WireOpts {
  collector: CrashCollector;
  processRef: NodeJS.Process;
}

function serialize(err: unknown): { message: string; stack?: string; name?: string } {
  if (err instanceof Error) return { message: err.message, stack: err.stack, name: err.name };
  return { message: String(err) };
}

export function wireCrashHandlers({ collector, processRef }: WireOpts): void {
  processRef.on('uncaughtException', (err: unknown) => {
    try { collector.recordIncident({ surface: 'main', error: serialize(err) }); }
    catch (e) { console.error('crash collector failed', e); }
  });
  processRef.on('unhandledRejection', (reason: unknown) => {
    try { collector.recordIncident({ surface: 'main', error: serialize(reason) }); }
    catch (e) { console.error('crash collector failed', e); }
  });
}
