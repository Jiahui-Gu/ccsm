# Mobile Remote Shared UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give desktop and phone one platform-neutral grouped session navigator, state glyph vocabulary, terminal chrome, and reliable reconnect workflow while preserving Electron, PTY, encrypted relay, and Cloudflare behavior.

**Architecture:** Browser-safe TypeScript types and React presentation live under `src/shared/sessionNavigator/`. The desktop keeps Zustand, DnD, context menus, window chrome, and PTY ownership behind adapters; Electron assembles encrypted navigation replacements from persisted metadata plus the live PTY registry; the phone uses a dedicated reducer/store and React shell around the existing relay client and xterm sequence rules.

**Tech Stack:** Electron 41, React 18, TypeScript 5.7, Zustand 5, xterm.js 5.5, webpack 5, Vitest 4, Testing Library, Playwright 1.59, Cloudflare Workers/Durable Objects, npm only.

## Global Constraints

- Keep `package.json` version exactly `0.2.20`; do not create tags or release artifacts.
- Use npm only; never run pnpm or yarn.
- Node remains `>=22.0.0`.
- Renderer code under `src/` communicates with Electron only through typed preload bridges.
- Shared modules import no Electron, Node-only, desktop Zustand, DnD, Radix context-menu, or window-control modules.
- Preserve PTY ownership, buffer snapshots, sequence deduplication, resize clamping, input routing, encryption, replay protection, pairing rotation, heartbeat, reconnect backoff, and Cloudflare relay authentication gates.
- Send only metadata for sessions that currently have a controllable PTY; never expose arbitrary database rows.
- Full versioned navigation replacements are the default; do not add incremental navigation patches.
- Keep creating, moving, renaming, archiving, importing, searching, and configuring sessions desktop-only.
- Keep `sessions.list` during the compatibility window and add the richer navigation message alongside it.
- Keep English and Chinese desktop copy synchronized when copy changes.
- Phone targets are at least 44 CSS pixels and account for safe-area and `visualViewport` changes.
- Every behavior change begins with a failing focused test and ends with the smallest targeted passing command.

## File Structure

### Shared browser-safe navigation

- `src/shared/sessionNavigator/types.ts` — canonical model, state vocabulary, message version, and presentation props.
- `src/shared/sessionNavigator/buildModel.ts` — pure ordering, filtering, active-state, and malformed-record normalization.
- `src/shared/sessionNavigator/SessionStateGlyph.tsx` — accessible active/idle/waiting/exited glyphs.
- `src/shared/sessionNavigator/SessionNavigatorItem.tsx` — pure row typography, cwd truncation, selection, and status.
- `src/shared/sessionNavigator/SessionGroupHeader.tsx` — pure group disclosure and count presentation.
- `src/shared/sessionNavigator/SessionNavigator.tsx` — grouped navigator composition for phone and simple consumers.
- `src/shared/sessionNavigator/sessionNavigator.css` — semantic tokens and shared presentation classes.
- `src/shared/sessionNavigator/index.ts` — browser-safe public exports.

### Protocol and Electron adapter

- `src/shared/mobileRemote/protocol.ts` — one shared client/server message union, legacy list entry, and versioned navigator message.
- `src/shared/mobileRemote/index.ts` — re-export navigation protocol contracts.
- `electron/remote/navigationSource.ts` — parse the persisted `main` snapshot, intersect it with live PTYs, and produce the remote navigator.
- `electron/remote/remoteMessages.ts` — transport-neutral request handling and compatibility list/navigator responses.
- `electron/remote/mobileRemoteController.ts` — send compatibility list then navigator after encrypted authentication.
- `electron/remote/mobileRemoteServer.ts` — loopback auth response and navigator polling.

### Desktop adapter

- `src/components/sidebar/DesktopSessionPresentation.tsx` — maps a `Session` plus runtime crash/flash state into shared item props.
- `src/components/sidebar/SessionRow.tsx` — retains DnD, context menu, rename, keyboard, and scroll behavior around shared row presentation.
- `src/components/sidebar/GroupRow.tsx` — retains droppable/context-menu/rename behavior around shared group presentation.
- `src/components/Sidebar.tsx` — builds a platform-neutral model without changing action chrome or ordering.
- `src/components/ui/StateGlyph.tsx` — delegates the existing waiting-only use to the shared glyph without changing callers.

### Phone React shell

- `src/mobile/mobileRemoteStore.ts` — phone-only reducer/store for navigation, selection, terminal frames, controls, and UI status.
- `src/mobile/components/PhoneShell.tsx` — top bar, reconnect/error banners, drawer, terminal, key bar, and empty states.
- `src/mobile/components/SessionDrawer.tsx` — modal drawer with focus trap and close semantics.
- `src/mobile/components/MobileTerminal.tsx` — xterm lifecycle, fit, viewport/orientation handling, and input gating.
- `src/mobile/components/TerminalKeyBar.tsx` — Esc, Tab, sticky Ctrl, arrows, interrupt, and Enter.
- `src/mobile/index.tsx` — pairing bootstrap and React root.
- `src/mobile/mobile.css` — phone shell, drawer, banner, keybar, safe-area, and narrow/landscape layout.
- `src/phone.html` — React mount only; preserve CSP and PWA metadata.
- `webpack.mobile.config.js` — `.tsx` entry/resolution and cache hashing for nested component files.

### Tests and acceptance

- `tests/shared/sessionNavigator/*.test.tsx` — model and shared presentation contracts.
- `electron/remote/__tests__/navigationSource.test.ts` — persisted metadata validation and PTY filtering.
- `electron/__tests__/mobileRemoteServer.test.ts` — compatibility and loopback broadcast ordering.
- `electron/remote/__tests__/mobileRemoteController.test.ts` — encrypted post-auth navigation send.
- `tests/mobile/phoneApp.test.ts` — terminal reducer compatibility.
- `tests/mobile/mobileRemoteStore.test.ts` — phone selection and reconnect transitions.
- `tests/mobile/PhoneShell.test.tsx` — drawer, banners, empty/exited states, and input gating.
- `tests/mobile/TerminalKeyBar.test.tsx` — key controls and sticky Ctrl.
- `tests/mobile/MobileTerminal.test.tsx` — xterm lifecycle and viewport/resize behavior.
- `tests/mobile/relayClient.test.ts` — terminal retry/manual retry and authentication stop conditions.
- `scripts/harness-e2e-mobile-remote-relay.mjs` — grouped navigation, switching, interrupt, orientation, reconnect, and re-pair proof.
- `scripts/harness-e2e-mobile-remote-visual.mjs` — portrait, landscape, and narrow-desktop screenshots for review artifacts.
- `scripts/run-all-e2e.mjs` — include the focused visual harness without weakening existing probes.

