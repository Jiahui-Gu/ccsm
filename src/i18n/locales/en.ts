// English translation catalog — source of truth.
//
// Adding a key here? You MUST add the same key to `zh.ts`. The
// `tests/i18n-key-parity.test.ts` test fails CI if the two catalogs diverge.
//
// Note on typing: leaves are typed as `string`, NOT as the specific
// English literal. Otherwise `zh: EnCatalog` would refuse to assign
// non-English strings — making the type useless. Shape parity is
// enforced structurally, content parity by the runtime test.
type Leaf = string;
type Catalog<T> = { [K in keyof T]: T[K] extends object ? Catalog<T[K]> : Leaf };

const en = {
  common: {
    ok: 'OK',
    cancel: 'Cancel',
    save: 'Save',
    delete: 'Delete',
    rename: 'Rename',
    confirm: 'Confirm',
    close: 'Close',
    open: 'Open',
    apply: 'Apply',
    retry: 'Retry',
    back: 'Back',
    next: 'Next',
    finish: 'Finish',
    skip: 'Skip',
    yes: 'Yes',
    no: 'No',
    loading: 'Loading…',
    search: 'Search',
    settings: 'Settings',
    new: 'New',
    add: 'Add',
    remove: 'Remove',
    archive: 'Archive',
    unarchive: 'Unarchive',
    unknown: 'Unknown',
    dismiss: 'Dismiss',
    undo: 'Undo'
  },
  sidebar: {
    newSession: 'New session',
    newGroup: 'New group',
    newGroupEllipsis: 'New group…',
    groups: 'Groups',
    groupsEmptyHint: 'No groups yet — click + to create one',
    defaultGroupName: 'Sessions',
    archivedGroups: 'Archived groups',
    archiveGroup: 'Archive group',
    unarchiveGroup: 'Unarchive group',
    deleteGroupEllipsis: 'Delete group…',
    deleteGroup: 'Delete group',
    deleteGroupConfirmTitle: 'Delete "{{name}}"?',
    deleteGroupNonEmpty:
      'This group contains {{count}} session. They will be moved to Deleted.',
    deleteGroupNonEmpty_other:
      'This group contains {{count}} sessions. They will be moved to Deleted.',
    deleteGroupNonEmptyKept:
      'This group contains {{count}} session. They will be deleted with the group.',
    deleteGroupNonEmptyKept_other:
      'This group contains {{count}} sessions. They will be deleted with the group.',
    deleteGroupEmpty: 'This group is empty.',
    deleteSessionConfirmTitle: 'Delete "{{name}}"?',
    deleteSessionDescription: 'The session and its conversation history will be removed.',
    sessionDeletedToast: 'Deleted "{{name}}"',
    groupDeletedToast: 'Deleted group "{{name}}"',
    moveToGroup: 'Move to group',
    waitingForResponse: 'Waiting for response',
    openInChat: 'Open in chat',
    sessionCrashed: 'claude process crashed in this session',
    searchAria: 'Search',
    pickCwdTooltip: 'New session in a different folder',
    pickCwdAria: 'Pick working directory for new session',
    searchTooltip: 'Search  Ctrl+F',
    searchAriaShort: 'Search',
    importTooltip: 'Import session',
    importAriaShort: 'Import session',
    settingsTooltip: 'Settings  Ctrl+,',
    settingsAria: 'Settings',
    cwdMissingTooltip:
      'Working directory no longer exists: {{cwd}}. Open this session and repick the folder via the cwd button in the status bar.',
    resizerAriaLabel: 'Resize sidebar',
    resizerTooltip: 'Drag to resize · double-click to reset ({{default}}px)'
  },
  settings: {
    title: 'Settings',
    description: 'Configure appearance, notifications, and updates.',
    tabs: {
      general: 'General',
      appearance: 'Appearance',
      notifications: 'Notifications',
      updates: 'Updates'
    },
    theme: 'Theme',
    themeHint: 'System follows your OS preference (and reacts live when it changes).',
    themeOptions: {
      system: 'System',
      light: 'Light',
      dark: 'Dark'
    },
    fontSize: 'Font size',
    fontSizeHint: 'Applies to the whole app. Explicit small labels (meta, kbd) keep their intrinsic size.',
    fontSizeAriaLabel: 'Font size in pixels',
    fontSizeOptions: {
      sm: 'Small (12px)',
      md: 'Medium (13px, default)',
      lg: 'Large (14px)'
    },
    language: 'Language',
    languageHint: 'Choose the interface language. Changes apply immediately.',
    languageOptions: {
      system: 'System',
      en: 'English',
      zh: '中文'
    },
    closeBehavior: 'Close button behavior',
    closeBehaviorHint:
      'What clicking the window X (or pressing Ctrl+W) should do. Minimizing to tray keeps notifications and background sessions running.',
    closeBehaviorOptions: {
      ask: 'Ask every time',
      tray: 'Minimize to tray',
      quit: 'Quit'
    },
    version: 'Version',
    checkForUpdates: 'Check for updates',
    crashReporting: {
      label: 'Send crash reports to developer',
      description: 'Recommended. Helps fix bugs you hit. No personal data sent.'
    },
    notifications: {
      intro:
        'Show a desktop toast when a session finishes its turn or needs your input. Suppressed when the CCSM window is focused on that session — no need to ping yourself.',
      enable: 'Show desktop notifications when sessions need input',
      sound: 'Sound',
      soundHint: 'Play the OS default notification sound.'
    },
    updates: {
      version: 'Version',
      status: 'Status',
      automaticChecks: 'Automatic checks',
      automaticChecksHint:
        'When on, CCSM checks GitHub for updates on launch and every 4 hours.',
      automaticChecksToggle: 'Check for updates automatically',
      checking: 'Checking…',
      checkButton: 'Check for updates',
      downloadButton: 'Download {{version}}',
      installButton: 'Restart & install',
      statusIdle: 'No update check performed yet.',
      statusChecking: 'Checking for updates…',
      statusAvailable: 'Update available: {{version}}',
      statusNotAvailable: 'You are on the latest version.',
      statusDownloading: 'Downloading… {{percent}}% ({{transferred}} / {{total}})',
      statusDownloaded: 'Update {{version}} ready — restart to install.',
      statusError: 'Update check failed: {{message}}',
      // Strings for the persistent renderer toast surfaced by
      // App.tsx's UpdateDownloadedBridge when main pushes
      // `update:downloaded`. Lives under `settings:updates.*` for parity
      // with the rest of the updater copy even though the toast itself
      // is rendered outside the Settings dialog.
      downloadedToastTitle: 'Update downloaded — restart to apply',
      downloadedToastBody: 'Version {{version}} is ready.',
      downloadedToastAction: 'Restart'
    }
  },
  notifications: {
    sessionWaitingTitle: 'Waiting for you',
    sessionWaitingBody: '{{name}} needs your input',
    sessionDoneTitle: 'Waiting for you',
    sessionDoneBody: '{{name}} needs your input',
    permissionRequestTitle: 'Permission requested',
    permissionRequestBody: '{{name}} is asking to {{action}}',
    turnDoneTitle: '{{name}} is done',
    turnDoneBody: 'Turn done',
    turnErrorTitle: '{{name}} finished with an error',
    turnErrorBody: 'Turn ended in error - check the chat.',
    questionTitle: '{{name}} has a question',
    questionBody: 'Question',
    inputNeededTitle: '{{name}} needs your input',
    permissionBody: 'Permission',
    backgroundSessionFallback: 'Background session',
    backgroundWaitingToastTitle: '{{name}} needs your input'
  },
  installerCorrupt: {
    title: 'Claude binary missing from this install',
    body: 'CCSM ships the Claude binary inside the installer, but we couldn’t find it on disk. Please reinstall CCSM to repair the install — sessions can’t start until then.'
  },
  // Migration fatal-error modal (v0.3 design §6.8 surface registry,
  // priority 85; canonical copy + key namespace owned by frag-8 §8.6).
  // Sentence-case per feedback_no_uppercase_ui_strings; no
  // ERROR/FAILED/FATAL terms. Only action is "Quit ccsm" — manual
  // delete-and-relaunch (using the {{legacyDb}} / {{dataRoot}} paths
  // surfaced in the body) is the documented retry mechanism.
  migration: {
    modal: {
      failed: {
        title: 'ccsm couldn’t migrate your previous data',
        body: 'ccsm tried to move your data from the previous version but couldn’t complete the migration. Your previous data file at {{legacyDb}} is preserved unchanged — quit ccsm and contact support, or manually start fresh by deleting {{dataRoot}} and relaunching.',
        actionQuit: 'Quit ccsm'
      }
    }
  },
  importDialog: {
    title: 'Import sessions from Claude Code',
    description: 'Pick existing CLI transcripts to surface in CCSM. They resume on open.',
    scanning: 'Scanning…',
    noImportablePrefix: 'No importable transcripts found in',
    selectAll: 'Select all',
    deselectAll: 'Deselect all',
    selected: '{{count}} selected',
    selectGroup: 'Select group',
    deselectGroup: 'Deselect group',
    expand: 'Expand',
    collapse: 'Collapse',
    importing: 'Importing…',
    importN: 'Import {{count}}',
    cancel: 'Cancel'
  },
  commandPalette: {
    title: 'Command palette',
    searchPlaceholder: 'Search sessions, groups, commands…',
    escKey: 'Esc',
    noMatches: 'No matches',
    noResultsFor: 'No results for "{{query}}"',
    emptyHint: 'Type to search sessions, groups, commands…',
    groupHint: 'Group',
    cmdNewGroup: 'New group',
    cmdImport: 'Import from Claude Code…',
    cmdOpenSettings: 'Open settings',
    cmdSwitchTheme: 'Switch theme \u2192 {{next}}',
    hintNavigate: 'Navigate',
    hintSelect: 'Select',
    hintClose: 'Close'
  },
  toast: {
    dismiss: 'Dismiss'
  },
  fileTree: {
    noFiles: '(no files)',
    ariaLabel: 'File tree'
  },
  terminal: {
    waitingOutput: 'waiting for output…',
    noOutput: '(no output)',
    starting: 'Starting…',
    spawnFailed: 'Failed to start terminal',
    retryButton: 'Retry',
    exitedClean: 'claude exited (you typed /exit or claude returned). Click Retry to start a new conversation in this session.',
    exitedCrash: 'claude crashed ({{detail}}). This is not a ccsm bug — the underlying claude CLI exited unexpectedly. Your conversation is saved on disk; click Retry to resume.',
    exitedRetry: 'Retry'
  },
  chat: {
    cwdChipNoneLabel: '(none)',
  },
  statusBar: {
    workingDirectory: 'Working directory',
    model: 'Model',
    permissionMode: 'Permission mode',
    browseFolder: 'Browse folder…',
    loading: 'Loading…',
    noModelsHint: 'No models — run `claude /config` or edit ~/.claude/settings.json',
    pickModel: '(pick model)',
    defaultSuffix: ' (default)',
    modePlanLabel: 'Plan',
    modeDefaultLabel: 'Default',
    modeAcceptEditsLabel: 'Accept edits',
    modeBypassLabel: 'Bypass permissions',
    modeAutoLabel: 'Auto',
    modePlanDesc: 'Read-only analysis. No edits, no shell.',
    modeDefaultDesc: 'Auto-approve reads. Ask before edits and shell.',
    modeAcceptEditsDesc: 'Auto-approve reads and edits. Ask before shell.',
    modeBypassDesc: 'Auto-approve everything. Use with care.',
    modeAutoDesc: 'Classifier-driven approvals. Research preview, requires Sonnet 4.6+.',
    modePlanTooltip: 'Plan mode \u2014 read-only analysis; no file edits or shell until you approve.',
    modeDefaultTooltip: 'Default \u2014 auto-approve reads; ask before edits and shell.',
    modeAcceptEditsTooltip: 'Accept edits \u2014 auto-approve reads and file edits; ask before shell.',
    modeBypassTooltip: 'Bypass permissions \u2014 every tool call runs without asking. Use with care.',
    modeAutoTooltip: 'Auto \u2014 research preview, requires Sonnet 4.6+. Falls back to Default if your account or model is not eligible.',
    contextLabel: 'Context',
    // Mirrors the official VS Code Claude extension's auto-compact tooltip
    // wording so users who switch between surfaces see the same prompt.
    contextTooltip: '{{percent}}% used ({{used}} / {{limit}} tokens). Click to /compact.',
    contextAriaLabel: '{{percent}}% of context window used. Click to compact.',
    // 6-tier effort+thinking chip. Labels mirror the upstream CLI's effort
    // levels (low/medium/high/xhigh/max) plus an 'Off' tier that maps to
    // thinking=disabled. Default tier is High; Extra high/Max are
    // model-gated.
    effort: 'Effort',
    effortOffLabel: 'Off',
    effortLowLabel: 'Low',
    effortMediumLabel: 'Medium',
    effortHighLabel: 'High',
    effortXhighLabel: 'Extra high',
    effortMaxLabel: 'Max',
    effortOffDesc: 'No thinking. Fastest.',
    effortLowDesc: 'Quick takes. Adaptive thinking.',
    effortMediumDesc: 'Balanced reasoning.',
    effortHighDesc: 'Deeper thinking (default).',
    effortXhighDesc: 'Extended deliberation. Opus 4.7.',
    effortMaxDesc: 'Maximum effort. Opus 4.6/4.7.'
  },
  cwdPopover: {
    placeholder: 'Type to filter or paste a path…',
    recent: 'Recent',
    empty: 'No matching recent directories',
    browse: 'Browse folder…',
    cwdMissingShort: 'missing',
    cwdMissingTooltip: 'Working directory no longer exists: {{cwd}}. Pick a different folder before sending.'
  },
  window: {
    minimize: 'Minimize',
    maximize: 'Maximize',
    restore: 'Restore',
    close: 'Close'
  },
  shortcuts: {
    title: 'Keyboard shortcuts',
    description: 'Press Esc or click outside to close. Press ? to reopen.',
    openHint: 'Shortcuts',
    groupChat: 'Chat',
    groupSidebar: 'Sidebar & Sessions',
    groupNavigation: 'Navigation',
    actionSend: 'Send message',
    actionNewline: 'Insert newline',
    actionStop: 'Interrupt running turn',
    actionDismissPicker: 'Dismiss slash-command picker',
    actionNewGroup: 'New group',
    actionSearch: 'Open search / command palette',
    actionSettings: 'Open settings',
    actionShortcuts: 'Show this shortcuts overlay',
    colShortcut: 'Shortcut',
    colAction: 'Action'
  },
  // Right-pane affordance shown for the brief boot window between app
  // mount and `ccsmPty.checkClaudeAvailable()` resolving. Without this
  // line the pane would be entirely blank (bug #852 / task #900).
  claudeAvailability: {
    probing: 'Checking Claude CLI…'
  },
  // Shown full-screen at boot when the `claude` CLI is not on PATH.
  // ccsm requires the user to install the Claude CLI separately; this
  // page links them to the install command and lets them re-check
  // without restarting the app.
  claudeMissing: {
    title: 'Claude CLI not found',
    body: 'ccsm requires the Claude CLI to be installed separately. Install it via npm and re-check.',
    installCommandLabel: 'Install command',
    recheckButton: 'Re-check'
  }
} as const;

// EnCatalog widens leaves to `string` so non-English catalogs can satisfy
// the same shape. Structural parity (every nested key present) is checked
// at compile time; *content* parity (no missing translations) by the
// runtime parity test in `tests/`.
export type EnCatalog = Catalog<typeof en>;
export default en;
