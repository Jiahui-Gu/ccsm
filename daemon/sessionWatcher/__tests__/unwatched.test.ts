// Unit test for sessionWatcher's `unwatched` teardown event.
//
// The notify pipeline subscribes to this event in main.ts to drop per-sid
// state when a CLI session ends.

import { describe, it, expect } from 'vitest';
import { __createForTest, type UnwatchedEvent } from '../index';

describe('sessionWatcher unwatched event', () => {
  it('fires when stopWatching drops an entry', () => {
    const w = __createForTest();
    const evts: UnwatchedEvent[] = [];
    w.on('unwatched', (e: UnwatchedEvent) => evts.push(e));

    // Prime an entry by calling startWatching with a path that may or may
    // not exist — the watcher tolerates missing files (ancestorWatcher
    // path) and still tracks the sid so stopWatching has work to do.
    w.startWatching('s1', '/nonexistent/path/s1.jsonl', undefined);
    w.stopWatching('s1');

    expect(evts).toEqual([{ sid: 's1' }]);
  });

  it('does not fire when stopWatching is called for an unknown sid', () => {
    const w = __createForTest();
    const evts: UnwatchedEvent[] = [];
    w.on('unwatched', (e: UnwatchedEvent) => evts.push(e));
    w.stopWatching('never-watched');
    expect(evts).toHaveLength(0);
  });
});