---

### Task 1: Canonical Navigation Model and Shared Wire Contracts

**Files:**
- Create: `src/shared/sessionNavigator/types.ts`
- Create: `src/shared/sessionNavigator/buildModel.ts`
- Create: `src/shared/sessionNavigator/index.ts`
- Create: `tests/shared/sessionNavigator/buildModel.test.ts`
- Modify: `src/shared/mobileRemote/protocol.ts`
- Modify: `src/shared/mobileRemote/index.ts`
- Modify: `src/mobile/phoneApp.ts`
- Modify: `electron/remote/remoteMessages.ts`

**Interfaces:**
- Produces:
  - `SESSION_NAVIGATOR_MESSAGE_VERSION = 1`
  - `SessionNavigatorState = 'active' | 'idle' | 'waiting' | 'exited'`
  - `SessionNavigatorModel`
  - `NavigationMetadataSnapshot`
  - `buildSessionNavigatorModel(snapshot, liveSessionIds)`
  - shared `SessionListEntry`, `MobileClientMessage`, and `MobileServerMessage`
- Consumes no Electron or renderer store modules.

- [ ] **Step 1: Write the failing model and protocol tests**

```ts
import { describe, expect, it } from 'vitest';
import {
  buildSessionNavigatorModel,
  SESSION_NAVIGATOR_MESSAGE_VERSION,
} from '../../../src/shared/sessionNavigator';

describe('buildSessionNavigatorModel', () => {
  it('preserves group/session order and filters to normal groups with live PTYs', () => {
    const model = buildSessionNavigatorModel(
      {
        groups: [
          { id: 'g2', name: 'Second', collapsed: true, kind: 'normal' },
          { id: 'archive', name: 'Archive', collapsed: false, kind: 'archive' },
          { id: 'g1', name: 'First', collapsed: false, kind: 'normal' },
        ],
        sessions: [
          { id: 's2', name: 'Two', cwd: '/two', groupId: 'g2', state: 'waiting' },
          { id: 'dead', name: 'Dead', cwd: '/dead', groupId: 'g2', state: 'idle' },
          { id: 's1', name: 'One', cwd: '/one', groupId: 'g1', state: 'idle' },
        ],
        activeId: 's1',
      },
      new Set(['s1', 's2']),
    );

    expect(model).toEqual({
      groups: [
        {
          id: 'g2',
          name: 'Second',
          order: 0,
          collapsed: true,
          sessions: [{ id: 's2', name: 'Two', cwd: '/two', state: 'waiting', order: 0 }],
        },
        {
          id: 'g1',
          name: 'First',
          order: 2,
          collapsed: false,
          sessions: [{ id: 's1', name: 'One', cwd: '/one', state: 'active', order: 2 }],
        },
      ],
      activeSessionId: 's1',
    });
    expect(SESSION_NAVIGATOR_MESSAGE_VERSION).toBe(1);
  });

  it('drops malformed metadata and clears a non-live active id', () => {
    expect(
      buildSessionNavigatorModel(
        {
          groups: [{ id: 'g', name: 'Group', collapsed: false, kind: 'normal' }],
          sessions: [
            { id: 's', name: '', cwd: '/ok', groupId: 'g', state: 'idle' },
            { id: 'gone', name: 'Gone', cwd: '/gone', groupId: 'g', state: 'waiting' },
          ],
          activeId: 'gone',
        },
        new Set(['s']),
      ),
    ).toEqual({
      groups: [{
        id: 'g',
        name: 'Group',
        order: 0,
        collapsed: false,
        sessions: [{ id: 's', name: 's', cwd: '/ok', state: 'idle', order: 0 }],
      }],
      activeSessionId: null,
    });
  });
});
```

Add a compile-time use in `tests/mobile/phoneApp.test.ts`:

```ts
const navigatorMessage: MobileServerMessage = {
  type: 'sessions.navigator',
  version: 1,
  model: { groups: [], activeSessionId: null },
};
expect(applyServerMessage(emptyPhoneState(), navigatorMessage).navigator).toEqual(
  navigatorMessage.model,
);
```

- [ ] **Step 2: Run the focused tests and confirm missing-contract failures**

Run:

```powershell
npx vitest run --project renderer tests/shared/sessionNavigator/buildModel.test.ts tests/mobile/phoneApp.test.ts
```

Expected: FAIL because `src/shared/sessionNavigator` and the navigator message do not exist.

- [ ] **Step 3: Implement the exact browser-safe contracts**

```ts
export const SESSION_NAVIGATOR_MESSAGE_VERSION = 1 as const;

export type SessionNavigatorState = 'active' | 'idle' | 'waiting' | 'exited';

export type SessionNavigatorSession = {
  id: string;
  name: string;
  cwd: string;
  state: SessionNavigatorState;
  order: number;
};

export type SessionNavigatorGroup = {
  id: string;
  name: string;
  order: number;
  collapsed: boolean;
  sessions: SessionNavigatorSession[];
};

export type SessionNavigatorModel = {
  groups: SessionNavigatorGroup[];
  activeSessionId: string | null;
};

export type NavigationMetadataSnapshot = {
  groups: unknown;
  sessions: unknown;
  activeId: unknown;
};
```

Implement `buildSessionNavigatorModel` as a pure function that:

