import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../stores/store';
import type { MessageBlock, PrCheckStatus } from '../types';

// Module-scoped registry of timers keyed by session id so the orchestrator
// can cancel polling on unmount / session switch. Polling is per-PR; one
// active poll per session is the design (you don't open two PRs at once
// from the same worktree).
const pollTimers = new Map<string, ReturnType<typeof setTimeout>>();
const pollStopFlags = new Map<string, boolean>();

const POLL_INTERVAL_MS = 30_000;
const POLL_TIMEOUT_MS = 30 * 60 * 1000;

// Shape returned by the preflight IPC, mirroring electron/pr.ts.
type PreflightOk = {
  ok: true;
  branch: string;
  base: string;
  availableBases: string[];
  repoRoot: string;
  suggestedTitle: string;
  suggestedBody: string;
};
type PreflightErr = { ok: false; errors: Array<{ code: string; detail: string; branch?: string }> };
type PreflightResult = PreflightOk | PreflightErr;

type CreateResult =
  | { ok: true; url: string; number: number }
  | { ok: false; error: string };

type ChecksResult = { ok: true; checks: PrCheckStatus[] } | { ok: false; error: string };

export type DialogState =
  | { phase: 'idle' }
  | { phase: 'preflight'; sessionId: string }
  | {
      phase: 'form';
      sessionId: string;
      preflight: PreflightOk;
    }
  | {
      phase: 'submitting';
      sessionId: string;
      preflight: PreflightOk;
      error?: string;
    };

export interface PrFlowApi {
  dialog: DialogState;
  startFromSlash: (sessionId: string) => Promise<void>;
  submit: (v: { title: string; body: string; base: string; draft: boolean }) => Promise<void>;
  cancel: () => void;
}

// Module-scoped registered handler so non-React code (e.g. the InputBar's
// send-path on receipt of /pr) can invoke the flow without threading a
// React context through every call site. Populated by PrFlowProvider on
// mount, cleared on unmount.
let registeredTrigger: ((sessionId: string) => void) | null = null;
export function triggerPrFlow(sessionId: string): boolean {
  if (!registeredTrigger) return false;
  registeredTrigger(sessionId);
  return true;
}
export function registerPrFlowTrigger(fn: ((sessionId: string) => void) | null): void {
  registeredTrigger = fn;
}

function nextBlockId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

// All chat-block mutations go through the zustand store so persistence and
// re-renders fall out for free.
function appendBlock(sessionId: string, block: MessageBlock): void {
  useStore.getState().appendBlocks(sessionId, [block]);
}

function replaceBlock(sessionId: string, blockId: string, patch: Partial<MessageBlock>): void {
  const prev = useStore.getState().messagesBySession[sessionId] ?? [];
  const existing = prev.find((b) => b.id === blockId);
  if (!existing) return;
  const merged = { ...existing, ...patch } as MessageBlock;
  useStore.getState().appendBlocks(sessionId, [merged]);
}

function pushError(sessionId: string, title: string, detail?: string): void {
  appendBlock(sessionId, {
    kind: 'status',
    id: nextBlockId('pr-err'),
    tone: 'warn',
    title,
    detail
  });
}

