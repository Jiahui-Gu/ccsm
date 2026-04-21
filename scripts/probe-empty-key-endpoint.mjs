// E2E: the EndpointEditorDialog must accept endpoints with an empty API key.
//
// Flow: Settings (Cmd/Ctrl+,) -> Endpoints tab -> Add endpoint -> fill Name +
// Base URL, leave API key blank -> assert "Test connection" AND "Add" buttons
// are enabled, click Add, then assert the new endpoint appears in the list.
// Also asserts the "API key (optional)" label + optional hint are rendered.
//
// Run: `npm run build && node scripts/probe-empty-key-endpoint.mjs`
import { _electron as electron } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appWindow } from './probe-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function fail(msg) {
  console.error(`\n[probe-empty-key-endpoint] FAIL: ${msg}`);
  process.exit(1);
}

const app = await electron.launch({
  args: ['.'],
  cwd: root,
  env: {
    ...process.env,
    NODE_ENV: 'development',
    AGENTORY_DEV_PORT: process.env.AGENTORY_DEV_PORT || '4189',
  },
});

// Stub the endpoints IPC so this probe is hermetic: no real network, no real DB
// writes observable outside the process. We only care about the UI gating.
await app.evaluate(async () => {
  // nothing to do in main; renderer-side stubbing happens below.
});

const win = await appWindow(app);
const errors = [];
win.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
win.on('console', (m) => {
  if (m.type() === 'error') errors.push(`[console.error] ${m.text()}`);
});

await win.waitForLoadState('domcontentloaded');
await win.waitForTimeout(1500);

// Stub renderer-side `window.agentory.endpoints` so `add` + `refreshModels`
// succeed without hitting the main process / DB. testConnection also stubbed
// though the probe doesn't click it (we only assert the BUTTON is enabled).
await win.evaluate(() => {
  const store = [];
  const g = window;
  if (!g.agentory) g.agentory = {};
  g.agentory.endpoints = {
    ...(g.agentory.endpoints || {}),
    list: async () => store.slice(),
    add: async (input) => {
      const row = {
        id: `probe-${store.length + 1}`,
        name: input.name,
        baseUrl: input.baseUrl,
        kind: 'anthropic',
        isDefault: !!input.isDefault,
        lastStatus: 'unchecked',
        lastError: null,
        lastRefreshedAt: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      store.push(row);
      return row;
    },
    update: async () => null,
    remove: async () => true,
    refreshModels: async () => ({ ok: true, count: 0 }),
    testConnection: async () => ({ ok: true }),
    listModels: async () => [],
    listModelsAll: async () => store.map((e) => ({ ...e, models: [] })),
  };
});

// Open Settings by clicking the sidebar entry (keyboard shortcut requires
// specific focus state; sidebar click is deterministic).
const settingsEntry = win.getByRole('button', { name: /^settings$/i }).first();
await settingsEntry.waitFor({ state: 'visible', timeout: 5000 }).catch(async () => {
  await app.close();
  fail('Settings entry not found in sidebar');
});
await settingsEntry.click();
await win.waitForTimeout(400);

// Switch to the Endpoints tab.
const endpointsTab = win.getByRole('button', { name: /^endpoints$/i }).first();
await endpointsTab.waitFor({ state: 'visible', timeout: 5000 }).catch(async () => {
  const dump = await win.evaluate(() => document.body.innerText.slice(0, 800));
  console.error('--- body text ---\n' + dump);
  await app.close();
  fail('Endpoints tab not visible after opening Settings');
});
await endpointsTab.click();

// Click "Add endpoint" to open the editor.
const addBtn = win.getByRole('button', { name: /^add endpoint$/i }).first();
await addBtn.waitFor({ state: 'visible', timeout: 3000 });
await addBtn.click();

// The editor dialog mounts. Find inputs by order (Name, Base URL, API key).
const nameInput = win.locator('input[placeholder*="LiteLLM"]');
await nameInput.waitFor({ state: 'visible', timeout: 3000 }).catch(async () => {
  await app.close();
  fail('EndpointEditorDialog did not mount');
});
const baseUrlInput = win.locator('input[placeholder="https://api.anthropic.com"]');
await baseUrlInput.waitFor({ state: 'visible' });

await nameInput.fill('Local relay (no auth)');
await baseUrlInput.fill('http://127.0.0.1:4000');
// Intentionally leave API key blank.

// Assert the "(optional)" label + optional hint text are present.
const optionalLabel = win.getByText(/api key \(optional\)/i).first();
if (!(await optionalLabel.isVisible().catch(() => false))) {
  const dump = await win.evaluate(() => document.body.innerText);
  console.error('--- body text in editor ---\n' + dump);
  await app.close();
  fail('Expected "API key (optional)" label not visible');
}
const optionalHint = win.getByText(/leave blank if your endpoint does not require authentication/i).first();
if (!(await optionalHint.isVisible().catch(() => false))) {
  await app.close();
  fail('Expected optional-hint copy not visible under API key field');
}

// Assert Test connection button is ENABLED with empty key.
const testBtn = win.getByRole('button', { name: /test connection/i }).first();
await testBtn.waitFor({ state: 'visible' });
const testDisabled = await testBtn.isDisabled();
if (testDisabled) {
  await app.close();
  fail('"Test connection" button is disabled with empty key — gate not removed');
}

// Assert Add (save) button is ENABLED with empty key.
const saveBtn = win.getByRole('button', { name: /^add$/i }).first();
await saveBtn.waitFor({ state: 'visible' });
const saveDisabled = await saveBtn.isDisabled();
if (saveDisabled) {
  await app.close();
  fail('"Add" save button is disabled with empty key — gate not removed');
}

// Click Add and verify the row lands in the list without any error banner.
await saveBtn.click();
await win.waitForTimeout(800);

const listedRow = win.getByText(/local relay \(no auth\)/i).first();
if (!(await listedRow.isVisible().catch(() => false))) {
  const dump = await win.evaluate(() => document.body.innerText.slice(0, 1500));
  console.error('--- body text after save ---\n' + dump);
  console.error('--- recent errors ---\n' + errors.slice(-10).join('\n'));
  await app.close();
  fail('New empty-key endpoint did not appear in the list after save');
}

console.log('\n[probe-empty-key-endpoint] OK');
console.log('  label:  "API key (optional)" visible');
console.log('  hint:   optional-hint copy visible');
console.log('  test:   button enabled with empty key');
console.log('  save:   button enabled with empty key');
console.log('  list:   new endpoint rendered after save');

await app.close();