```ts
export function buildSessionNavigatorModel(
  snapshot: NavigationMetadataSnapshot,
  liveSessionIds: ReadonlySet<string>,
): SessionNavigatorModel {
  const groups = Array.isArray(snapshot.groups) ? snapshot.groups : [];
  const sessions = Array.isArray(snapshot.sessions) ? snapshot.sessions : [];
  const activeId = typeof snapshot.activeId === 'string' && liveSessionIds.has(snapshot.activeId)
    ? snapshot.activeId
    : null;
  const validGroups = groups.flatMap((value, order) => {
    if (!isRecord(value) || value.kind !== 'normal') return [];
    if (typeof value.id !== 'string' || typeof value.name !== 'string') return [];
    return [{
      id: value.id,
      name: value.name || value.id,
      order,
      collapsed: value.collapsed === true,
      sessions: [],
    }];
  });
  const byGroup = new Map(validGroups.map((group) => [group.id, group]));
  sessions.forEach((value, order) => {
    if (!isRecord(value) || typeof value.id !== 'string' || !liveSessionIds.has(value.id)) return;
    if (typeof value.groupId !== 'string' || typeof value.cwd !== 'string') return;
    const group = byGroup.get(value.groupId);
    if (!group) return;
    group.sessions.push({
      id: value.id,
      name: typeof value.name === 'string' && value.name ? value.name : value.id,
      cwd: value.cwd,
      state: value.id === activeId ? 'active' : value.state === 'waiting' ? 'waiting' : 'idle',
      order,
    });
  });
  return {
    groups: validGroups.filter((group) => group.sessions.length > 0),
    activeSessionId: activeId,
  };
}
```

Move the duplicated terminal message types into `src/shared/mobileRemote/protocol.ts` and extend the server union:

```ts
export type MobileServerMessage =
  | { type: 'sessions.list'; sessions: SessionListEntry[] }
  | {
      type: 'sessions.navigator';
      version: typeof SESSION_NAVIGATOR_MESSAGE_VERSION;
      model: SessionNavigatorModel;
    }
  | SessionSnapshotMessage
  | { type: 'pty.data'; sid: string; seq: number; chunk: string }
  | { type: 'error'; message: string };
```

Import these shared unions from phone and Electron instead of maintaining copies. Preserve all existing wire fields.

- [ ] **Step 4: Run the focused tests**

Run:

```powershell
npx vitest run --project renderer tests/shared/sessionNavigator/buildModel.test.ts tests/mobile/phoneApp.test.ts
npx vitest run --project electron electron/__tests__/mobileRemoteServer.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the shared contracts**

```powershell
git add src/shared/sessionNavigator src/shared/mobileRemote src/mobile/phoneApp.ts electron/remote/remoteMessages.ts tests/shared/sessionNavigator tests/mobile/phoneApp.test.ts
git commit -m "feat(remote): add shared navigation contracts" -m "Co-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 2: Electron Navigation Source and Encrypted Delivery

**Files:**
- Create: `electron/remote/navigationSource.ts`
- Create: `electron/remote/__tests__/navigationSource.test.ts`
- Modify: `electron/remote/remoteMessages.ts`
- Modify: `electron/remote/mobileRemoteController.ts`
- Modify: `electron/remote/mobileRemoteServer.ts`
- Modify: `electron/__tests__/mobileRemoteServer.test.ts`
- Modify: `electron/remote/__tests__/mobileRemoteController.test.ts`

**Interfaces:**
- Consumes:
  - `loadState('main'): string | null`
  - `listPtySessions(): Array<{ sid: string; cwd: string; cols: number; rows: number }>`
  - `buildSessionNavigatorModel(snapshot, liveSessionIds)`
- Produces:
  - `readRemoteNavigationModel(): SessionNavigatorModel`
  - `navigationSignature(model): string`
  - `sendSessionCatalog(peer): void`

- [ ] **Step 1: Write failing source, ordering, and malformed-metadata tests**

```ts
it('reads only live PTY metadata from the persisted main snapshot', () => {
  const model = readRemoteNavigationModel({
    loadState: () => JSON.stringify({
      version: 1,
      activeId: 's1',
      groups: [{ id: 'g1', name: 'Work', collapsed: false, kind: 'normal' }],
      sessions: [
        { id: 's1', name: 'Live', cwd: '/work', groupId: 'g1', state: 'idle' },
        { id: 's2', name: 'Closed', cwd: '/secret', groupId: 'g1', state: 'waiting' },
      ],
    }),
    listPtySessions: () => [{ sid: 's1', cwd: '/work', cols: 80, rows: 24 }],
  });
  expect(model.groups[0]?.sessions.map((session) => session.id)).toEqual(['s1']);
  expect(JSON.stringify(model)).not.toContain('/secret');
});

it.each([null, '', '{', '[]', '{"version":2}'])(
  'returns an empty model for malformed persisted state %j',
  (raw) => {
    expect(readRemoteNavigationModel({
      loadState: () => raw,
      listPtySessions: () => [{ sid: 's1', cwd: '/work', cols: 80, rows: 24 }],
    })).toEqual({ groups: [], activeSessionId: null });
  },
);
```

In controller tests, assert the first encrypted application messages after authentication are:

```ts
expect(sentApplicationMessages.slice(0, 2)).toEqual([
  { type: 'sessions.list', sessions: expect.any(Array) },
  {
    type: 'sessions.navigator',
    version: 1,
    model: expect.objectContaining({ groups: expect.any(Array) }),
  },
]);
```

- [ ] **Step 2: Run the focused Electron tests and confirm failures**

Run:

```powershell
npx vitest run --project electron electron/remote/__tests__/navigationSource.test.ts electron/remote/__tests__/mobileRemoteController.test.ts electron/__tests__/mobileRemoteServer.test.ts
```

Expected: FAIL because the source and navigator send path do not exist.

- [ ] **Step 3: Implement defensive metadata assembly**

