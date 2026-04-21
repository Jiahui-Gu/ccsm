// Shared probe helpers. Pick the app renderer window (not DevTools) since
// dev mode opens DevTools detached and the order of windows is racy.
export async function appWindow(app, { timeout = 15000 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const w of app.windows()) {
      try {
        const url = w.url();
        if (url.startsWith('http://localhost') || url.startsWith('file://')) return w;
      } catch {}
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('appWindow: no renderer window appeared in time');
}
