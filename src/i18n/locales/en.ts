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
    unknown: 'Unknown'
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
    emptySubtitle: 'Start typing to begin a conversation.'
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
    deleteGroupEmpty: 'This group is empty.',
    deleteSessionConfirmTitle: 'Delete "{{name}}"?',
    deleteSessionDescription: 'The session and its conversation history will be removed.',
    moveToGroup: 'Move to group',
    waitingForResponse: 'Waiting for response',
    openInChat: 'Open in chat',
    searchAria: 'Search'
  },
  settings: {
    title: 'Settings',
    tabs: {
      general: 'General',
      appearance: 'Appearance',
      memory: 'Memory',
      notifications: 'Notifications',
      endpoints: 'Endpoints',
      autopilot: 'Autopilot',
      permissions: 'Permissions',
      account: 'Account',
      data: 'Data',
      shortcuts: 'Shortcuts',
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
    dataDirectory: 'Data directory',
    dataDirectoryHint: 'Where Agentory stores groups, sessions, and preferences.',
    claudeSessionsDirectory: 'Claude sessions directory',
    claudeSessionsDirectoryHint: 'Read-only. Managed by Claude Code SDK.',
    shortcutsHint:
      'Keybindings are fixed in MVP — remapping adds maintenance burden without clear user value.',
    version: 'Version',
    checkForUpdates: 'Check for updates',
    shortcutDescriptions: {
      palette: 'Search / Command Palette',
      settings: 'Settings',
      newSession: 'New session',
      newGroup: 'New group',
      toggleSidebar: 'Toggle sidebar',
      send: 'Send message',
      newline: 'Newline in input',
      escape: 'Close dialog / cancel rename'
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
  slashCommands: {
    pickerTitle: 'Slash commands',
    pickerHint: 'Type to filter, Enter to run',
    none: 'No matching command'
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
  worktree: {
    title: 'Worktrees',
    createWorktree: 'Create worktree',
    deleteWorktree: 'Delete worktree',
    branchLabel: 'Branch',
    pathLabel: 'Path',
    statusClean: 'Clean',
    statusDirty: 'Uncommitted changes'
  },
  cli: {
    missingTitle: 'Claude Code CLI not found',
    missingBody:
      'Agentory needs the Claude Code CLI to run sessions. Install it and we will detect it automatically.',
    installInstructionsHeader: 'Install instructions',
    detectAgain: 'Detect again',
    cliPathLabel: 'CLI path',
    tutorialNextLabel: 'Next',
    tutorialDoneLabel: "I'm ready"
  }
} as const;

// EnCatalog widens leaves to `string` so non-English catalogs can satisfy
// the same shape. Structural parity (every nested key present) is checked
// at compile time; *content* parity (no missing translations) by the
// runtime parity test in `tests/`.
export type EnCatalog = Catalog<typeof en>;
export default en;
