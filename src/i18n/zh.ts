// 简体中文。键路径必须与 en.ts 一致；缺失的键会回退到英文。
import type { Dict } from './index';

const zh: Dict = {
  app: {
    name: 'Agentory',
    sendShortcut: 'Enter 发送 · Shift+Enter 换行'
  },
  inputBar: {
    placeholderEmpty: '想问什么…',
    placeholderReply: '回复…',
    placeholderRunning: '运行中…（输入已禁用）',
    send: '发送',
    interrupt: '中断'
  },
  statusBar: {
    cwd: '工作目录',
    model: '模型',
    permission: '权限模式',
    browseFolder: '浏览文件夹…'
  },
  permission: {
    plan: '规划',
    planSecondary: '只规划，不执行编辑或命令',
    ask: '询问',
    askSecondary: '每次工具调用前都询问',
    auto: '自动',
    autoSecondary: '自动批准编辑；shell 命令仍询问',
    yolo: '放手',
    yoloSecondary: '一律放行（请谨慎使用）'
  },
  sidebar: {
    newSession: '新建会话',
    newGroup: '新建分组',
    importSession: '导入会话',
    archive: '归档',
    rename: '重命名',
    delete: '删除',
    moveToGroup: '移至分组'
  },
  settings: {
    title: '设置',
    tab: {
      general: '通用',
      autopilot: '自动驾驶',
      account: '账户',
      data: '数据',
      shortcuts: '快捷键',
      updates: '更新'
    },
    general: {
      theme: '主题',
      themeSystem: '跟随系统',
      themeLight: '浅色',
      themeDark: '深色',
      fontSize: '字号',
      fontSizeHint: '影响聊天区与侧边栏',
      fontSizeSm: '小 (12px)',
      fontSizeMd: '中 (13px，默认)',
      fontSizeLg: '大 (14px)',
      language: '语言',
      languageHint: '首次启动时跟随系统语言。',
      languageSystem: '跟随系统',
      languageEn: 'English',
      languageZh: '简体中文'
    },
    autopilot: {
      intro:
        '当 agent 完成一轮但没说出"完成口令"时，Agentory 会替你回复，让它别停下。每个会话有上限，避免死循环。',
      enabled: '启用自动驾驶',
      enabledHint: '当 agent 没说完成口令就停下时，自动回复。',
      on: '开',
      off: '关',
      doneToken: '完成口令',
      doneTokenHint: '如果 agent 最后一条消息包含此字符串，本轮跳过自动回复。',
      otherwise: '否则…',
      otherwiseHint: '会拼接在 "如果你真的做完了，请回复我：<口令>。\\n\\n否则：" 后面。',
      maxReplies: '每个会话最多自动回复次数',
      maxRepliesHint: '你手动发消息时会重置。0 = 无限（请谨慎）。默认 20。'
    },
    account: {
      apiKey: 'Anthropic API Key',
      apiKeyHint: '存于系统钥匙串。运行 Claude Code 会话所必需。',
      apiKeyHintNoEnc: '当前系统不支持加密存储 — 无法保存 Key。',
      save: '保存',
      saved: '已保存。',
      saveFailed: '保存失败（加密不可用）。'
    },
    data: {
      dataDir: '数据目录',
      dataDirHint: 'Agentory 存储分组、会话与偏好的位置。',
      sessionsDir: 'Claude 会话目录',
      sessionsDirHint: '只读。由 Claude Code SDK 管理。'
    },
    shortcuts: {
      hint: 'MVP 阶段快捷键固定 — 自定义维护成本高，价值不明显。'
    },
    updates: {
      version: '版本',
      status: '状态',
      check: '检查更新',
      checking: '检查中…',
      download: '下载 {version}',
      install: '重启并安装',
      idle: '尚未检查更新。',
      checkingDetail: '正在检查更新…',
      available: '有新版本：{version}',
      notAvailable: '已是最新版本。',
      downloading: '下载中… {percent}% ({transferred} / {total})',
      downloaded: '更新 {version} 已就绪 — 请重启安装。',
      error: '检查失败：{message}'
    }
  },
  watchdog: {
    autopilotPaused: '自动驾驶已暂停',
    autopilotPausedDetail: '已自动回复 {n} 次仍未出现完成口令；交还给你。',
    autopilotProgress: '自动驾驶 {n}/{cap}',
    autopilotProgressDetail: '由于 agent 未说完成口令就停下，已自动追问。'
  },
  notification: {
    needsInput: '{name} 需要你的输入',
    backgroundSession: '后台会话'
  },
  common: {
    cancel: '取消',
    confirm: '确定',
    close: '关闭',
    done: '完成'
  }
};

export default zh;