```ts
type NavigationSourceDeps = {
  loadState: (key: string) => string | null;
  listPtySessions: () => Array<{ sid: string }>;
};

export function readRemoteNavigationModel(
  deps: NavigationSourceDeps = { loadState, listPtySessions },
): SessionNavigatorModel {
  const raw = deps.loadState('main');
  if (!raw) return { groups: [], activeSessionId: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { groups: [], activeSessionId: null };
  }
  if (!isRecord(parsed) || parsed.version !== 1) {
    return { groups: [], activeSessionId: null };
  }
  return buildSessionNavigatorModel(
    { groups: parsed.groups, sessions: parsed.sessions, activeId: parsed.activeId },
    new Set(deps.listPtySessions().map((session) => session.sid)),
  );
}

export function navigationSignature(model: SessionNavigatorModel): string {
  return JSON.stringify(model);
}
```

Keep malformed metadata explicit and empty; do not throw into the encrypted peer or return success-shaped fake sessions.

- [ ] **Step 4: Send a compatibility catalog after auth and on catalog changes**

```ts
export function sendSessionCatalog(peer: Pick<RemotePeer, 'send'>): void {
  peer.send({ type: 'sessions.list', sessions: listEntries() });
  peer.send({
    type: 'sessions.navigator',
    version: SESSION_NAVIGATOR_MESSAGE_VERSION,
    model: readRemoteNavigationModel(),
  });
}
```

Use `sendSessionCatalog` in:

1. encrypted controller `onAuthenticated`;
2. loopback server upgrade after `auth.ok`;
3. `sessions.list` request handling;
4. the two-second loopback poll when either legacy or navigator signature changes.

The Cloudflare relay remains opaque and unchanged; navigator JSON is sealed by `EncryptedPeer` before relay transit.

- [ ] **Step 5: Run focused Electron and Cloudflare regression tests**

Run:

```powershell
npx vitest run --project electron electron/remote/__tests__/navigationSource.test.ts electron/remote/__tests__/mobileRemoteController.test.ts electron/__tests__/mobileRemoteServer.test.ts electron/remote/__tests__/mobileRemoteCrypto.test.ts
npm run test:cloudflare
```

Expected: PASS, including existing authentication and frame-forwarding tests.

- [ ] **Step 6: Commit the Electron adapter**

```powershell
git add electron/remote/navigationSource.ts electron/remote/remoteMessages.ts electron/remote/mobileRemoteController.ts electron/remote/mobileRemoteServer.ts electron/remote/__tests__/navigationSource.test.ts electron/remote/__tests__/mobileRemoteController.test.ts electron/__tests__/mobileRemoteServer.test.ts
git commit -m "feat(remote): send encrypted grouped navigation" -m "Co-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 3: Shared Tokens, State Glyphs, and Navigator Presentation

**Files:**
- Create: `src/shared/sessionNavigator/sessionNavigator.css`
- Create: `src/shared/sessionNavigator/SessionStateGlyph.tsx`
- Create: `src/shared/sessionNavigator/SessionNavigatorItem.tsx`
- Create: `src/shared/sessionNavigator/SessionGroupHeader.tsx`
- Create: `src/shared/sessionNavigator/SessionNavigator.tsx`
- Modify: `src/shared/sessionNavigator/index.ts`
- Create: `tests/shared/sessionNavigator/SessionStateGlyph.test.tsx`
- Create: `tests/shared/sessionNavigator/SessionNavigator.test.tsx`

**Interfaces:**
- Consumes: `SessionNavigatorModel` and callback props only.
- Produces:
  - `SessionStateGlyph({ state, label, size })`
  - `SessionNavigatorItem({ session, selected, onSelect, density })`
  - `SessionGroupHeader({ group, expanded, onToggle })`
  - `SessionNavigator({ model, collapsedGroups, onToggleGroup, onSelectSession })`

- [ ] **Step 1: Write failing accessible presentation tests**

```tsx
it.each([
  ['active', 'Active'],
  ['idle', 'Idle'],
  ['waiting', 'Waiting'],
  ['exited', 'Exited'],
] as const)('renders %s with shape and text semantics', (state, label) => {
  render(<SessionStateGlyph state={state} label={label} />);
  expect(screen.getByRole('img', { name: label })).toHaveAttribute('data-state', state);
});

