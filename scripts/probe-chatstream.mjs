import { chromium } from 'playwright';

const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();

const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}\n${e.stack ?? ''}`));
page.on('requestfailed', (r) => logs.push(`[reqfail] ${r.url()} ${r.failure()?.errorText}`));

await page.goto('http://localhost:4100/', { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);

const result = await page.evaluate(async () => {
  const out = { steps: [], errors: [] };
  try {
    const useStore = window.__ccsmStore;
    if (!useStore) throw new Error('window.__ccsmStore missing — dev shim not loaded');
    out.steps.push('store reachable');

    useStore.getState().createSession('~/probe-cwd');
    const sid = useStore.getState().activeId;
    out.steps.push(`session created: ${sid}`);

    useStore.getState().appendBlocks(sid, [
      { kind: 'user', id: 'u1', text: 'How do I read a file with the SDK?' },
      {
        kind: 'assistant',
        id: 'a1',
        text:
          'Here is a markdown reply with a code block:\n\n```ts\nfunction add(a: number, b: number) {\n  return a + b;\n}\n```\n\nAnd a list:\n\n- one\n- two\n- three\n\nInline `code` and **bold** and a [link](https://example.com).'
      },
      {
        kind: 'tool',
        id: 't1',
        toolUseId: 'toolu_001',
        name: 'Read',
        brief: 'src/index.ts',
        expanded: false
      },
      {
        kind: 'tool',
        id: 't2',
        toolUseId: 'toolu_002',
        name: 'Bash',
        brief: 'npm test',
        expanded: false
      }
    ]);
    out.steps.push('appended 4 blocks (2 tools without result)');

    await new Promise((r) => setTimeout(r, 200));

    useStore.getState().setToolResult(sid, 'toolu_001', "import { foo } from './foo';\nconsole.log(foo());\n", false);
    useStore.getState().setToolResult(sid, 'toolu_002', 'PASS  src/foo.test.ts (12 tests)', false);
    out.steps.push('set tool results for both');

    await new Promise((r) => setTimeout(r, 300));

    const expandButtons = document.querySelectorAll('button[aria-expanded]');
    out.steps.push(`expand buttons found: ${expandButtons.length}`);
    // Tool blocks live inside the chatstream's scroll region, which is the
    // SECOND .flex-1.overflow-y-auto on the page (the first is the sidebar).
    const allScrollers = document.querySelectorAll('.flex-1.overflow-y-auto');
    const stream = allScrollers[allScrollers.length - 1] ?? null;
    const toolButtons = stream ? stream.querySelectorAll('button[aria-expanded]') : [];
    out.steps.push(`tool buttons inside stream: ${toolButtons.length}`);
    toolButtons.forEach((b) => b.click());
    await new Promise((r) => setTimeout(r, 300));

    out.streamHtml = stream ? stream.innerHTML : '<NO stream>';

    // Markdown sanity checks: do we actually have <pre>, <code>, <ul>, <strong>, <a>?
    out.checks = {
      streamFound: !!stream,
      hasPre: stream ? !!stream.querySelector('pre') : false,
      hasInlineCode: stream ? !!stream.querySelector('code') : false,
      hasUl: stream ? !!stream.querySelector('ul') : false,
      hasStrong: stream ? !!stream.querySelector('strong') : false,
      hasLink: stream ? !!stream.querySelector('a[href="https://example.com"]') : false,
      toolResultVisible: stream ? stream.innerHTML.includes('PASS  src/foo.test.ts') : false,
      readResultVisible: stream ? stream.innerHTML.includes("import { foo } from './foo';") : false,
      toolPlaceholderGone: stream ? !stream.innerHTML.includes('(no captured output yet)') : true
    };
  } catch (e) {
    out.errors.push(String(e?.stack ?? e));
  }
  return out;
});

console.log('=== STEPS ===');
for (const s of result.steps) console.log('  -', s);

if (result.errors.length) {
  console.log('=== ERRORS ===');
  for (const e of result.errors) console.log(e);
}

console.log('\n=== CHECKS ===');
console.log(JSON.stringify(result.checks, null, 2));

console.log('\n=== STREAM HTML (truncated) ===');
console.log((result.streamHtml ?? '(none)').slice(0, 3000));

console.log('\n=== CONSOLE / PAGE ERRORS ===');
for (const l of logs) console.log(l);

await browser.close();
