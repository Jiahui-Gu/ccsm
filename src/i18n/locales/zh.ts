import type { EnCatalog } from './en';

// Chinese translation catalog. Key set MUST exactly match `en.ts` —
// `tests/i18n-key-parity.test.ts` enforces this. To rename or remove a key,
// change `en.ts` first; the parity test will guide you to fix this file.
//
// Style notes:
// - Chinese strings deliberately keep CLI/term-of-art English where the
//   English term is more recognisable (e.g. "Webhook"). When in doubt,
//   defer to what a Chinese senior dev would type in chat.
// - Permission-mode VALUES stay English — only the display labels are
//   translated.
const zh: EnCatalog = {
  common: {
    ok: '确定',
    cancel: '取消',
    save: '保存',
    delete: '删除',
    rename: '重命名',
    confirm: '确认',
    close: '关闭',
    open: '打开',
    apply: '应用',
    retry: '重试',
    back: '返回',
    next: '下一步',
    finish: '完成',
    skip: '跳过',
    yes: '是',
    no: '否',
    loading: '加载中…',
    search: '搜索',
    settings: '设置',
    new: '新建',
    add: '添加',
    remove: '移除',
    archive: '归档',
    unarchive: '取消归档',
    unknown: '未知'
  },
  chat: {
    permissionRequested: '请求权限',
    allow: '允许',
    deny: '拒绝',
    expandTool: '展开工具输出',
    collapseTool: '折叠工具输出',
    noOutput: '（暂无输出）',
    errorLabel: '错误',
    sendMessage: '发送消息',
    sendButton: '发送',
    inputPlaceholder: '回复…',
    enterToSend: 'Enter 发送 · Shift+Enter 换行',
    tokenUsage: '{{used}}k / {{total}}k tokens · 已用 {{percent}}%',
    emptyTitle: '暂无消息',
    emptySubtitle: '开始输入即可发起对话。'
  },
  sidebar: {
    newSession: '新会话',
    newGroup: '新建分组',
    newGroupEllipsis: '新建分组…',
    groups: '分组',
    archivedGroups: '已归档分组',
    archiveGroup: '归档分组',
    unarchiveGroup: '取消归档',
    deleteGroupEllipsis: '删除分组…',
    deleteGroup: '删除分组',
    deleteGroupConfirmTitle: '确认删除"{{name}}"？',
    deleteGroupNonEmpty: '该分组包含 {{count}} 个会话，将被移到"已删除"。',
    deleteGroupNonEmpty_other: '该分组包含 {{count}} 个会话，将被移到"已删除"。',
    deleteGroupEmpty: '该分组为空。',
    deleteSessionConfirmTitle: '确认删除"{{name}}"？',
    deleteSessionDescription: '会话及其对话历史将被移除。',
    moveToGroup: '移动到分组',
    waitingForResponse: '等待响应',
    openInChat: '在聊天中打开',
    searchAria: '搜索'
  },
  settings: {
    title: '设置',
    tabs: {
      general: '通用',
      appearance: '外观',
      memory: '记忆',
      notifications: '通知',
      endpoints: '端点',
      autopilot: '自动驾驶',
      permissions: '权限',
      account: '账户',
      data: '数据',
      shortcuts: '快捷键',
      updates: '更新'
    },
    theme: '主题',
    themeOptions: {
      system: '跟随系统',
      light: '浅色',
      dark: '深色'
    },
    fontSize: '字号',
    fontSizeHint: '影响聊天流和侧边栏',
    fontSizeOptions: {
      sm: '小 (12px)',
      md: '中 (13px，默认)',
      lg: '大 (14px)'
    },
    language: '语言',
    languageHint: '选择界面语言。修改立即生效。',
    languageOptions: {
      system: '跟随系统',
      en: 'English',
      zh: '中文'
    },
    apiKey: 'Anthropic API Key',
    apiKeyHint: '保存在系统钥匙串中。运行 Claude Code 会话所必需。',
    apiKeyPlaceholder: 'sk-ant-…',
    testConnection: '测试连接',
    dataDirectory: '数据目录',
    dataDirectoryHint: 'Agentory 存放分组、会话和偏好的位置。',
    claudeSessionsDirectory: 'Claude 会话目录',
    claudeSessionsDirectoryHint: '只读。由 Claude Code SDK 管理。',
    shortcutsHint: 'MVP 阶段快捷键固定 — 自定义带来的维护成本不抵价值。',
    version: '版本',
    checkForUpdates: '检查更新',
    shortcutDescriptions: {
      palette: '搜索 / 命令面板',
      settings: '设置',
      newSession: '新会话',
      newGroup: '新建分组',
      toggleSidebar: '切换侧边栏',
      send: '发送消息',
      newline: '在输入框换行',
      escape: '关闭对话框 / 取消重命名'
    }
  },
  permissions: {
    promptTitle: '请求权限',
    allow: '允许',
    deny: '拒绝',
    modeLabel: '权限模式',
    modes: {
      default: '默认',
      acceptEdits: '自动接受编辑',
      plan: '规划',
      bypassPermissions: '跳过校验'
    }
  },
  slashCommands: {
    pickerTitle: '斜杠命令',
    pickerHint: '输入以筛选，回车执行',
    none: '没有匹配的命令'
  },
  notifications: {
    sessionWaitingTitle: '会话等待中',
    sessionWaitingBody: '{{name}} 需要你的输入',
    sessionDoneTitle: '会话已完成',
    sessionDoneBody: '{{name}} 完成了任务',
    permissionRequestTitle: '请求权限',
    permissionRequestBody: '{{name}} 想要 {{action}}'
  },
  errors: {
    generic: '出错了。',
    network: '网络错误。请检查连接。',
    sessionSpawnFailed: '会话启动失败。',
    apiKeyMissing: '缺少 Anthropic API Key。',
    cliMissing: '未安装 Claude Code CLI。'
  },
  worktree: {
    title: 'Worktree',
    createWorktree: '创建 worktree',
    deleteWorktree: '删除 worktree',
    branchLabel: '分支',
    pathLabel: '路径',
    statusClean: '干净',
    statusDirty: '有未提交更改'
  },
  cli: {
    missingTitle: '未找到 Claude Code CLI',
    missingBody: 'Agentory 需要 Claude Code CLI 才能运行会话。安装后我们会自动检测。',
    installInstructionsHeader: '安装说明',
    detectAgain: '重新检测',
    cliPathLabel: 'CLI 路径',
    tutorialNextLabel: '下一步',
    tutorialDoneLabel: '我准备好了'
  }
};

export default zh;
