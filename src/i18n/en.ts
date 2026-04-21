// English dictionary. Add new keys here first; the `Dict` type drives the
// shape of all other locales. Keep sections grouped by feature so missing
// translations are easy to spot.
export default {
  app: {
    name: 'Agentory',
    sendShortcut: 'Enter send · Shift+Enter newline'
  },
  inputBar: {
    placeholderEmpty: 'Ask anything…',
    placeholderReply: 'Reply…',
    placeholderRunning: 'Running… (input disabled)',
    send: 'Send',
    interrupt: 'Interrupt'
  },
  statusBar: {
    cwd: 'Working directory',
    model: 'Model',
    permission: 'Permission mode',
    browseFolder: 'Browse folder…'
  },
  permission: {
    plan: 'plan',
    planSecondary: 'Plan only — no edits or commands',
    ask: 'ask',
    askSecondary: 'Ask before each tool call',
    auto: 'auto',
    autoSecondary: 'Auto-approve edits; ask for shell',
    yolo: 'yolo',
    yoloSecondary: 'Approve everything (use with care)'
  },
  sidebar: {
    newSession: 'New session',
    newGroup: 'New group',
    importSession: 'Import session',
    archive: 'Archive',
    rename: 'Rename',
    delete: 'Delete',
    moveToGroup: 'Move to group'
  },
  settings: {
    title: 'Settings',
    tab: {
      general: 'General',
      autopilot: 'Autopilot',
      account: 'Account',
      data: 'Data',
      shortcuts: 'Shortcuts',
      updates: 'Updates'
    },
    general: {
      theme: 'Theme',
      themeSystem: 'System',
      themeLight: 'Light',
      themeDark: 'Dark',
      fontSize: 'Font size',
      fontSizeHint: 'Affects chat stream and sidebar',
      fontSizeSm: 'Small (12px)',
      fontSizeMd: 'Medium (13px, default)',
      fontSizeLg: 'Large (14px)',
      language: 'Language',
      languageHint: 'Defaults to system locale on first run.',
      languageSystem: 'System',
      languageEn: 'English',
      languageZh: '简体中文'
    },
    autopilot: {
      intro:
        "When an agent finishes a turn without saying the done token, Agentory will reply on your behalf so it doesn't sit idle. Capped per session to keep runaway loops in check.",
      enabled: 'Enable autopilot',
      enabledHint: "Auto-reply when the agent stops without the done token.",
      on: 'On',
      off: 'Off',
      doneToken: 'Done token',
      doneTokenHint:
        "If the agent's last message contains this exact string, autopilot stops for the turn.",
      otherwise: 'Otherwise…',
      otherwiseHint:
        "Appended after '如果你真的做完了，请回复我：<token>。\\n\\n否则：' in the auto-reply.",
      maxReplies: 'Max auto-replies per session',
      maxRepliesHint: 'Resets when you send a real message. 0 = unlimited (use with care). Default 20.'
    },
    account: {
      apiKey: 'Anthropic API key',
      apiKeyHint: 'Stored in OS keychain. Required for Claude Code sessions.',
      apiKeyHintNoEnc: 'OS encryption unavailable — key cannot be saved on this system.',
      save: 'Save',
      saved: 'Saved.',
      saveFailed: 'Failed to save (encryption unavailable).'
    },
    data: {
      dataDir: 'Data directory',
      dataDirHint: 'Where Agentory stores groups, sessions, and preferences.',
      sessionsDir: 'Claude sessions directory',
      sessionsDirHint: 'Read-only. Managed by Claude Code SDK.'
    },
    shortcuts: {
      hint: 'Keybindings are fixed in MVP — remapping adds maintenance burden without clear user value.'
    },
    updates: {
      version: 'Version',
      status: 'Status',
      check: 'Check for updates',
      checking: 'Checking…',
      download: 'Download {version}',
      install: 'Restart & install',
      idle: 'No update check performed yet.',
      checkingDetail: 'Checking for updates…',
      available: 'Update available: {version}',
      notAvailable: 'You are on the latest version.',
      downloading: 'Downloading… {percent}% ({transferred} / {total})',
      downloaded: 'Update {version} ready — restart to install.',
      error: 'Update check failed: {message}'
    }
  },
  watchdog: {
    autopilotPaused: 'Autopilot paused',
    autopilotPausedDetail: 'Reached {n} auto-replies without the done token; over to you.',
    autopilotProgress: 'Autopilot {n}/{cap}',
    autopilotProgressDetail: 'Sent automatic follow-up because the agent stopped without the done token.'
  },
  notification: {
    needsInput: '{name} needs your input',
    backgroundSession: 'Background session'
  },
  common: {
    cancel: 'Cancel',
    confirm: 'Confirm',
    close: 'Close',
    done: 'Done'
  }
} as const;