export function usePrFlow(): PrFlowApi {
  const [dialog, setDialog] = useState<DialogState>({ phase: 'idle' });
  // Mirror in a ref so async callbacks can read the latest phase without
  // retrigger-ing via effect deps.
  const dialogRef = useRef<DialogState>(dialog);
  dialogRef.current = dialog;

  useEffect(() => {
    return () => {
      // Stop all polls on unmount.
      for (const [sid, t] of pollTimers) {
        clearTimeout(t);
        pollStopFlags.set(sid, true);
      }
      pollTimers.clear();
    };
  }, []);

  const startFromSlash = useCallback(async (sessionId: string) => {
    const sess = useStore.getState().sessions.find((s) => s.id === sessionId);
    setDialog({ phase: 'preflight', sessionId });
    const api = window.agentory;
    if (!api?.pr) {
      pushError(sessionId, 'PR helpers unavailable', 'The main-process IPC for /pr is not wired up.');
      setDialog({ phase: 'idle' });
      return;
    }
    const res = (await api.pr.preflight(sess?.cwd ?? null)) as PreflightResult;
    if (!res.ok) {
      for (const e of res.errors) {
        pushError(sessionId, labelForPreflightError(e.code), e.detail);
      }
      setDialog({ phase: 'idle' });
      return;
    }
    setDialog({ phase: 'form', sessionId, preflight: res });
  }, []);

  const submit = useCallback(
    async (v: { title: string; body: string; base: string; draft: boolean }) => {
      const cur = dialogRef.current;
      if (cur.phase !== 'form' && cur.phase !== 'submitting') return;
      const { sessionId, preflight } = cur;
      setDialog({ phase: 'submitting', sessionId, preflight });

      // Pre-create a status block that we'll update in-place.
      const blockId = nextBlockId('pr');
      appendBlock(sessionId, {
        kind: 'pr-status',
        id: blockId,
        phase: 'opening',
        base: v.base,
        branch: preflight.branch
      });

      const api = window.agentory;
      if (!api?.pr) {
        replaceBlock(sessionId, blockId, {
          kind: 'pr-status',
          id: blockId,
          phase: 'failed',
          error: 'PR helpers unavailable'
        } as MessageBlock);
        setDialog({ phase: 'idle' });
        return;
      }

      const res = (await api.pr.create({
        cwd: preflight.repoRoot,
        branch: preflight.branch,
        base: v.base,
        title: v.title,
        body: v.body,
        draft: v.draft
      })) as CreateResult;

      if (!res.ok) {
        // Keep the dialog open so the user can tweak and retry.
        replaceBlock(sessionId, blockId, {
          kind: 'pr-status',
          id: blockId,
          phase: 'failed',
          error: res.error,
          base: v.base,
          branch: preflight.branch
        } as MessageBlock);
        setDialog({ phase: 'submitting', sessionId, preflight, error: res.error });
        // Bounce back to the form so buttons become active again.
        setTimeout(() => setDialog({ phase: 'form', sessionId, preflight }), 0);
        return;
      }

      // Success: close dialog, render the PR block, start polling.
      replaceBlock(sessionId, blockId, {
        kind: 'pr-status',
        id: blockId,
        phase: 'polling',
        number: res.number,
        url: res.url,
        base: v.base,
        branch: preflight.branch,
        checks: []
      } as MessageBlock);
      setDialog({ phase: 'idle' });
      startPolling(sessionId, blockId, preflight.repoRoot, res.number);
    },
    []
  );

  const cancel = useCallback(() => {
    setDialog({ phase: 'idle' });
  }, []);

  return { dialog, startFromSlash, submit, cancel };
}

function labelForPreflightError(code: string): string {
  switch (code) {
    case 'no-cwd':
      return 'No working directory set';
    case 'not-git':
      return 'Not a git repository';
    case 'no-gh':
      return 'GitHub CLI missing';
    case 'on-default-branch':
      return 'Refusing to PR from the default branch';
    case 'dirty-tree':
      return 'Uncommitted changes';
    default:
      return 'Preflight check failed';
  }
}

function startPolling(sessionId: string, blockId: string, cwd: string, prNumber: number): void {
  const startedAt = Date.now();
  pollStopFlags.set(sessionId, false);

  const tick = async () => {
    if (pollStopFlags.get(sessionId)) return;
    const api = window.agentory;
    if (!api?.pr) return;
    const res = (await api.pr.checks(cwd, prNumber)) as ChecksResult;
    if (pollStopFlags.get(sessionId)) return;

    // Fetch current block so we can patch it. Store-level append coalesces
    // by id so this round-trip is safe.
    const cur = useStore
      .getState()
      .messagesBySession[sessionId]?.find((b) => b.id === blockId);
    if (!cur || cur.kind !== 'pr-status') {
      stopPolling(sessionId);
      return;
    }

    let checks: PrCheckStatus[] = cur.checks ?? [];
    if (res.ok) {
      checks = res.checks;
    }
    const agg = aggregateClient(checks);
    const done = agg === 'passing' || agg === 'failing';
    replaceBlock(sessionId, blockId, {
      ...cur,
      checks,
      phase: done ? 'done' : 'polling',
      lastPollAt: Date.now()
    } as MessageBlock);

    if (done) {
      stopPolling(sessionId);
      return;
    }
    if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
      stopPolling(sessionId);
      return;
    }
    const t = setTimeout(tick, POLL_INTERVAL_MS);
    pollTimers.set(sessionId, t);
  };

  // First tick fires immediately so the block shows live checks within a
  // second of PR creation, not 30s later.
  void tick();
}

function stopPolling(sessionId: string): void {
  const t = pollTimers.get(sessionId);
  if (t) clearTimeout(t);
  pollTimers.delete(sessionId);
  pollStopFlags.set(sessionId, true);
}

// Mirror of electron/pr.ts `aggregateChecks`, minus the 'empty' state —
// during polling an empty list just means "waiting for CI to register".
export function aggregateClient(checks: PrCheckStatus[]): 'pending' | 'passing' | 'failing' {
  if (checks.length === 0) return 'pending';
  let hasIncomplete = false;
  for (const c of checks) {
    if (c.status !== 'completed') {
      hasIncomplete = true;
      continue;
    }
    const conc = c.conclusion;
    if (
      conc === 'failure' ||
      conc === 'cancelled' ||
      conc === 'timed_out' ||
      conc === 'action_required'
    )
      return 'failing';
  }
  return hasIncomplete ? 'pending' : 'passing';
}
