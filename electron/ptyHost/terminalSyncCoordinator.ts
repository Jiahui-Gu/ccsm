import type {
  SessionSnapshotMessage,
  TerminalGeometry,
} from '../../src/shared/mobileRemote/protocol';
import type { Entry } from './entryFactory';
import {
  captureEntrySnapshot,
  getCanonicalGeometry,
  resizeCanonicalGeometry,
  type PtyResizeOrigin,
} from './lifecycle';

export type TerminalSyncPublication =
  | {
      type: 'chunk';
      sid: string;
      seq: number;
      chunk: string;
      geometryEpoch: number;
    }
  | {
      type: 'barrier';
      sid: string;
      seq: number;
      snapshot: string;
      geometry: TerminalGeometry;
    };

export type CoordinatedSessionSnapshot = SessionSnapshotMessage & {
  snapshot: string;
  geometry: TerminalGeometry;
};

export type TerminalSyncPublicationListener = (
  publication: TerminalSyncPublication,
) => void;

const publicationListeners = new Set<TerminalSyncPublicationListener>();

function emitTerminalSyncPublication(publication: TerminalSyncPublication): void {
  for (const listener of publicationListeners) {
    try {
      listener(publication);
    } catch (error) {
      console.warn('[ptyHost] terminal sync publication listener threw', error);
    }
  }
}

function enqueue<T>(
  entry: Entry,
  operation: () => Promise<T> | T,
): Promise<T> {
  const result = entry.terminalSyncQueue.then(operation, operation);
  entry.terminalSyncQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export function enqueueChunkPublication(
  entry: Entry,
  sid: string,
  seq: number,
  chunk: string,
): void {
  void enqueue(entry, () => {
    emitTerminalSyncPublication({
      type: 'chunk',
      sid,
      seq,
      chunk,
      geometryEpoch: entry.geometryEpoch,
    });
  });
}

export function commitResizeBarrier(
  registry: Map<string, Entry>,
  sid: string,
  cols: number,
  rows: number,
  origin: PtyResizeOrigin,
): Promise<CoordinatedSessionSnapshot | null> {
  const entry = registry.get(sid);
  if (!entry) return Promise.resolve(null);

  return enqueue(entry, async () => {
    if (registry.get(sid) !== entry) return null;
    const geometry = resizeCanonicalGeometry(registry, sid, cols, rows, origin);
    if (!geometry) return null;
    const { snapshot, seq } = await captureEntrySnapshot(entry);
    const message: CoordinatedSessionSnapshot = {
      type: 'session.snapshot',
      sid,
      seq,
      snapshot,
      geometry,
    };
    emitTerminalSyncPublication({
      type: 'barrier',
      sid,
      seq,
      snapshot,
      geometry,
    });
    return message;
  });
}

export function getCoordinatedSnapshot(
  registry: Map<string, Entry>,
  sid: string,
): Promise<CoordinatedSessionSnapshot | null> {
  const entry = registry.get(sid);
  if (!entry) return Promise.resolve(null);

  return enqueue(entry, async () => {
    if (registry.get(sid) !== entry) return null;
    const { snapshot, seq } = await captureEntrySnapshot(entry);
    const geometry = getCanonicalGeometry(registry, sid);
    if (!geometry) return null;
    return {
      type: 'session.snapshot',
      sid,
      seq,
      snapshot,
      geometry,
    };
  });
}

export function onTerminalSyncPublication(
  listener: TerminalSyncPublicationListener,
): () => void {
  publicationListeners.add(listener);
  return () => {
    publicationListeners.delete(listener);
  };
}
