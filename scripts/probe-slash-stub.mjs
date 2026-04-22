// Shared init-script for slash-command probes: install a complete
// window.agentory stub so renderer mounts cleanly (no tutorial overlay,
// no CLI-missing dialog), and let individual probes layer on overrides.
//
// Usage in a probe:
//   await page.addInitScript(slashStubInit, { extra });
// Then any function on the stub can be re-stubbed via `page.evaluate`.
export function makeSlashStubInit(extras = {}) {
  // Returns a string the page evaluates. We can't pass a closure to
  // addInitScript across the playwright bridge with non-serializable bits,
  // so we bake everything to JSON-safe primitives + reconstitute in-page.
  return `(${stubFn.toString()})(${JSON.stringify(extras)});`;
}

function stubFn(_extras) {
  const sentMessages = [];
  const externalUrls = [];
  const memoryOpenCalls = [];
  Object.defineProperty(window, '__sentMessages', { value: sentMessages, writable: true });
  Object.defineProperty(window, '__externalUrls', { value: externalUrls, writable: true });
  Object.defineProperty(window, '__memoryOpenCalls', { value: memoryOpenCalls, writable: true });
  Object.defineProperty(window, '__doctorOverride', { value: null, writable: true });
  Object.defineProperty(window, '__memoryOverride', { value: null, writable: true });
  Object.defineProperty(window, '__externalOverride', { value: null, writable: true });
  Object.defineProperty(window, '__getVersionOverride', { value: null, writable: true });

  const stub = {
    loadState: async (key) => {
      if (key === 'main') {
        return JSON.stringify({
          version: 1,
          sessions: [],
          groups: [{ id: 'g-default', name: 'Sessions', collapsed: false, kind: 'normal' }],
          activeId: '',
          model: '',
          permission: 'default',
          sidebarCollapsed: false,
          theme: 'system',
          fontSize: 'md',
          recentProjects: [],
          tutorialSeen: true
        });
      }
      return null;
    },
    saveState: async () => {},
    loadMessages: async () => [],
    saveMessages: async () => {},
    getVersion: async () => (window.__getVersionOverride ? window.__getVersionOverride() : '0.0.0-probe'),
    pickDirectory: async () => null,
    agentStart: async () => ({ ok: true }),
    agentSend: async (_id, text) => {
      sentMessages.push(text);
      return true;
    },
    agentSendContent: async () => true,
    agentInterrupt: async () => true,
    agentSetPermissionMode: async () => true,
    agentSetModel: async () => true,
    agentClose: async () => true,
    agentResolvePermission: async () => true,
    onAgentEvent: () => () => {},
    onAgentExit: () => () => {},
    onAgentPermissionRequest: () => () => {},
    scanImportable: async () => [],
    recentCwds: async () => [],
    topModel: async () => null,
    pathsExist: async () => ({}),
    memory: {
      read: async () => ({ ok: true, content: '', exists: false }),
      write: async () => ({ ok: true }),
      exists: async () => false,
      userPath: async () => '/tmp/CLAUDE.md',
      openUserFile: async () => {
        memoryOpenCalls.push(Date.now());
        return window.__memoryOverride ? window.__memoryOverride() : { ok: true };
      },
      projectPath: async () => null
    },
    doctor: {
      run: async () => {
        if (window.__doctorOverride) return window.__doctorOverride();
        return {
          checks: [
            { name: 'settings.json', ok: true, detail: '/x' },
            { name: 'claude binary', ok: true, detail: '/bin/claude' },
            { name: 'data dir writable', ok: true, detail: '/data' }
          ]
        };
      }
    },
    pr: {
      preflight: async () => ({ ok: false, errors: [{ code: 'no-gh', detail: 'stub' }] }),
      create: async () => ({ ok: false, error: 'stub' }),
      checks: async () => ({ ok: false, error: 'stub' })
    },
    notify: async () => true,
    onNotificationFocus: () => () => {},
    updatesStatus: async () => ({ kind: 'idle' }),
    updatesCheck: async () => ({ kind: 'idle' }),
    updatesDownload: async () => ({ ok: true }),
    updatesInstall: async () => ({ ok: true }),
    updatesGetAutoCheck: async () => true,
    updatesSetAutoCheck: async () => true,
    onUpdateStatus: () => () => {},
    onUpdateAvailable: () => () => {},
    onUpdateDownloaded: () => () => {},
    onUpdateError: () => () => {},
    cli: {
      retryDetect: async () => ({ found: true, path: '/fake/claude', version: '1.0.0' }),
      getInstallHints: async () => ({ os: 'win32', arch: 'x64', commands: { npm: '' }, docsUrl: '' }),
      browseBinary: async () => null,
      setBinaryPath: async () => ({ ok: true, version: '1.0.0' }),
      openDocs: async () => true
    },
    window: {
      minimize: async () => {},
      toggleMaximize: async () => false,
      close: async () => {},
      isMaximized: async () => false,
      onMaximizedChanged: () => () => {},
      platform: 'win32'
    },
    connection: {
      read: async () => ({ baseUrl: null, model: null, hasAuthToken: false }),
      openSettingsFile: async () => ({ ok: true })
    },
    models: {
      list: async () => []
    },
    openExternal: async (url) => {
      externalUrls.push(url);
      return window.__externalOverride ? window.__externalOverride(url) : true;
    },
    i18n: {
      getSystemLocale: async () => 'en-US',
      setLanguage: () => {}
    }
  };
  Object.defineProperty(window, 'agentory', { value: stub, writable: true, configurable: true });
}

export async function devServerUp(url) {
  try {
    const res = await fetch(url, { method: 'HEAD' });
    return res.ok || res.status === 200;
  } catch {
    return false;
  }
}
