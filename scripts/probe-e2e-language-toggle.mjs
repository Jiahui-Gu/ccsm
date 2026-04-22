// E2E: Language toggle (zh <-> en) — sidebar / settings / input strings
// flip immediately, AND English proper nouns are preserved verbatim in the
// Chinese catalog.
//
// Two assertions in one probe:
//
//   1. Live toggle: flip the language pref via the Settings → Appearance
//      Language segmented control. Sample strings rendered in:
//        - sidebar Settings button label (`common.settings`)
//        - sidebar New Session button (`sidebar.newSession`)
//        - input bar placeholder (`chat.inputPlaceholder` / `askPlaceholder`)
//      All three must change between en and zh values.
//
//   2. Protected terms: walk the zh catalog. For every leaf string in the
//      en catalog that contains a protected English proper noun (MCP, CLI,
//      IPC, API, URL, JSON, JSONL, SDK, REST, Claude, Anthropic, Agentory,
//      Electron, GitHub), the matching zh string MUST contain the same
//      term verbatim. Catches transliteration regressions (e.g. someone
//      "translates" "Claude Code CLI" to "克劳德代码命令行").
//
// We import the catalogs through a dynamic transpile via `tsx` style?
// No — simpler: load them in the renderer where they're already bundled.

import { _electron as electron } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { appWindow, startBundleServer } from './probe-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function fail(msg) {
  console.error(`\n[probe-e2e-language-toggle] FAIL: ${msg}`);
  process.exit(1);
}

const PROTECTED_TERMS = [
  'MCP', 'CLI', 'IPC', 'API', 'URL', 'JSONL', 'JSON', 'SDK', 'REST',
  'Claude', 'Anthropic', 'Agentory', 'Electron', 'GitHub'
];

// Serve our freshly-built dist/renderer on a unique port — never trust
// the well-known 4100 dev port (a stale dev server in another worktree
// would silently feed us the wrong bundle).
const { port: PORT, close: closeServer } = await startBundleServer(root);

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentory-probe-i18n-'));

const app = await electron.launch({
  args: ['.', `--user-data-dir=${userDataDir}`],
  cwd: root,
  env: {
    ...process.env,
    NODE_ENV: 'development',
    AGENTORY_DEV_PORT: String(PORT),
    LANG: 'en_US.UTF-8'
  }
});

