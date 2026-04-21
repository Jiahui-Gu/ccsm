import { useEffect } from 'react';
import { PrDialog } from './PrDialog';
import { usePrFlow, registerPrFlowTrigger } from '../lib/pr-flow';

// App-level mount point for the /pr flow:
//   - Owns dialog state.
//   - Registers a module-scoped trigger so the InputBar send-path can
//     fire /pr without prop-drilling a handler through every component.
//   - Renders the dialog; the post-submit "open PR" status block is
//     injected into the chat stream via the store, not rendered here.
export function PrFlowProvider() {
  const flow = usePrFlow();

  useEffect(() => {
    registerPrFlowTrigger((sessionId) => {
      void flow.startFromSlash(sessionId);
    });
    return () => registerPrFlowTrigger(null);
  }, [flow]);

  const preflight =
    flow.dialog.phase === 'form' || flow.dialog.phase === 'submitting'
      ? flow.dialog.preflight
      : null;
  const submitting = flow.dialog.phase === 'submitting';
  const submitError =
    flow.dialog.phase === 'submitting' ? flow.dialog.error ?? null : null;
  const open = flow.dialog.phase === 'form' || flow.dialog.phase === 'submitting';

  return (
    <PrDialog
      open={open}
      onOpenChange={(o) => {
        if (!o) flow.cancel();
      }}
      preflight={preflight}
      submitting={submitting}
      submitError={submitError}
      onSubmit={(v) => void flow.submit(v)}
    />
  );
}
