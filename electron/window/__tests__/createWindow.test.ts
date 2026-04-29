import { describe, it, expect, vi, beforeEach } from 'vitest';

// Capture context-menu listener + popup invocations from the BrowserWindow
// mock. Each test flushes via beforeEach so `popupCalls.length === 0` is the
// reverse-verify baseline that proves the listener actually wired up.
const popupCalls: Array<{ items: unknown[]; window: unknown }> = [];

vi.mock('electron', () => {
  const Menu = {
    buildFromTemplate: (items: unknown[]) => ({
      popup: (opts: { window: unknown }) =>
        popupCalls.push({ items, window: opts.window }),
    }),
  };
  return { Menu };
});

import { installContextMenu } from '../createWindow';

interface ContextMenuParams {
  selectionText: string;
  isEditable: boolean;
  editFlags: {
    canCut: boolean;
    canCopy: boolean;
    canPaste: boolean;
    canSelectAll: boolean;
  };
}

type ContextMenuListener = (event: unknown, params: ContextMenuParams) => void;

function makeFakeWindow() {
  const listeners: ContextMenuListener[] = [];
  const win = {
    webContents: {
      on: (event: string, listener: ContextMenuListener) => {
        if (event === 'context-menu') listeners.push(listener);
      },
    },
  };
  return {
    win: win as unknown as Parameters<typeof installContextMenu>[0],
    fire: (params: ContextMenuParams) => {
      for (const l of listeners) l({}, params);
    },
    listenerCount: () => listeners.length,
  };
}

describe('installContextMenu', () => {
  beforeEach(() => {
    popupCalls.length = 0;
  });

  it('registers a single context-menu listener on the window webContents', () => {
    const fake = makeFakeWindow();
    installContextMenu(fake.win);
    expect(fake.listenerCount()).toBe(1);
  });

  it('shows copy + select-all on a non-editable surface with selection', () => {
    const fake = makeFakeWindow();
    installContextMenu(fake.win);
    fake.fire({
      selectionText: 'hello',
      isEditable: false,
      editFlags: {
        canCut: false,
        canCopy: true,
        canPaste: false,
        canSelectAll: true,
      },
    });
    expect(popupCalls).toHaveLength(1);
    const items = popupCalls[0].items as Array<Record<string, unknown>>;
    // Non-editable: cut + paste are skipped; copy is enabled because selection
    // is non-empty AND canCopy is true; separator + selectAll always trail.
    expect(items.map((i) => i.role)).toEqual(['copy', undefined, 'selectAll']);
    expect(items[0].enabled).toBe(true);
    expect(items[2].enabled).toBe(true);
  });

  it('shows cut/copy/paste + selectAll on an editable surface', () => {
    const fake = makeFakeWindow();
    installContextMenu(fake.win);
    fake.fire({
      selectionText: 'word',
      isEditable: true,
      editFlags: {
        canCut: true,
        canCopy: true,
        canPaste: true,
        canSelectAll: true,
      },
    });
    expect(popupCalls).toHaveLength(1);
    const items = popupCalls[0].items as Array<Record<string, unknown>>;
    expect(items.map((i) => i.role)).toEqual([
      'cut',
      'copy',
      'paste',
      undefined,
      'selectAll',
    ]);
    for (const i of items.filter((x) => x.role !== undefined)) {
      expect(i.enabled).toBe(true);
    }
  });

  it('disables copy when selection is empty', () => {
    const fake = makeFakeWindow();
    installContextMenu(fake.win);
    fake.fire({
      selectionText: '   ',
      isEditable: false,
      editFlags: {
        canCut: false,
        canCopy: true,
        canPaste: false,
        canSelectAll: true,
      },
    });
    const items = popupCalls[0].items as Array<Record<string, unknown>>;
    const copy = items.find((i) => i.role === 'copy');
    expect(copy?.enabled).toBe(false);
  });

  it('disables paste when canPaste is false on editable surface', () => {
    const fake = makeFakeWindow();
    installContextMenu(fake.win);
    fake.fire({
      selectionText: '',
      isEditable: true,
      editFlags: {
        canCut: false,
        canCopy: false,
        canPaste: false,
        canSelectAll: true,
      },
    });
    const items = popupCalls[0].items as Array<Record<string, unknown>>;
    const paste = items.find((i) => i.role === 'paste');
    expect(paste?.enabled).toBe(false);
  });
});