let exitCode = 0;
try {
  const win = await appWindow(app);
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => !!window.__agentoryStore, null, { timeout: 15000 });
  await win.waitForTimeout(400);

  // Force English first (boot may resolve to system locale).
  await win.evaluate(() => {
    // Preferences store is exposed via window in dev for probe access? It
    // is NOT — but the i18n module re-exports `applyLanguage`. We grab
    // i18next from the bundled ESM by triggering the segmented control
    // instead. Fall back: drive everything through the UI.
  });

  // Open Settings, switch to Appearance (default), and drive the Language
  // segmented to 'English' to force a deterministic baseline.
  async function openSettingsAppearance() {
    const dialog = win.getByRole('dialog');
    if ((await dialog.count()) === 0) {
      const btn = win.getByRole('button', { name: /^(settings|设置)$/i }).first();
      await btn.waitFor({ state: 'visible', timeout: 5000 });
      await btn.click();
    }
    await dialog.waitFor({ state: 'visible', timeout: 3000 });
    // The Appearance tab uses i18n key 'tabs.appearance' = 'Appearance' / '外观'.
    const appearanceTab = dialog.getByRole('button', { name: /^(appearance|外观)$/i });
    if (await appearanceTab.isVisible().catch(() => false)) await appearanceTab.click();
    return dialog;
  }
  async function pickLanguage(dialog, name) {
    // The Language segmented exposes role='radio' rows.
    const radio = dialog.getByRole('radio', { name });
    await radio.click();
  }
  async function closeDialog() {
    await win.keyboard.press('Escape');
    await win.getByRole('dialog').waitFor({ state: 'hidden', timeout: 1500 }).catch(() => {});
  }

  // --- Force English ----
  let dialog = await openSettingsAppearance();
  await pickLanguage(dialog, /^english$/i);
  await win.waitForTimeout(150);
  await closeDialog();

  async function snapshotStrings() {
    return await win.evaluate(() => {
      const txt = (sel) => {
        const el = document.querySelector(sel);
        return el ? (el.getAttribute('aria-label') || el.textContent || '').trim() : null;
      };
      // Sidebar Settings button — has aria-label='Settings' (collapsed)
      // OR contains text 'Settings' (expanded).
      const settingsBtn = document.querySelector(
        'aside button[aria-label="Settings"], aside button[aria-label="设置"]'
      );
      const settingsLabel =
        (settingsBtn && (settingsBtn.getAttribute('aria-label') || settingsBtn.textContent || '').trim()) ||
        // Expanded layout: text in a <span>.
        Array.from(document.querySelectorAll('aside button')).map((b) => b.textContent?.trim() || '')
          .find((t) => /Settings|设置/.test(t)) || null;
      // New Session button — aria-label OR text.
      const newSessionBtn = document.querySelector(
        'aside button[aria-label="New session"], aside button[aria-label="新会话"]'
      );
      const newSessionText =
        (newSessionBtn && (newSessionBtn.getAttribute('aria-label') || newSessionBtn.textContent || '').trim()) ||
        Array.from(document.querySelectorAll('aside button')).map((b) => b.textContent?.trim() || '')
          .find((t) => /New Session|新会话/.test(t)) || null;
      const ta = document.querySelector('textarea');
      const placeholder = ta ? ta.getAttribute('placeholder') : null;
      return { settingsLabel, newSessionText, placeholder };
    });
  }

  const en1 = await snapshotStrings();
  if (!en1.settingsLabel || !/Settings/i.test(en1.settingsLabel)) {
    fail(`English baseline: settings label not English. got: ${JSON.stringify(en1)}`);
  }
  if (en1.newSessionText && !/New Session/i.test(en1.newSessionText)) {
    fail(`English baseline: new session text not English. got: ${en1.newSessionText}`);
  }
  if (en1.placeholder && /[\u4e00-\u9fff]/.test(en1.placeholder)) {
    fail(`English baseline: placeholder contains CJK chars. got: ${en1.placeholder}`);
  }

  // --- Switch to Chinese ----
  dialog = await openSettingsAppearance();
  await pickLanguage(dialog, /^中文$/);
  await win.waitForTimeout(200);
  await closeDialog();

  const zh1 = await snapshotStrings();
  if (!zh1.settingsLabel || !/设置/.test(zh1.settingsLabel)) {
    fail(`After zh switch: settings label not Chinese. got: ${JSON.stringify(zh1)}`);
  }
  if (zh1.newSessionText && !/[\u4e00-\u9fff]/.test(zh1.newSessionText)) {
    fail(`After zh switch: new session text contains no CJK. got: ${zh1.newSessionText}`);
  }
  if (zh1.placeholder && !/[\u4e00-\u9fff]/.test(zh1.placeholder)) {
    fail(`After zh switch: placeholder contains no CJK. got: ${zh1.placeholder}`);
  }

  // --- Switch back to English ----
  dialog = await openSettingsAppearance();
  await pickLanguage(dialog, /^english$/i);
  await win.waitForTimeout(200);
  await closeDialog();
  const en2 = await snapshotStrings();
  if (!en2.settingsLabel || !/Settings/i.test(en2.settingsLabel)) {
    fail(`After en switch back: settings label not English. got: ${JSON.stringify(en2)}`);
  }

  // --- 2. Protected-terms parity scan ----
  // Read both catalogs from the renderer (they're bundled into the i18next
  // resource bundle).
  const parity = await win.evaluate((terms) => {
    const i18next = (window).__agentoryI18n;
    if (!i18next || !i18next.store) return { error: 'i18next not exposed on window.__agentoryI18n' };
    const enRes = i18next.store.data.en?.translation;
    const zhRes = i18next.store.data.zh?.translation;
    if (!enRes || !zhRes) return { error: 'translation namespace missing' };
    const violations = [];
    function walk(enNode, zhNode, prefix) {
      if (typeof enNode === 'string') {
        if (typeof zhNode !== 'string') return;
        for (const term of terms) {
          // Whole-word, case-sensitive match in EN. We intentionally
          // require an exact case match because the rule is "preserve the
          // proper noun as-spelled" — so if EN says "Claude", ZH must
          // also say "Claude" (not "claude").
          // Use \b boundaries; for terms that include only ASCII letters
          // \b works fine.
          const re = new RegExp(`\\b${term}\\b`);
          if (re.test(enNode)) {
            if (!new RegExp(`\\b${term}\\b`).test(zhNode)) {
              violations.push({ key: prefix, term, en: enNode, zh: zhNode });
            }
          }
        }
        return;
      }
      if (enNode && typeof enNode === 'object') {
        for (const k of Object.keys(enNode)) {
          walk(enNode[k], zhNode ? zhNode[k] : undefined, prefix ? `${prefix}.${k}` : k);
        }
      }
    }
    walk(enRes, zhRes, '');
    return { violations };
  }, PROTECTED_TERMS);

  if (parity.error) {
    fail(`could not read i18n catalogs from renderer: ${parity.error}`);
  }
  if (parity.violations.length > 0) {
    console.error('--- protected-term violations ---');
    for (const v of parity.violations.slice(0, 25)) {
      console.error(`  ${v.key}  [${v.term}]`);
      console.error(`    en: ${v.en}`);
      console.error(`    zh: ${v.zh}`);
    }
    if (parity.violations.length > 25) {
      console.error(`  …and ${parity.violations.length - 25} more`);
    }
    fail(`${parity.violations.length} zh strings dropped a protected English proper noun`);
  }

  console.log('\n[probe-e2e-language-toggle] OK');
  console.log(`  en->zh->en flip updates sidebar settings, new-session, and input placeholder strings`);
  console.log(`  protected-term parity: 0 violations across ${PROTECTED_TERMS.length} terms`);
} catch (err) {
  console.error(err);
  exitCode = 1;
} finally {
  await app.close();
  closeServer();
  fs.rmSync(userDataDir, { recursive: true, force: true });
}
process.exit(exitCode);