it('renders ordered groups, cwd text, selected state, and disclosure state', async () => {
  const user = userEvent.setup();
  const onSelectSession = vi.fn();
  const onToggleGroup = vi.fn();
  render(
    <SessionNavigator
      model={model}
      collapsedGroups={new Set(['g2'])}
      onSelectSession={onSelectSession}
      onToggleGroup={onToggleGroup}
    />,
  );
  expect(screen.getByRole('option', { name: /One.*\/one/ })).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByRole('button', { name: /Second/ })).toHaveAttribute('aria-expanded', 'false');
  await user.click(screen.getByRole('option', { name: /Two/ }));
  expect(onSelectSession).toHaveBeenCalledWith('s2');
});
```

- [ ] **Step 2: Run shared component tests and confirm failures**

Run:

```powershell
npx vitest run --project renderer tests/shared/sessionNavigator/SessionStateGlyph.test.tsx tests/shared/sessionNavigator/SessionNavigator.test.tsx
```

Expected: FAIL because the components do not exist.

- [ ] **Step 3: Implement semantic tokens and glyph vocabulary**

Define shared CSS variables with existing desktop values as fallbacks:

```css
:root {
  --ccsm-app: var(--color-bg-app, #0b1020);
  --ccsm-sidebar: var(--color-bg-sidebar, #111827);
  --ccsm-active-row: var(--color-bg-active, rgba(255, 255, 255, 0.09));
  --ccsm-border: var(--color-border-subtle, rgba(255, 255, 255, 0.1));
  --ccsm-fg: var(--color-fg-primary, #f3f4f6);
  --ccsm-muted: var(--color-fg-secondary, #9ca3af);
  --ccsm-success: var(--color-state-success, #86efac);
  --ccsm-warning: var(--color-state-waiting, #fbbf24);
  --ccsm-error: var(--color-state-error, #fca5a5);
  --ccsm-focus: var(--color-accent, #60a5fa);
}
```

Use four distinct SVG shapes plus visible labels in the accessible name:

```tsx
const PATHS: Record<SessionNavigatorState, React.ReactNode> = {
  active: <circle cx="6" cy="6" r="4" fill="currentColor" />,
  idle: <circle cx="6" cy="6" r="3.5" fill="none" stroke="currentColor" />,
  waiting: <rect x="2.5" y="2.5" width="7" height="7" rx="1" transform="rotate(45 6 6)" fill="currentColor" />,
  exited: <path d="M3 3l6 6M9 3L3 9" stroke="currentColor" strokeWidth="1.6" />,
};
```

- [ ] **Step 4: Implement pure shared group and row composition**

Requirements encoded in the implementation:

- Sort by numeric `order` without mutating the model.
- Render session names and cwd separately with truncation titles.
- Set `role="listbox"`, `role="option"`, `aria-selected`, and `aria-expanded`.
- Use `min-height: 44px` for `density="touch"` and existing 36px desktop density.
- Accept id-passing callbacks to retain stable references.
- Import no platform store or transport.

- [ ] **Step 5: Run shared presentation tests and boundary grep**

Run:

```powershell
npx vitest run --project renderer tests/shared/sessionNavigator/SessionStateGlyph.test.tsx tests/shared/sessionNavigator/SessionNavigator.test.tsx
rg "electron|stores/store|@dnd-kit|ContextMenu|WindowControls" src/shared/sessionNavigator
```

Expected: tests PASS; `rg` returns no matches.

- [ ] **Step 6: Commit shared presentation**

```powershell
git add src/shared/sessionNavigator tests/shared/sessionNavigator
git commit -m "feat(ui): add shared session navigator presentation" -m "Co-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 4: Desktop Sidebar Adapter Without Behavior Regression

**Files:**
- Create: `src/components/sidebar/DesktopSessionPresentation.tsx`
- Modify: `src/components/sidebar/SessionRow.tsx`
- Modify: `src/components/sidebar/GroupRow.tsx`
- Modify: `src/components/Sidebar.tsx`
- Modify: `src/components/ui/StateGlyph.tsx`
- Modify: `tests/sidebar/SessionRow.test.tsx`
- Modify: `tests/sidebar/SessionRow.context-menu.test.tsx`
- Modify: `tests/sidebar/GroupRow.test.tsx`
- Modify: `tests/sidebar/session-row-dot-selection.test.tsx`
- Modify: `tests/components/StateGlyph.test.tsx`

**Interfaces:**
- Consumes shared `SessionNavigatorItem`, `SessionGroupHeader`, and `SessionStateGlyph`.
- Keeps all existing `SessionRow` and `GroupRow` public props unchanged.
- Produces `toDesktopNavigatorSession(session, active, crashed)` for deterministic presentation mapping.

- [ ] **Step 1: Add failing desktop regression assertions**

Add assertions that:

```tsx
expect(screen.getByRole('option', { name: /Session A.*C:\\work/ })).toHaveAttribute(
  'aria-selected',
  'true',
);
expect(screen.getByRole('img', { name: /active/i })).toHaveAttribute('data-state', 'active');
expect(screen.getByRole('button', { name: /Group A/ })).toHaveAttribute('aria-expanded', 'true');
```

Retain existing tests for:

- `useSortable` listeners and composed refs;
- right-click selection and Radix focus restoration;
- F2/double-click rename;
- move/archive/reload/delete actions;
- hover-to-expand after 400 ms;
- listbox arrow/Home/End navigation;
- memoization and active-row selection dot.

- [ ] **Step 2: Run the sidebar regression set and confirm new assertions fail**

Run:

```powershell
npx vitest run --project renderer tests/sidebar/SessionRow.test.tsx tests/sidebar/SessionRow.context-menu.test.tsx tests/sidebar/GroupRow.test.tsx tests/sidebar/session-row-dot-selection.test.tsx tests/components/StateGlyph.test.tsx
```

Expected: existing assertions PASS and new shared-presentation assertions FAIL.

- [ ] **Step 3: Wrap shared presentation inside the existing desktop behavior**

`DesktopSessionPresentation` maps:

```ts
export function toDesktopNavigatorSession(
  session: Session,
  active: boolean,
  crashed: boolean,
): SessionNavigatorSession {
  return {
    id: session.id,
    name: session.name,
    cwd: session.cwd,
    order: 0,
    state: crashed ? 'exited' : active ? 'active' : session.state,
  };
}
```

Keep `SessionRow` as the owner of:

- `useSortable`, transforms, listeners, and archived disablement;
- context menu and mutations;
- rename input;
- selected-row scroll;
- flashing/crash store subscriptions.

Move only the row body typography, selection accent, cwd, and state glyph into `SessionNavigatorItem`. Keep `GroupRow` as owner of droppable timers, rename, menus, confirmation, sortable context, and keyboard navigation while `SessionGroupHeader` renders the header body.

- [ ] **Step 4: Keep the waiting-only StateGlyph API compatible**

Delegate its SVG to:

```tsx
return (
  <SessionStateGlyph
    state="waiting"
    label="waiting"
    size={size}
    decorative={decorative}
    className={className}
  />
);
```

Do not change Toast call sites.

- [ ] **Step 5: Run all sidebar and shared navigation tests**

Run:

```powershell
npx vitest run --project renderer tests/sidebar tests/components/StateGlyph.test.tsx tests/shared/sessionNavigator
```

Expected: PASS.

- [ ] **Step 6: Commit the desktop adapter**

```powershell
git add src/components/sidebar src/components/Sidebar.tsx src/components/ui/StateGlyph.tsx tests/sidebar tests/components/StateGlyph.test.tsx
git commit -m "refactor(ui): share desktop navigation presentation" -m "Co-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 5: Phone Reducer, Navigation Selection, and Reconnect State Machine

**Files:**
- Create: `src/mobile/mobileRemoteStore.ts`
- Create: `tests/mobile/mobileRemoteStore.test.ts`
- Modify: `src/mobile/phoneApp.ts`
- Modify: `tests/mobile/phoneApp.test.ts`
- Modify: `src/mobile/relayClient.ts`
- Modify: `tests/mobile/relayClient.test.ts`

**Interfaces:**
- Consumes shared wire messages and `SessionNavigatorModel`.
- Produces:
  - `MobileRemoteViewState`
  - `applyMobileEvent(state, event)`
  - `resolveReconnectSelection(model, currentSessionId)`
  - `RelayClient.retry()`
  - explicit UI states for connecting, authenticating, reconnecting, desktop unavailable/paused, pairing failure, update required, empty, selected exited, and terminal relay error.

- [ ] **Step 1: Write failing reducer transition tests**

```ts
it('retains a live selection across reconnect and requests navigator before snapshot', () => {
  const state = connectedState({ selectedSessionId: 's2' });
  const reconnecting = applyMobileEvent(state, { type: 'connection', status: 'reconnecting' });
  expect(reconnecting.inputEnabled).toBe(false);
  expect(reconnecting.terminalFrames).toEqual(state.terminalFrames);

  const replaced = applyMobileEvent(reconnecting, {
    type: 'server',
    message: navigatorMessage(['s1', 's2']),
  });
  expect(replaced.selectedSessionId).toBe('s2');
  expect(replaced.pendingCommands).toEqual([{ type: 'session.snapshot', sid: 's2' }]);
});

it('falls back to the first live session and marks a removed selection exited', () => {
  const replaced = applyMobileEvent(connectedState({ selectedSessionId: 'gone' }), {
    type: 'server',
    message: navigatorMessage(['s1']),
  });
  expect(replaced.selectedSessionId).toBe('s1');
  expect(replaced.exitedSessionId).toBe('gone');
});

it('stops automatic retry for pairing and protocol failures', () => {
  expect(applyMobileEvent(emptyMobileState(), {
    type: 'connection',
    status: 'authentication_failed',
  }).retryMode).toBe('blocked');
  expect(applyMobileEvent(emptyMobileState(), {
    type: 'connection',
    status: 'update_required',
  }).retryMode).toBe('blocked');
});
```

- [ ] **Step 2: Run phone state tests and confirm failures**

Run:

```powershell
npx vitest run --project renderer tests/mobile/phoneApp.test.ts tests/mobile/mobileRemoteStore.test.ts tests/mobile/relayClient.test.ts
```

Expected: FAIL because the reducer and manual retry API do not exist.

- [ ] **Step 3: Implement a pure reducer and thin Zustand store**

The state keeps the last terminal frame during connection changes:

```ts
export type MobileRemoteViewState = {
  navigator: SessionNavigatorModel;
  selectedSessionId: string | null;
  exitedSessionId: string | null;
  connection: PhoneConnectionStatus;
  inputEnabled: boolean;
  retryMode: 'automatic' | 'manual' | 'blocked';
  drawerOpen: boolean;
  ctrlSticky: boolean;
  snapshotSequence: number;
  terminalReset: boolean;
  terminalWrites: string[];
  pendingCommands: MobileClientMessage[];
};
```

Rules:

1. Connection loss changes banners and disables input without clearing `terminalWrites` or xterm.
2. A navigator replacement retains a still-live selection; otherwise it chooses the first session in group/session order.
3. A new or restored selection queues exactly one `session.snapshot`.
4. Input becomes enabled only after the authoritative snapshot for the selected sid.
5. `authentication_failed` and `update_required` block automatic retry.
6. Repeated transport failures eventually enter manual retry while preserving the relay client's bounded recovery queue.
7. `Retry` resets backoff/failure count through `RelayClient.retry()` and reconnects.

- [ ] **Step 4: Preserve relay safety while adding manual retry**

Extend `RelayClient` with:

```ts
retry(): void;
```

Keep `session.input` outside the recovery queue. Keep `sessions.list`, `session.snapshot`, and `session.resize` deduplicated and capped at 32. Reset the failure counter only after authenticated proof; never convert authentication/version failures into retries.

- [ ] **Step 5: Run reducer, relay, crypto, and phone tests**

Run:

```powershell
npx vitest run --project renderer tests/mobile/phoneApp.test.ts tests/mobile/mobileRemoteStore.test.ts tests/mobile/relayClient.test.ts tests/mobile/mobileRemoteCrypto.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit phone state transitions**

```powershell
git add src/mobile/phoneApp.ts src/mobile/mobileRemoteStore.ts src/mobile/relayClient.ts tests/mobile/phoneApp.test.ts tests/mobile/mobileRemoteStore.test.ts tests/mobile/relayClient.test.ts
git commit -m "feat(mobile): add remote navigation state machine" -m "Co-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 6: React Phone Shell, Touch Drawer, Terminal Chrome, and Key Bar

**Files:**
- Create: `src/mobile/components/PhoneShell.tsx`
- Create: `src/mobile/components/SessionDrawer.tsx`
- Create: `src/mobile/components/MobileTerminal.tsx`
- Create: `src/mobile/components/TerminalKeyBar.tsx`
- Create: `tests/mobile/PhoneShell.test.tsx`
- Create: `tests/mobile/SessionDrawer.test.tsx`
- Create: `tests/mobile/MobileTerminal.test.tsx`
- Create: `tests/mobile/TerminalKeyBar.test.tsx`
- Create: `src/mobile/index.tsx`
- Delete: `src/mobile/index.ts`
- Delete: `src/mobile/phonePage.ts`
- Modify: `src/mobile/mobile.css`
- Modify: `src/phone.html`
- Modify: `webpack.mobile.config.js`

**Interfaces:**
- Consumes the phone store, `RelayClient`, shared navigator, and xterm.
- Produces touch-first React presentation while retaining pairing bootstrap, service worker, CSP, viewport, orientation, focus, fit, and resize behavior.

- [ ] **Step 1: Write failing component tests**

Drawer:

```tsx
it('traps focus and closes on Escape, backdrop, and session selection', async () => {
  const user = userEvent.setup();
  render(<SessionDrawer open model={model} onClose={onClose} onSelectSession={onSelect} />);
  await user.keyboard('{Escape}');
  expect(onClose).toHaveBeenCalled();
  await user.click(screen.getByTestId('session-drawer-backdrop'));
  expect(onClose).toHaveBeenCalledTimes(2);
});
```

Key bar:

```tsx
it('provides every required 44px key and one-shot sticky Ctrl', async () => {
  const user = userEvent.setup();
  render(<TerminalKeyBar enabled onInput={onInput} />);
  for (const label of ['Esc', 'Tab', 'Ctrl', '↑', '↓', '←', '→', '^C', 'Enter']) {
    expect(screen.getByRole('button', { name: label })).toHaveClass('terminal-key');
  }
  await user.click(screen.getByRole('button', { name: 'Ctrl' }));
  await user.keyboard('a');
  expect(onInput).toHaveBeenCalledWith('\x01');
});
```

Shell:

```tsx
it('shows active session context and a non-modal reconnect banner without clearing terminal', () => {
  render(<PhoneShell client={client} initialState={reconnectingState} />);
  expect(screen.getByRole('banner')).toHaveTextContent('Session One');
  expect(screen.getByRole('status')).toHaveTextContent('Reconnecting');
  expect(screen.getByLabelText('Terminal')).toBeInTheDocument();
});
```

- [ ] **Step 2: Run component tests and confirm missing-component failures**

Run:

```powershell
npx vitest run --project renderer tests/mobile/PhoneShell.test.tsx tests/mobile/SessionDrawer.test.tsx tests/mobile/MobileTerminal.test.tsx tests/mobile/TerminalKeyBar.test.tsx
```

Expected: FAIL because the React shell does not exist.

- [ ] **Step 3: Implement the top bar and drawer**

Phone shell structure:

```tsx
<div className="phone-shell">
  <PhoneTopBar
    onOpenDrawer={() => dispatch({ type: 'drawer', open: true })}
    session={selectedSession}
    group={selectedGroup}
    connection={state.connection}
  />
  <ConnectionBanner state={state} onRetry={client.retry} />
  <SessionDrawer
    open={state.drawerOpen}
    model={state.navigator}
    onClose={() => dispatch({ type: 'drawer', open: false })}
    onSelectSession={selectAndClose}
  />
  <MobileTerminal enabled={state.inputEnabled} {...terminalProps} />
  <TerminalKeyBar enabled={state.inputEnabled} onInput={sendInput} />
</div>
```

Drawer requirements:

- temporary left drawer in portrait and landscape;
- no pinned tablet layout;
- body scroll lock while open;
- focus the first interactive element on open;
- cycle Tab/Shift+Tab inside the drawer;
- restore focus to the menu button on close;
- close on Escape, backdrop pointer action, and selection.

- [ ] **Step 4: Implement xterm lifecycle without resetting on disconnect**

Move the proven logic from `phonePage.ts` into effects:

- instantiate one `Terminal` and `FitAddon`;
- dispose both exactly once;
- write reducer chunks and reset only on authoritative snapshots/session changes;
- subscribe to `terminal.onData`;
- gate on `enabled` and selected sid;
- keep `visualViewport` resize/scroll plus window resize/orientation listeners;
- debounce fit at 120 ms and orientation follow-up at 250 ms;
- suppress duplicate resize messages;
- focus on terminal click/touch;
- retain 5000-line scrollback and current font defaults.

- [ ] **Step 5: Implement CSS tokens, touch sizes, safe areas, and connection states**

Required CSS:

```css
.phone-shell { height: var(--app-height, 100dvh); background: var(--ccsm-app); }
.terminal-key, .phone-menu-button, .session-navigator-item--touch {
  min-width: 44px;
  min-height: 44px;
}
.terminal-keybar {
  overflow-x: auto;
  padding-bottom: calc(8px + env(safe-area-inset-bottom));
}
.session-drawer { width: min(86vw, 360px); }
.connection-banner { position: absolute; inset-inline: 8px; top: calc(48px + env(safe-area-inset-top)); }
:focus-visible { outline: 2px solid var(--ccsm-focus); outline-offset: 2px; }
```

Render distinct text for all spec states and keep status represented by text plus shape.

- [ ] **Step 6: Switch mobile webpack/bootstrap to TSX safely**

Update:

```js
entry: { phone: './src/mobile/index.tsx', sw: './src/mobile/sw.ts' },
resolve: { extensions: ['.tsx', '.ts', '.js'] },
```

Update cache hashing to recursively include nested component files in deterministic path order. Keep service-worker and manifest output names unchanged.

- [ ] **Step 7: Run component, build, and PWA policy tests**

Run:

```powershell
npx vitest run --project renderer tests/mobile/PhoneShell.test.tsx tests/mobile/SessionDrawer.test.tsx tests/mobile/MobileTerminal.test.tsx tests/mobile/TerminalKeyBar.test.tsx tests/mobile/serviceWorkerPolicy.test.ts tests/mobile/pairing.test.ts
npm run build:mobile
```

Expected: PASS; `dist/mobile` contains the phone bundle, service worker, HTML, CSS, and manifest.

- [ ] **Step 8: Commit the React phone shell**

```powershell
git add src/mobile src/phone.html webpack.mobile.config.js tests/mobile
git commit -m "feat(mobile): build touch-first React remote shell" -m "Co-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 7: End-to-End Navigation, Reconnect, Orientation, and Visual Proof

**Files:**
- Modify: `scripts/harness-e2e-mobile-remote-relay.mjs`
- Create: `scripts/harness-e2e-mobile-remote-visual.mjs`
- Modify: `scripts/run-all-e2e.mjs`
- Modify: `docs/reference/e2e-runner.md`

**Interfaces:**
- Consumes built Electron/shared/mobile output and either local Wrangler or `CCSM_RELAY_URL`.
- Produces deterministic assertions for grouped navigation, switching, hard keys, reconnect ordering, pairing replacement, and three screenshot artifacts.

- [ ] **Step 1: Extend the simulated desktop to two groups and two sessions**

Send:

```js
const navigationModel = {
  groups: [
    {
      id: 'g-work',
      name: 'Work',
      order: 0,
      collapsed: false,
      sessions: [
        { id: 'mobile-e2e', name: 'Primary', cwd: 'C:\\work\\primary', state: 'active', order: 0 },
      ],
    },
    {
      id: 'g-ops',
      name: 'Ops',
      order: 1,
      collapsed: false,
      sessions: [
        { id: 'mobile-e2e-2', name: 'Secondary', cwd: 'C:\\work\\secondary', state: 'waiting', order: 1 },
      ],
    },
  ],
  activeSessionId: 'mobile-e2e',
};
```

Reply to `sessions.list` with both the compatibility list and:

```js
remotePeer.send({ type: 'sessions.navigator', version: 1, model: navigationModel });
```

Maintain separate snapshot sequence/data/input buffers per sid.

- [ ] **Step 2: Add focused Playwright assertions**

Assert:

1. pairing import in the initial tab and re-pairing in the same tab;
2. grouped drawer labels, names, cwd, state glyphs, and 44px targets;
3. selecting Secondary closes the drawer and loads its snapshot;
4. typing `/status` and Enter reaches Secondary;
5. sticky Ctrl plus `c` and the `^C` key each send `\x03`;
6. portrait to landscape viewport resize keeps terminal/keybar visible;
7. disconnect leaves the last frame visible, disables input, and shows reconnect state;
8. reconnect receives navigator before snapshot, retains Secondary when live, and deduplicates sequence;
9. removing Secondary selects Primary and exposes the exited-session message;
10. rotated pairing blocks retries until credentials are replaced in the existing tab.

- [ ] **Step 3: Add visual artifact capture**

The visual harness uses the same simulator and writes:

```text
artifacts/mobile-remote/portrait.png       390x844
artifacts/mobile-remote/landscape.png      844x390
artifacts/mobile-remote/narrow-desktop.png 640x800
```

It asserts the drawer, terminal, banner, and keybar bounding boxes remain within the viewport before each screenshot. Keep `artifacts/mobile-remote/` ignored so generated binaries do not enter git.

- [ ] **Step 4: Run focused local relay and visual E2E**

Run:

```powershell
npm run build
node scripts/harness-e2e-mobile-remote-relay.mjs
node scripts/harness-e2e-mobile-remote-visual.mjs
```

Expected:

```text
[mobile-remote-relay] PASS encrypted relay, navigation, switching, PTY, recovery, dedupe, orientation, rotation
[mobile-remote-visual] PASS portrait, landscape, narrow desktop
```

- [ ] **Step 5: Run the public relay E2E**

Run with the configured public URL:

```powershell
if (-not $env:CCSM_RELAY_URL) { throw 'CCSM_RELAY_URL must point to the deployed public relay' }
node scripts/harness-e2e-mobile-remote-relay.mjs
```

Expected: the same PASS line against the deployed Worker. Do not deploy, tag, or release from this task.

- [ ] **Step 6: Commit E2E coverage**

```powershell
git add scripts/harness-e2e-mobile-remote-relay.mjs scripts/harness-e2e-mobile-remote-visual.mjs scripts/run-all-e2e.mjs docs/reference/e2e-runner.md .gitignore
git commit -m "test(mobile): cover shared remote navigation flow" -m "Co-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 8: Full Gates, Review, and Pull Request

**Files:**
- Modify only files required by failures or important review findings.
- Do not modify `package.json` version, create tags, or create release metadata.

**Interfaces:**
- Produces a review-ready branch and PR with all required gates recorded.

- [ ] **Step 1: Run static and unit/integration gates**

Run:

```powershell
npm run typecheck
npm run lint
npm test
npm run test:cloudflare
```

Expected: all commands exit 0.

- [ ] **Step 2: Run production and Cloudflare build gates**

Run:

```powershell
npm run build
npm run cloudflare:dry-run
```

Expected: desktop and phone production bundles compile; Wrangler dry-run exits 0.

- [ ] **Step 3: Run the full E2E suite**

Run:

```powershell
npm run probe:e2e
```

Expected: every existing harness plus the mobile relay/visual harness passes.

- [ ] **Step 4: Confirm protocol, security, and release invariants**

Run:

```powershell
git diff main...HEAD -- package.json package-lock.json cloudflare/src/relayRoom.ts src/shared/mobileRemote/crypto.ts electron/ptyHost
git grep -nE "from ['\"].*(electron|stores/store)" -- src/shared/sessionNavigator
git status --short
```

Expected:

- package version remains `0.2.20`;
- no crypto/PTy/relay changes outside reviewed requirements;
- no forbidden shared imports;
- only intended source, tests, docs, and generated-plan changes are tracked.

- [ ] **Step 5: Request code review**

Invoke `requesting-code-review` and ask the reviewer to inspect:

- encrypted auth/reconnect ordering;
- malformed metadata filtering and data minimization;
- desktop DnD/context-menu/keyboard regression risk;
- xterm disposal, input gating, sequence dedupe, and resize races;
- drawer focus trap and 44px/safe-area accessibility;
- E2E coverage versus every spec acceptance item.

- [ ] **Step 6: Fix every important finding with focused tests**

For each high-confidence correctness, security, reliability, or accessibility finding:

1. add or update the smallest failing test;
2. run it and confirm failure;
3. make the focused fix;
4. rerun the focused test;
5. rerun the affected gate;
6. commit with the required co-author trailer.

- [ ] **Step 7: Re-run final verification after review fixes**

Run:

```powershell
npm run typecheck
npm run lint
npm test
npm run test:cloudflare
npm run build
npm run cloudflare:dry-run
npm run probe:e2e
```

Expected: all commands exit 0.

- [ ] **Step 8: Push and create the PR**

```powershell
git push -u origin HEAD
```

Create a PR titled:

```text
feat(mobile): share remote navigation UI across desktop and phone
```

The body must summarize architecture, encrypted metadata expansion, desktop preservation, phone UX/reconnect behavior, and the exact gates run. It must state that version remains `0.2.20` and no release/tag was created.

- [ ] **Step 9: Report completion to the parent session**

Send the parent session:

- PR title and link;
- focused commit list;
- validation commands and outcomes;
- public relay E2E result;
- any physical-phone acceptance that remains a release gate outside this implementation PR.
