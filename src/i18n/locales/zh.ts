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
    unknown: '未知',
    dismiss: '关闭',
    undo: '撤销'
  },
  sidebar: {
    newSession: '新会话',
    newGroup: '新建分组',
    newGroupEllipsis: '新建分组…',
    groups: '分组',
    groupsEmptyHint: '还没有分组 — 点击 + 创建',
    defaultGroupName: '会话',
    archivedGroups: '已归档分组',
    archiveGroup: '归档分组',
    unarchiveGroup: '取消归档',
    deleteGroupEllipsis: '删除分组…',
    deleteGroup: '删除分组',
    deleteGroupConfirmTitle: '确认删除"{{name}}"？',
    deleteGroupNonEmpty: '该分组包含 {{count}} 个会话，将被移到"已删除"。',
    deleteGroupNonEmpty_other: '该分组包含 {{count}} 个会话，将被移到"已删除"。',
    deleteGroupNonEmptyKept: '该分组包含 {{count}} 个会话，将随分组一并删除。',
    deleteGroupNonEmptyKept_other: '该分组包含 {{count}} 个会话，将随分组一并删除。',
    deleteGroupEmpty: '该分组为空。',
    deleteSessionConfirmTitle: '确认删除"{{name}}"？',
    deleteSessionDescription: '会话及其对话历史将被移除。',
    sessionDeletedToast: '已删除"{{name}}"',
    groupDeletedToast: '已删除分组"{{name}}"',
    moveToGroup: '移动到分组',
    waitingForResponse: '等待响应',
    openInChat: '在聊天中打开',
    sessionCrashed: '本 session 的 claude 进程崩溃了',
    searchAria: '搜索',
    pickCwdTooltip: '在其他目录新建会话',
    pickCwdAria: '为新会话选择工作目录',
    searchTooltip: '搜索  Ctrl+F',
    searchAriaShort: '搜索',
    importTooltip: '导入会话',
    importAriaShort: '导入会话',
    settingsTooltip: '设置  Ctrl+,',
    settingsAria: '设置',
    cwdMissingTooltip: '工作目录已不存在: {{cwd}}。打开此会话后，用状态栏的 cwd 按钮重新选择目录。',
    resizerAriaLabel: '调整侧边栏宽度',
    resizerTooltip: '拖动调整宽度 · 双击重置（{{default}}px）'
  },
  settings: {
    title: '设置',
    description: '配置外观、通知与更新。',
    tabs: {
      general: '通用',
      appearance: '外观',
      notifications: '通知',
      updates: '更新'
    },
    theme: '主题',
    themeHint: '"跟随系统"会随操作系统主题实时切换。',
    themeOptions: {
      system: '跟随系统',
      light: '浅色',
      dark: '深色'
    },
    fontSize: '字号',
    fontSizeHint: '影响整个应用。少量内嵌的小号文本（meta、kbd）保持原始大小。',
    fontSizeAriaLabel: '字号（像素）',
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
    closeBehavior: '关闭按钮行为',
    closeBehaviorHint:
      '点击窗口右上角 X（或按 Ctrl+W）时执行的操作。最小化到托盘可让通知和后台会话保持运行。',
    closeBehaviorOptions: {
      ask: '每次询问',
      tray: '最小化到托盘',
      quit: '退出'
    },
    version: '版本',
    checkForUpdates: '检查更新',
    crashReporting: {
      label: '发送崩溃报告给开发者',
      description: '推荐开启。帮助修复你遇到的 bug。不发送个人数据。'
    },
    notifications: {
      intro:
        '当会话完成回合或需要你处理时弹出系统通知。如果 CCSM 窗口已经聚焦在该会话上，则不再重复提醒。',
      enable: '当会话需要输入时显示桌面通知',
      sound: '声音',
      soundHint: '播放系统默认通知声。'
    },
    updates: {
      version: '版本',
      status: '状态',
      automaticChecks: '自动检查',
      automaticChecksHint: '开启后，CCSM 会在启动时以及每 4 小时去 GitHub 检查更新。',
      automaticChecksToggle: '自动检查更新',
      checking: '检查中…',
      checkButton: '检查更新',
      downloadButton: '下载 {{version}}',
      installButton: '重启并安装',
      statusIdle: '尚未检查更新。',
      statusChecking: '正在检查更新…',
      statusAvailable: '有新版本可用：{{version}}',
      statusNotAvailable: '已经是最新版本。',
      statusDownloading: '下载中… {{percent}}%（{{transferred}} / {{total}}）',
      statusDownloaded: '更新 {{version}} 已就绪 — 重启即可安装。',
      statusError: '检查更新失败：{{message}}',
      downloadedToastTitle: '更新已下载 — 重启以应用',
      downloadedToastBody: '版本 {{version}} 已就绪。',
      downloadedToastAction: '重启'
    }
  },
  notifications: {
    sessionWaitingTitle: '需要你的输入',
    sessionWaitingBody: '{{name}} 在等你',
    sessionDoneTitle: '需要你的输入',
    sessionDoneBody: '{{name}} 在等你',
    permissionRequestTitle: '请求权限',
    permissionRequestBody: '{{name}} 想要 {{action}}',
    turnDoneTitle: '{{name}} 已完成',
    turnDoneBody: '回合结束',
    turnErrorTitle: '{{name}} 执行出错',
    turnErrorBody: '本轮以错误结束，请查看聊天。',
    questionTitle: '{{name}} 提了一个问题',
    questionBody: '提问',
    inputNeededTitle: '{{name}} 需要你的输入',
    permissionBody: '权限请求',
    backgroundSessionFallback: '后台会话',
    backgroundWaitingToastTitle: '{{name}} 需要你的输入'
  },
  installerCorrupt: {
    title: '安装包内的 Claude 程序缺失',
    body: 'CCSM 在安装包里附带了 Claude 程序，但在硬盘上找不到它。请重新安装 CCSM 以修复 — 修复之前会话无法启动。'
  },
  importDialog: {
    title: '从 Claude Code 导入会话',
    description: '挑选已有的 CLI 对话在 CCSM 中显示。打开时会自动 resume。',
    scanning: '扫描中…',
    noImportablePrefix: '没有可导入的会话，扫描位置：',
    selectAll: '全选',
    deselectAll: '全不选',
    selected: '已选 {{count}}',
    selectGroup: '选中本组',
    deselectGroup: '取消本组',
    expand: '展开',
    collapse: '折叠',
    importing: '导入中…',
    importN: '导入 {{count}} 个',
    cancel: '取消'
  },
  commandPalette: {
    title: '命令面板',
    searchPlaceholder: '搜索会话、分组、命令…',
    escKey: 'Esc',
    noMatches: '无匹配项',
    noResultsFor: '未找到"{{query}}"的匹配结果',
    emptyHint: '输入以搜索会话、分组、命令…',
    groupHint: '分组',
    cmdNewGroup: '新建分组',
    cmdImport: '从 Claude Code 导入…',
    cmdOpenSettings: '打开设置',
    cmdSwitchTheme: '切换主题 \u2192 {{next}}',
    hintNavigate: '导航',
    hintSelect: '选择',
    hintClose: '关闭'
  },
  toast: {
    dismiss: '关闭'
  },
  fileTree: {
    noFiles: '（无文件）',
    ariaLabel: '文件树'
  },
  terminal: {
    waitingOutput: '等待输出…',
    noOutput: '（无输出）',
    starting: '启动中…',
    spawnFailed: '终端启动失败',
    retryButton: '重试',
    exitedClean: 'claude 已退出（你输入了 /exit 或 claude 主动结束）。点 Retry 在本 session 开新对话。',
    exitedCrash: 'claude 异常退出（{{detail}}）。这不是 ccsm 的问题，是底层 claude CLI 自己挂了。对话已保存到磁盘，点 Retry 恢复。',
    exitedRetry: '重试'
  },
  chat: {
    cwdChipNoneLabel: '（无）',
  },
  statusBar: {
    workingDirectory: '工作目录',
    model: '模型',
    permissionMode: '权限模式',
    browseFolder: '选择文件夹…',
    loading: '加载中…',
    noModelsHint: '没有模型 — 运行 `claude /config` 或编辑 ~/.claude/settings.json',
    pickModel: '(选择模型)',
    defaultSuffix: '（默认）',
    modePlanLabel: '规划',
    modeDefaultLabel: '默认',
    modeAcceptEditsLabel: '接受编辑',
    modeBypassLabel: '跳过校验',
    modeAutoLabel: '自动',
    modePlanDesc: '只读分析。不编辑文件，不执行 shell。',
    modeDefaultDesc: '自动批准读取。编辑和 shell 需先询问。',
    modeAcceptEditsDesc: '自动批准读取与编辑。shell 需先询问。',
    modeBypassDesc: '所有操作自动批准。请谨慎使用。',
    modeAutoDesc: '由分类器决定批准。研究预览，需 Sonnet 4.6+。',
    modePlanTooltip: '规划模式 — 只读分析；不编辑文件、不执行 shell，除非你批准。',
    modeDefaultTooltip: '默认 — 自动批准读取；编辑和 shell 先询问。',
    modeAcceptEditsTooltip: '接受编辑 — 自动批准读取与文件编辑；shell 先询问。',
    modeBypassTooltip: '跳过校验 — 所有工具调用直接放行。请谨慎使用。',
    modeAutoTooltip: '自动 — 研究预览，需 Sonnet 4.6+。当前账号或模型不支持时会回退到默认。',
    contextLabel: '上下文',
    contextTooltip: '已用 {{percent}}%（{{used}} / {{limit}} 个 token）。点击执行 /compact。',
    contextAriaLabel: '上下文窗口已使用 {{percent}}%。点击触发压缩。',
    effort: '推理强度',
    effortOffLabel: '关闭',
    effortLowLabel: '低',
    effortMediumLabel: '中',
    effortHighLabel: '高',
    effortXhighLabel: '超高',
    effortMaxLabel: '最大',
    effortOffDesc: '不开启思考。最快。',
    effortLowDesc: '简短回答，自适应思考。',
    effortMediumDesc: '兼顾速度与深度。',
    effortHighDesc: '更深入思考（默认）。',
    effortXhighDesc: '更长时间的推理。Opus 4.7。',
    effortMaxDesc: '最大推理强度。Opus 4.6/4.7。'
  },
  cwdPopover: {
    placeholder: '输入筛选或粘贴路径…',
    recent: '最近使用',
    empty: '没有匹配的最近目录',
    browse: '选择文件夹…',
    cwdMissingShort: '已不存在',
    cwdMissingTooltip: '工作目录已不存在: {{cwd}}。请选择另一个目录后再发送。'
  },
  window: {
    minimize: '最小化',
    maximize: '最大化',
    restore: '还原',
    close: '关闭'
  },
  shortcuts: {
    title: '键盘快捷键',
    description: '按 Esc 或点击外部关闭。按 ? 重新打开。',
    openHint: '快捷键',
    groupChat: '聊天',
    groupSidebar: '侧边栏与会话',
    groupNavigation: '导航',
    actionSend: '发送消息',
    actionNewline: '插入换行',
    actionStop: '中断当前回合',
    actionDismissPicker: '关闭斜杠命令选择器',
    actionNewGroup: '新建分组',
    actionSearch: '打开搜索 / 命令面板',
    actionSettings: '打开设置',
    actionShortcuts: '显示快捷键面板',
    colShortcut: '快捷键',
    colAction: '动作'
  },
  // 右侧 pane 在 boot probe (`ccsmPty.checkClaudeAvailable()`) 期间显示，
  // 之前是空白 flex spacer，导致用户在 probe 解析前点"新建会话"就看到一片空白
  // (bug #852 / task #900)。
  claudeAvailability: {
    probing: '正在检测 Claude CLI…'
  },
  // Boot-time full-screen page shown when `claude` CLI not on PATH.
  claudeMissing: {
    title: 'Claude CLI 未找到',
    body: 'ccsm 需要单独安装 Claude CLI。请通过 npm 安装后重新检查。',
    installCommandLabel: '安装命令',
    recheckButton: '重新检查'
  }
};

export default zh;
