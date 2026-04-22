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
    dismiss: 'Dismiss'
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
    tokenUsage: '{{used}}k / {{total}}k tokens · {{percent}}% used',
    emptyTitle: 'No messages yet',
    emptySubtitle: 'Start typing to begin a conversation.',
    ready: 'Ready when you are.',
    jumpToLatest: 'Jump to latest',
    planTitle: 'Plan ready for review',
    planApprove: 'Approve plan',
    planReject: 'Reject',
    todoLabel: 'Todo',
    infoLabel: 'INFO',
    warnLabel: 'WARN',
    toolFailedAria: 'tool failed',
    toolFailedTag: 'failed',
    runningEllipsis: '(running…)',
    runningPlaceholder: 'Running… (input disabled)',
    askPlaceholder: 'Ask anything…',
    attachImage: 'Attach image',
    attachImageTitle: 'Attach image (also supports drag-drop & paste)',
    attachCapReached: 'Attachment cap reached ({{max}})',
    removeAttachment: 'Remove {{name}}',
    dropImageHint: 'Drop image to attach',
    attachmentFormatsHint: 'PNG · JPEG · GIF · WebP · up to {{size}}',
    stopBtn: 'Stop',
    stopAria: 'Stop',
    sendFailedToDeliver: 'Failed to deliver message to agent.',
    cwdMissing:
      'Working directory no longer exists: {{cwd}}. Pick a new folder using the cwd button in the status bar below, then send again.',
    diffAccept: 'Accept',
    diffReject: 'Reject',
    diffAccepted: 'accepted',
    diffRejected: 'rejected',
    inputBytes: 'input',
    expandStringChars: '+{{count}} chars',
    collapseString: 'collapse',
    prOpening: 'opening…',
    prOpen: 'open',
    prPolling: 'CI running…',
    prDone: 'CI complete',
    prFailed: 'failed',
    prCheckRunning: 'running',
    prCheckPassed: 'passed',
    prCheckFailed: 'failed',
    prOpenDetailsAria: 'Open details for {{name}}'
  },
  sidebar: {
    newSession: 'New Session',
    newGroup: 'New group',
    newGroupEllipsis: 'New group…',
    groups: 'Groups',
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
    moveToGroup: 'Move to group',
    waitingForResponse: 'Waiting for response',
    openInChat: 'Open in chat',
    searchAria: 'Search',
    expandSidebarTooltip: 'Expand sidebar  ⌘B',
    expandSidebarAria: 'Expand sidebar',
    newSessionTooltip: 'New session',
    newSessionAria: 'New session',
    searchTooltip: 'Search  ⌘K',
    searchAriaShort: 'Search',
    settingsTooltip: 'Settings  ⌘,',
    settingsAria: 'Settings',
    notificationsMutedAria: 'Notifications muted',
    cwdMissingTooltip:
      'Working directory no longer exists: {{cwd}}. Open this session and repick the folder via the cwd button in the status bar.',
    muteNotifications: 'Mute notifications',
    unmuteNotifications: 'Unmute notifications'
  },
  settings: {
    title: 'Settings',
    tabs: {
      general: 'General',
      appearance: 'Appearance',
      notifications: 'Notifications',
      endpoints: 'Endpoints',
      updates: 'Updates'
    },
    theme: 'Theme',
    themeOptions: {
      system: 'System',
      light: 'Light',
      dark: 'Dark'
    },
    fontSize: 'Font size',
    fontSizeHint: 'Affects chat stream and sidebar',
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
    apiKey: 'Anthropic API key',
    apiKeyHint: 'Stored in OS keychain. Required for Claude Code sessions.',
    apiKeyPlaceholder: 'sk-ant-…',
    testConnection: 'Test connection',
    version: 'Version',
    checkForUpdates: 'Check for updates'
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
    clientTag: 'client'
  },
  notifications: {
    sessionWaitingTitle: 'Session waiting',
    sessionWaitingBody: '{{name}} needs your input',
    sessionDoneTitle: 'Session finished',
    sessionDoneBody: '{{name}} completed its task',
    permissionRequestTitle: 'Permission requested',
    permissionRequestBody: '{{name}} is asking to {{action}}'
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
      'Agentory needs the Claude Code CLI to run sessions. Install it and we will detect it automatically.',
    installInstructionsHeader: 'Install instructions',
    detectAgain: 'Detect again',
    cliPathLabel: 'CLI path',
    tutorialNextLabel: 'Next',
    tutorialDoneLabel: "I'm ready",
    dialogTitle: 'Claude CLI not found',
    dialogDescriptionPrefix: 'agentory-next wraps the Claude Code CLI. We couldn\u2019t find',
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
    welcomeBody: 'Agentory turns Claude Code transcripts into something you can navigate. Think of it as a desktop client for the same agent — same power, less terminal.',
    sessionsTitle: 'Run many sessions in parallel',
    sessionsBody: 'Each session is its own agent thread with its own working directory. Switch between them like tabs — the agents keep working in the background.',
    groupsTitle: 'Organize work by task, not by repo',
    groupsBody: 'Group sessions across repositories. A real task usually spans more than one project — Agentory lets you keep them together.',
    startTitle: 'Ready when you are',
    startBody: 'Create a fresh session, or import what you already have from the Claude Code CLI.',
    newSessionBtn: 'New Session',
    importSessionBtn: 'Import Session'
  },
  importDialog: {
    title: 'Import sessions from Claude Code',
    description: 'Pick existing CLI transcripts to surface in Agentory. They resume on open.',
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
    emptyHint: 'Type to search sessions, groups, commands…',
    groupHint: 'Group',
    cmdNewSession: 'New session',
    cmdNewGroup: 'New group',
    cmdToggleSidebar: 'Toggle sidebar',
    cmdImport: 'Import from Claude Code…',
    cmdOpenSettings: 'Open settings',
    cmdSwitchTheme: 'Switch theme \u2192 {{next}}'
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
    noEndpoints: 'No endpoints configured',
    noModelsHint: 'No models yet — click Refresh in Settings',
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
  }
} as const;

// EnCatalog widens leaves to `string` so non-English catalogs can satisfy
// the same shape. Structural parity (every nested key present) is checked
// at compile time; *content* parity (no missing translations) by the
// runtime parity test in `tests/`.
export type EnCatalog = Catalog<typeof en>;
export default en;
