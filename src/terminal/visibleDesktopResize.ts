export const VISIBLE_DESKTOP_RESIZE_DEBOUNCE_MS = 140;

const MAX_TERMINAL_DIMENSION = 1000;

type ResizeDims = { cols: number; rows: number };

type PendingResize = ResizeDims & {
  sid: string;
  timer: ReturnType<typeof setTimeout>;
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

function invalidDimensionsError(cols: number, rows: number): Error {
  return new Error(`invalid_visible_desktop_resize:${cols}x${rows}`);
}

export function createVisibleDesktopResizeScheduler(deps: {
  isVisible(sid: string): boolean;
  resize(sid: string, cols: number, rows: number): Promise<void>;
  onError?(error: unknown, sid: string, cols: number, rows: number): void;
}): VisibleDesktopResizeScheduler {
  let pending: PendingResize | null = null;
  const lastCommitted = new Map<string, ResizeDims>();

  const clearPending = (): void => {
    if (!pending) return;
    clearTimeout(pending.timer);
    pending = null;
  };

  const commit = async (sid: string, cols: number, rows: number): Promise<void> => {
    if (!isValidDimensions(cols, rows)) {
      throw invalidDimensionsError(cols, rows);
    }
    if (!deps.isVisible(sid)) return;
    const last = lastCommitted.get(sid);
    if (last && last.cols === cols && last.rows === rows) return;
    await deps.resize(sid, cols, rows);
    lastCommitted.set(sid, { cols, rows });
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
      if (!pending || pending.sid !== sid) return;
      clearPending();
    },

    dispose() {
      clearPending();
      lastCommitted.clear();
    },
  };
}
