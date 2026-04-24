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
  chat: {
    permissionRequested: 'Permission requested',
    allow: 'Allow',
    deny: 'Deny',
    expandTool: 'Expand tool output',
    collapseTool: 'Collapse tool output',
    noOutput: '(no captured output yet)',
    errorLabel: 'error',
    sendMessage: 'Send message',
    sendButton: 'Send',
    inputPlaceholder: 'Reply…',
    enterToSend: 'Enter send · Shift+Enter newline',
    escToStop: 'Esc to stop · Enter to queue',
    tokenUsage: '{{used}}k / {{total}}k tokens · {{percent}}% used',
    emptyTitle: 'No messages yet',
    emptySubtitle: 'Start typing to begin a conversation.',
    ready: 'Ready when you are.',
    jumpToLatest: 'Jump to latest',
    planTitle: 'Plan ready for review',
    planApprove: 'Approve plan',
    planReject: 'Reject',
    todoLabel: 'Todo',
    infoLabel: 'Info',
    warnLabel: 'Warn',
    toolFailedAria: 'tool failed',
    toolFailedTag: 'failed',
    runningEllipsis: '(running…)',
    toolNoResult: '(no result)',
    toolTakingLonger: '(taking longer than usual…)',
    toolStallEscalated: 'Tool has been running 90s+ — still no result.',
    toolStallCancel: 'Cancel',
    toolStallCancelAria: 'Cancel this stalled tool',
    runningPlaceholder: 'Running… (Esc to interrupt, Enter to queue)',
    askPlaceholder: 'Ask anything…',
    attachImage: 'Attach image',
    attachImageTitle: 'Attach image (also supports drag-drop & paste)',
    attachCapReached: 'Attachment cap reached ({{max}})',
    removeAttachment: 'Remove {{name}}',
    dropImageHint: 'Drop image to attach',
    attachmentFormatsHint: 'PNG · JPEG · GIF · WebP · up to {{size}}',
    stopBtn: 'Stop',
    stopAria: 'Stop',
    queueChip: '+{{count}} queued',
    queueButton: 'Queue',
    queueAria: 'Queue message',
    sendFailedToDeliver: 'Failed to deliver message to agent.',
    cwdMissing:
      'Working directory no longer exists: {{cwd}}. Pick a new folder using the cwd button in the status bar below, then send again.',
    diffAccept: 'Accept',
    diffReject: 'Reject',
    diffAccepted: 'accepted',
    diffRejected: 'rejected',
    permResolvedAllowed: 'Allowed',
    permResolvedDenied: 'Denied',
    inputBytes: 'input',
    expandStringChars: '+{{count}} chars',
    collapseString: 'collapse',
    longOutputCopy: 'Copy all',
    longOutputCopied: 'Copied',
    codeBlockCopy: 'Copy code',
    codeBlockCopied: 'Copied',
    longOutputSave: 'Save as .log',
    longOutputSaved: 'Saved',
    longOutputSaveFailed: 'Save failed',
    longOutputExpand: 'Expand',
    longOutputCollapse: 'Collapse',
    longOutputHidden: '── {{count}} lines hidden · click to expand ──',
    longOutputTooLargeExpand: 'Too large to expand inline · use Save as .log',
    longOutputTooLargeBadge: '{{size}} · {{lines}} lines',
    prOpening: 'opening…',
    prOpen: 'open',
    prPolling: 'CI running…',
    prDone: 'CI complete',
    prFailed: 'failed',
    prCheckRunning: 'running',
    prCheckPassed: 'passed',
    prCheckFailed: 'failed',
    prOpenDetailsAria: 'Open details for {{name}}',
    loadHistoryFailed: 'Failed to load history',
    retry: 'Retry'
  },
  chatStream: {
    emptyHint: 'Type a message and press'
  },
  sidebar: {
    newSession: 'New Session',
    newSessionInThisGroup: 'New session in this group',
    newGroup: 'New group',
    newGroupEllipsis: 'New group…',
    groups: 'Groups',
    groupsEmptyHint: 'No groups yet — click + to create one',
    defaultGroupName: 'Sessions',
    archivedGroups: 'Archived Groups',
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
    searchAria: 'Search',
    expandSidebarTooltip: 'Expand sidebar  ⌘B',
    expandSidebarAria: 'Expand sidebar',
    newSessionTooltip: 'New session',
    newSessionAria: 'New session',
    searchTooltip: 'Search  ⌘F',
    searchAriaShort: 'Search',
    importTooltip: 'Import session',
    importAriaShort: 'Import session',
    settingsTooltip: 'Settings  ⌘,',
    settingsAria: 'Settings',
    notificationsMutedAria: 'Notifications muted',
    cwdMissingTooltip:
      'Working directory no longer exists: {{cwd}}. Open this session and repick the folder via the cwd button in the status bar.',
    muteNotifications: 'Mute notifications',
    unmuteNotifications: 'Unmute notifications',
    resizerAriaLabel: 'Resize sidebar',
    resizerTooltip: 'Drag to resize · double-click to reset ({{default}}px)'
  },
  settings: {
    title: 'Settings',
    description: 'Configure appearance, notifications, connection, and updates.',
    tabs: {
      general: 'General',
      appearance: 'Appearance',
      notifications: 'Notifications',
      connection: 'Connection',
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
    density: 'Density',
    densityHint: 'Tightens or loosens row padding and spacing across the app.',
    densityOptions: {
      compact: 'Compact',
      normal: 'Normal',
      comfortable: 'Comfortable'
    },
    windowTint: 'Window tint',
    windowTintHint:
      'Faint accent on this window\u2019s title bar to tell parallel CCSM windows apart at a glance. Local to this window only.',
    windowTintOptions: {
      none: 'None',
      slate: 'Slate',
      sky: 'Sky',
      mint: 'Mint',
      amber: 'Amber',
      rose: 'Rose',
      violet: 'Violet'
    },
    language: 'Language',
    languageHint: 'Choose the interface language. Changes apply immediately.',
    languageOptions: {
      system: 'System',
      en: 'English',
      zh: '中文'
    },
    version: 'Version',
    checkForUpdates: 'Check for updates',
    crashReporting: {
      label: 'Send crash reports to developer',
      description: 'Recommended. Helps fix bugs you hit. No personal data sent.'
    },
    notifications: {
      intro:
        'OS-level toasts when a session needs your attention. Suppressed when the window is focused on that same session, and debounced per session per event type so a chatty agent cannot spam you.',
      enable: 'Enable notifications',
      permission: 'Permission prompts',
      permissionHint: 'When a tool call is waiting on your approval.',
      question: 'Questions',
      questionHint: 'When the agent uses AskUserQuestion to ask you something.',
      turnDone: 'Turn done',
      turnDoneHint:
        'Only fires for long (>15s), errored, or unfocused turns - routine fast turns are skipped.',
      sound: 'Sound',
      soundHint: 'Play the OS default notification sound.',
      toggleOn: 'On',
      toggleOff: 'Off',
      testButton: 'Test notification',
      testTitle: 'CCSM test notification',
      testBody: 'If you can read this, OS notifications are working.',
      testIpcUnavailable: 'IPC unavailable.',
      testSent: 'Sent.',
      testFailed: 'Failed - OS notifications unavailable.',
      moduleAvailable: 'Rich Windows toasts are available.',
      moduleUnavailable:
        'Rich Windows toasts are unavailable on this machine — the optional @ccsm/notify native module did not install. CCSM will fall back to in-app banners and standard system notifications.',
      moduleChecking: 'Checking notification module…'
    },
    connection: {
      intro:
        'CCSM reads connection settings from <code>~/.claude/settings.json</code> plus your <code>ANTHROPIC_*</code> environment variables. To change them, run <code>claude /config</code> or edit the file directly. Restart CCSM to pick up changes.',
      baseUrl: 'Base URL',
      baseUrlDefault: 'https://api.anthropic.com (default)',
      defaultModel: 'Default model',
      modelUnset: '(unset — the CLI will pick its own default)',
      authToken: 'Auth token',
      authConfigured: 'Configured',
      authNotConfigured: 'Not configured — run `claude /config` to sign in.',
      discoveredModels: 'Discovered models ({{count}})',
      discoveredModelsLoadingCount: 'Discovered models (…)',
      discoveredModelsHint:
        'Merged from settings.json, env vars, and the CLI’s built-in picker list.',
      modelsLoading: 'Loading…',
      modelsEmpty: 'No models discovered. Run <code>claude /config</code> to set one up.',
      openSettingsFile: 'Open settings.json',
      opening: 'Opening…'
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
      statusError: 'Update check failed: {{message}}'
    }
  },
  permissions: {
    promptTitle: 'Permission requested',
    allow: 'Allow',
    deny: 'Deny',
    // Display labels for the four official permission modes. The underlying
    // VALUES (default / acceptEdits / plan / bypassPermissions) are CLI argv
    // and remain in English everywhere — only these human-readable labels
    // are localized.
    modeLabel: 'Permission mode',
    modes: {
      default: 'default',
      acceptEdits: 'accept edits',
      plan: 'plan',
      bypassPermissions: 'bypass'
    }
  },
  permissionPrompt: {
    title: 'Permission required',
    allowBtn: 'Allow (Y)',
    allowAlwaysBtn: 'Allow always',
    rejectBtn: 'Reject (N)'
  },
  questionBlock: {
    title: 'Question awaiting answer',
    submit: 'Submit answer',
    submitted: 'Submitted'
  },
  slashCommands: {
    pickerTitle: 'Slash commands',
    pickerHint: 'Type to filter, Enter to run',
    none: 'No matching command',
    noneHint: 'No matching commands — press Enter to send as a regular message.',
    navigate: 'navigate',
    select: 'select',
    complete: 'complete',
    close: 'close',
    runsLocally: 'Runs locally — not forwarded to claude.exe',
    clientTag: 'client',
    groupBuiltIn: 'Built-in',
    groupUser: 'User commands',
    groupProject: 'Project commands',
    groupPlugin: 'Plugin commands'
  },
  notifications: {
    sessionWaitingTitle: 'Session waiting',
    sessionWaitingBody: '{{name}} needs your input',
    sessionDoneTitle: 'Session finished',
    sessionDoneBody: '{{name}} completed its task',
    permissionRequestTitle: 'Permission requested',
    permissionRequestBody: '{{name}} is asking to {{action}}',
    turnDoneTitle: '{{name}} is done',
    turnErrorTitle: '{{name}} finished with an error',
    turnErrorBody: 'Turn ended in error - check the chat.',
    questionTitle: '{{name}} has a question',
    inputNeededTitle: '{{name}} needs your input',
    backgroundSessionFallback: 'Background session',
    backgroundWaitingToastTitle: '{{name}} needs your input'
  },
  tray: {
    show: 'Show CCSM',
    quit: 'Quit',
    tooltip: 'CCSM'
  },
  errors: {
    generic: 'Something went wrong.',
    network: 'Network error. Check your connection.',
    sessionSpawnFailed: 'Failed to start session.',
    apiKeyMissing: 'Anthropic API key is missing.',
    cliMissing: 'Claude Code CLI is not installed.'
  },
  cli: {
    missingTitle: 'Claude Code CLI not found',
    missingBody:
      'CCSM needs the Claude Code CLI to run sessions. Install it and we will detect it automatically.',
    installInstructionsHeader: 'Install instructions',
    detectAgain: 'Detect again',
    cliPathLabel: 'CLI path',
    tutorialNextLabel: 'Next',
    tutorialDoneLabel: "I'm ready",
    dialogTitle: 'Claude CLI not found',
    dialogDescriptionPrefix: 'CCSM wraps the Claude Code CLI. We couldn\u2019t find',
    dialogDescriptionSuffix: 'on your system.',
    whereWeLooked: 'Where we looked',
    tabInstall: 'Install',
    tabHaveIt: 'I already have it',
    pasteHint: 'Paste one of these into your terminal, then click',
    retryDetectInline: 'Retry detect',
    belowInline: 'below.',
    loadingCommands: 'Loading install commands…',
    openDocs: 'Open installation docs',
    haveItHint: 'Already installed Claude Code but we can\u2019t find it? Point us at the',
    binaryLabel: 'binary',
    rememberHint: 'and we\u2019ll remember it.',
    browseBinary: 'Browse for binary…',
    verifying: 'Verifying…',
    verifyHint: 'We verify the pick by running',
    versionFlag: '--version',
    verifyHintSuffix: 'before saving it.',
    minimizeBanner: 'Minimize to banner',
    detecting: 'Detecting…',
    retryDetect: 'Retry detect',
    detected: 'Claude CLI detected',
    foundVersion: 'Found version',
    belowRecommended: '(below recommended {{min}} — some features may misbehave)',
    foundBinaryUnknown: 'Found the binary. Version unknown, but it responded to --version.',
    bannerNotConfigured: 'Claude CLI not configured — sessions won\u2019t start until you install or locate it.',
    bannerSetUp: 'Set up',
    rowHintNative: 'Recommended — installs the official native binary.',
    rowHintNpm: 'Works anywhere Node.js is installed.',
    rowLabelPowerShell: 'PowerShell',
    rowLabelShell: 'Shell',
    rowLabelWinget: 'winget',
    rowLabelHomebrew: 'Homebrew',
    rowLabelPackageManager: 'Package manager',
    rowLabelNpm: 'npm',
    copyAria: 'Copy {{label}} command'
  },
  tutorial: {
    skip: 'Skip',
    back: 'Back',
    next: 'Next',
    done: 'Done',
    stepXofY: 'Step {{current}} of {{total}}',
    goToStepAria: 'Go to step {{n}}',
    welcomeTitle: 'A workbench for AI sessions',
    welcomeBody: 'CCSM turns Claude Code transcripts into something you can navigate. Think of it as a desktop client for the same agent — same power, less terminal.',
    sessionsTitle: 'Run many sessions in parallel',
    sessionsBody: 'Each session is its own agent thread with its own working directory. Switch between them like tabs — the agents keep working in the background.',
    groupsTitle: 'Organize work by task, not by repo',
    groupsBody: 'Group sessions across repositories. A real task usually spans more than one project — CCSM lets you keep them together.',
    startTitle: 'Ready when you are',
    startBody: 'Create a fresh session, or import what you already have from the Claude Code CLI.',
    newSessionBtn: 'New Session',
    importSessionBtn: 'Import Session'
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
    cmdNewSession: 'New session',
    cmdNewGroup: 'New group',
    cmdToggleSidebar: 'Toggle sidebar',
    cmdImport: 'Import from Claude Code…',
    cmdOpenSettings: 'Open settings',
    cmdSwitchTheme: 'Switch theme \u2192 {{next}}',
    hintNavigate: 'Navigate',
    hintSelect: 'Select',
    hintClose: 'Close'
  },
  prDialog: {
    title: 'Create Pull Request',
    descriptionPushing: 'Push {{branch}} \u2192 {{base}} and open a PR on GitHub.',
    descriptionPreflight: 'Running preflight checks…',
    fieldTitle: 'Title',
    fieldBaseBranch: 'Base branch',
    fieldBody: 'Body',
    openAsDraft: 'Open as draft',
    cancel: 'Cancel',
    opening: 'Opening…',
    openPR: 'Open PR'
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
    noOutput: '(no output)'
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
    modeAcceptEditsLabel: 'Accept Edits',
    modeBypassLabel: 'Bypass Permissions',
    modePlanDesc: 'Read-only analysis. No edits, no shell.',
    modeDefaultDesc: 'Auto-approve reads. Ask before edits and shell.',
    modeAcceptEditsDesc: 'Auto-approve reads and edits. Ask before shell.',
    modeBypassDesc: 'Auto-approve everything. Use with care.',
    modePlanTooltip: 'Plan mode \u2014 read-only analysis; no file edits or shell until you approve.',
    modeDefaultTooltip: 'Default \u2014 auto-approve reads; ask before edits and shell.',
    modeAcceptEditsTooltip: 'Accept Edits \u2014 auto-approve reads and file edits; ask before shell.',
    modeBypassTooltip: 'Bypass Permissions \u2014 every tool call runs without asking. Use with care.'
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
    actionToggleSidebar: 'Toggle sidebar',
    actionNewSession: 'New session',
    actionNewGroup: 'New group',
    actionSearch: 'Open search / command palette',
    actionSettings: 'Open settings',
    actionShortcuts: 'Show this shortcuts overlay',
    colShortcut: 'Shortcut',
    colAction: 'Action'
  },
  banner: {
    agentInitFailed: {
      title: 'Failed to start Claude',
      retry: 'Retry',
      retrying: 'Retrying\u2026',
      reconfigure: 'Reconfigure'
    },
    agentDiagnostic: {
      titleError: 'Agent error',
      titleWarning: 'Agent warning',
      dismiss: 'Dismiss diagnostic'
    }
  }
} as const;

// EnCatalog widens leaves to `string` so non-English catalogs can satisfy
// the same shape. Structural parity (every nested key present) is checked
// at compile time; *content* parity (no missing translations) by the
// runtime parity test in `tests/`.
export type EnCatalog = Catalog<typeof en>;
export default en;
