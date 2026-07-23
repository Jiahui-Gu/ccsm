export const VISIBLE_DESKTOP_RESIZE_DEBOUNCE_MS = 140;

const MAX_TERMINAL_DIMENSION = 1000;

type ResizeDims = { cols: number; rows: number };

type PendingResize = ResizeDims & {
  sid: string;
  timer: ReturnType<typeof setTimeout>;
};

type InFlightResize = {
  dims: ResizeDims;
  generation: number;
  promise: Promise<void>;
};

type QueuedResizeWaiter = {
  resolve: () => void;
  reject: (reason: unknown) => void;
};

type QueuedResize = {
  dims: ResizeDims;
  waiters: QueuedResizeWaiter[];
};

export type VisibleDesktopResizeScheduler = {
  schedule(sid: string, cols: number, rows: number): void;
  commitNow(sid: string, cols: number, rows: number): Promise<void>;
  cancel(sid: string): void;
  dispose(): void;
};

function isValidDimensions(cols: number, rows: number): boolean {
  return (
    Number.isInteger(cols) &&
    Number.isInteger(rows) &&
    cols >= 1 &&
    rows >= 1 &&
    cols <= MAX_TERMINAL_DIMENSION &&
    rows <= MAX_TERMINAL_DIMENSION
  );
}

function sameDimensions(a: ResizeDims | undefined, b: ResizeDims): boolean {
  return !!a && a.cols === b.cols && a.rows === b.rows;
}

export function createVisibleDesktopResizeScheduler(deps: {
  isVisible(sid: string): boolean;
  resize(sid: string, cols: number, rows: number): Promise<void>;
  onError?(error: unknown, sid: string, cols: number, rows: number): void;
}): VisibleDesktopResizeScheduler {
  let pending: PendingResize | null = null;
  const lastCommitted = new Map<string, ResizeDims>();
  const inFlight = new Map<string, InFlightResize>();
  const queuedBySid = new Map<string, QueuedResize>();
  const queueDrainBySid = new Map<string, Promise<void>>();
  const generationBySid = new Map<string, number>();

  const clearPending = (): void => {
    if (!pending) return;
    clearTimeout(pending.timer);
    pending = null;
  };

  const bumpSidGeneration = (sid: string): void => {
    const nextGeneration = (generationBySid.get(sid) ?? 0) + 1;
    generationBySid.set(sid, nextGeneration);
  };

  const settleQueuedWaiters = (
    waiters: QueuedResizeWaiter[],
    result: { ok: true } | { ok: false; error: unknown },
  ): void => {
    for (const waiter of waiters) {
      if (result.ok) waiter.resolve();
      else waiter.reject(result.error);
    }
  };

  const clearSidSuppression = (sid: string): void => {
    bumpSidGeneration(sid);
    lastCommitted.delete(sid);
    inFlight.delete(sid);
    const queued = queuedBySid.get(sid);
    if (queued) {
      queuedBySid.delete(sid);
      settleQueuedWaiters(queued.waiters, { ok: true });
    }
  };

  const requestResize = async (sid: string, dims: ResizeDims): Promise<void> => {
    if (!isValidDimensions(dims.cols, dims.rows)) return;
    if (!deps.isVisible(sid)) return;
    if (sameDimensions(lastCommitted.get(sid), dims)) return;

    if (!generationBySid.has(sid)) generationBySid.set(sid, 0);
    const generation = generationBySid.get(sid)!;
    const promise = deps.resize(sid, dims.cols, dims.rows).then(() => {
      if (generationBySid.get(sid) === generation) {
        lastCommitted.set(sid, { cols: dims.cols, rows: dims.rows });
      }
    });
    inFlight.set(sid, { dims, generation, promise });
    try {
      await promise;
    } finally {
      const current = inFlight.get(sid);
      if (current?.promise === promise) inFlight.delete(sid);
    }
  };

  const drainQueuedForSid = async (sid: string): Promise<void> => {
    while (!inFlight.has(sid)) {
      const queued = queuedBySid.get(sid);
      if (!queued) return;
      queuedBySid.delete(sid);
      try {
        await requestResize(sid, queued.dims);
        settleQueuedWaiters(queued.waiters, { ok: true });
      } catch (error) {
        settleQueuedWaiters(queued.waiters, { ok: false, error });
      }
    }
  };

  const ensureQueueDrain = (sid: string, gate: Promise<unknown>): void => {
    if (queueDrainBySid.has(sid)) return;
    const run = (async () => {
      await gate.catch(() => undefined);
      await drainQueuedForSid(sid);
    })().finally(() => {
      if (queueDrainBySid.get(sid) === run) queueDrainBySid.delete(sid);
      if (!queueDrainBySid.has(sid) && !inFlight.has(sid) && queuedBySid.has(sid)) {
        ensureQueueDrain(sid, Promise.resolve());
      }
    });
    queueDrainBySid.set(sid, run);
  };

  const enqueueBehindInFlight = (sid: string, dims: ResizeDims): Promise<void> => {
    const deferred = new Promise<void>((resolve, reject) => {
      const existing = queuedBySid.get(sid);
      if (existing) {
        existing.dims = dims;
        existing.waiters.push({ resolve, reject });
      } else {
        queuedBySid.set(sid, {
          dims,
          waiters: [{ resolve, reject }],
        });
      }
    });
    const active = inFlight.get(sid);
    if (active) ensureQueueDrain(sid, active.promise);
    else ensureQueueDrain(sid, Promise.resolve());
    return deferred;
  };

  const commit = async (sid: string, cols: number, rows: number): Promise<void> => {
    const dims = { cols, rows };
    if (!isValidDimensions(cols, rows)) return;
    if (!deps.isVisible(sid)) return;
    if (sameDimensions(lastCommitted.get(sid), dims)) return;

    const active = inFlight.get(sid);
    if (active) {
      if (sameDimensions(active.dims, dims)) return active.promise;
      return enqueueBehindInFlight(sid, dims);
    }

    await requestResize(sid, dims);
    ensureQueueDrain(sid, Promise.resolve());
  };

  return {
    schedule(sid, cols, rows) {
      if (!isValidDimensions(cols, rows)) return;
      if (!deps.isVisible(sid)) return;

      clearPending();
      const next = {
        sid,
        cols,
        rows,
        timer: setTimeout(() => {
          if (pending !== next) return;
          pending = null;
          void commit(next.sid, next.cols, next.rows).catch((error) => {
            deps.onError?.(error, next.sid, next.cols, next.rows);
          });
        }, VISIBLE_DESKTOP_RESIZE_DEBOUNCE_MS),
      } satisfies PendingResize;
      pending = next;
    },

    async commitNow(sid, cols, rows) {
      if (pending?.sid === sid) {
        clearPending();
      }
      await commit(sid, cols, rows);
    },

    cancel(sid) {
      if (pending?.sid === sid) clearPending();
      clearSidSuppression(sid);
    },

    dispose() {
      clearPending();
      const allSids = new Set<string>([
        ...lastCommitted.keys(),
        ...inFlight.keys(),
        ...queuedBySid.keys(),
        ...generationBySid.keys(),
      ]);
      for (const sid of allSids) clearSidSuppression(sid);
      queueDrainBySid.clear();
    },
  };
}
