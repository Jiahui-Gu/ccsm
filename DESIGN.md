# ccsm — Design

ccsm 是 Claude Code 的 web 端 session manager。一个本地 daemon 进程托管多条 `claude` PTY 会话, 浏览器 tab 通过 WebSocket 接入, 1:N fanout, 断线重连不丢输出。

> 架构灵感: Wave Terminal (sidecar + localhost ws + AuthKey)、JupyterLab Desktop (URL+token 启动)、ttyd (二进制 frame + PAUSE/RESUME backpressure)。

---

## §1 Goals & Non-Goals

### Goals

- G1. 本地一条命令 `npx ccsm` 起 daemon, 终端打印 `http://127.0.0.1:<port>/?token=<t>`, 浏览器打开即用。
- G2. 支持多条 `claude` 会话并发, 每条会话有独立 PTY、独立 ring buffer。
- G3. 同一会话支持多个浏览器 tab 同时观看 (1:N fanout), 输入路由回唯一 PTY。前端单 tab 内只展示一个 session, 多 session 通过侧边栏切换。
- G4. 断线重连: 客户端带 `lastSeq` 重连, daemon 从 ring buffer 补发缺失字节, 不丢输出。
- G5. 后端零信任前端: 所有 ws/http 请求验 token + 验 origin (仅 `127.0.0.1` / `localhost`)。

### Non-Goals

- 不做桌面端外壳 (Electron/Tauri/PWA)。前端代码仅约束**不调用任何桌面 API**, 留出后续低成本套壳的口子。
- 不做远程访问 (跨机访问、公网暴露、用户系统、多租户)。daemon 仅 listen 127.0.0.1。
- 不做插件系统、theme marketplace、AI agent orchestration。
- 不做 session 持久化到磁盘 (daemon 退出 = session 丢失, MVP 阶段可接受)。

---

## §2 Critical Flows

### F1. 冷启动

1. 用户跑 `npx ccsm`。
2. daemon 进程启动, 选一个空闲端口 (默认尝试 17832, 占用则 +1 直到成功), 生成 32B 随机 token。
3. stdout 打印一行: `ccsm ready: http://127.0.0.1:<port>/?token=<token>`。
4. 进程前台运行, Ctrl-C 退出。

### F2. 浏览器接入

1. 用户点终端里的 URL, 浏览器打开。
2. 前端 SPA 加载, 从 `window.location.search` 取 token, 存到 `sessionStorage` (不存 localStorage, 关 tab 即清)。
3. 后续所有 http/ws 请求带 `Authorization: Bearer <token>` (http) 或 `?token=<token>` (ws 握手参数)。

### F3. 新建 session

1. 前端 `POST /api/sessions { cwd?: string }` → daemon 返回 `{ sid, channelId }`。
2. daemon spawn `node-pty` 跑 `claude` (走 `@anthropic-ai/claude-agent-sdk` 或直接 spawn cli, §6 详述), cwd 用请求里的或 daemon 启动时的。
3. PTY 输出写入该 session 的 ring buffer + 通过 wps-style pubsub 推到所有订阅者。

### F4. Tab 接入 session

1. 前端 `WebSocket('ws://127.0.0.1:<port>/ws?token=<t>&sid=<sid>&lastSeq=<n>')`。
2. daemon 验 token + 验 origin + 查 sid 存在 + 该 ws 加入该 session 的订阅者集合。
3. 若 `lastSeq < currentSeq`, daemon 从 ring buffer 取 `[lastSeq+1, currentSeq]` 字节先发, 之后实时 fanout。
4. 若 `lastSeq` 已被 ring buffer 覆盖 (太老), daemon 发 `{type: "reset"}` 控制帧, 客户端清屏重新订阅。

### F5. 多 tab 同步 (跨浏览器 tab)

1. 用户复制当前 URL 到第二个 tab, 同 sid 被两个 tab 订阅, 都收到相同输出流。
2. 任一 tab 发 INPUT 帧 → daemon 路由到该 sid 的 PTY (PTY 只有一个)。
3. PTY 回响 (echo) 走正常输出流, 两个 tab 都看到。

注: 单 tab 内只渲染一个 session 的 terminal (active sid), 切 session 时 detach 旧 ws + attach 新 ws (或保留旧 ws 在后台收数据写入 ring, §7 详述)。

### F6. 断线重连

1. 网络抖动 / 笔记本休眠 → ws close。
2. 客户端记最后收到的 seq, 重新拨 ws 带 `lastSeq=<n>`。
3. 走 F4 第 3 步补发逻辑。

---

## §3 Architecture

### 进程模型

- 单进程 daemon (Node.js)。
- daemon 内三个组件:
  - **HTTP server** (`fastify` 或 `node:http`): 静态资源 + REST API (`/api/sessions`, `/api/sessions/:sid` DELETE)。
  - **WebSocket server** (`ws` 库, 挂在同一 http server 上, path `/ws`): 二进制帧 PTY 流。
  - **Session manager**: `Map<sid, Session>`, 每个 Session 持 `node-pty.IPty` + ring buffer + 订阅者 Set。

### Sidecar 是否独立进程

不独立。MVP 阶段所有逻辑在一个 Node 进程里。Wave 把 Go sidecar 独立出来是因为 Electron 主进程的 Node 不适合跑业务; 我们没有 Electron, daemon 本身就是业务进程。

### 1:N fanout

- 每个 Session 有 `subscribers: Set<WebSocket>`。
- PTY data event → 写 ring buffer → for-each subscribers 发 OUTPUT 帧。
- subscriber close → 从 Set 移除; Set 空也不杀 PTY (用户可能只是关 tab, session 留着)。

### Ring buffer

- 每个 Session 一个固定大小 (默认 4MB) 的环形字节缓冲。
- 记录 `(seq, byteOffset)` 索引, 支持按 seq 查找区间。
- 超过 buffer 大小的旧数据被覆盖, 此时重连客户端收到 `reset`。

---

## §4 RPC Contracts

REST (JSON over HTTP):

```
POST   /api/sessions
       body: { cwd?: string }
       resp: { sid: string, createdAt: number }

GET    /api/sessions
       resp: { sessions: [{ sid, createdAt, alive: boolean }] }

DELETE /api/sessions/:sid
       resp: { ok: true }
```

所有请求要 `Authorization: Bearer <token>`, 否则 401。

WebSocket:

```
GET /ws?token=<t>&sid=<sid>&lastSeq=<n>
```

握手时验 token + origin + sid。握手成功后只走二进制帧 (§5)。

---

## §5 WebSocket Protocol

二进制帧, 一个 ws message = 一个帧:

```
+--------+--------+--------+--------+
| type   |     seq (u32 BE)         |  + payload (bytes)
| 1B     |     4B                   |
+--------+--------+--------+--------+
```

帧类型:

| type (hex) | 方向 | 含义 | payload |
|-----------|------|------|---------|
| 0x01 OUTPUT | s→c | PTY stdout/stderr | raw bytes |
| 0x02 INPUT  | c→s | 用户输入 | raw bytes |
| 0x03 RESIZE | c→s | 终端 resize | `cols (u16 BE), rows (u16 BE)` |
| 0x04 PAUSE  | c→s | 客户端拥塞, 请暂停发 OUTPUT | empty |
| 0x05 RESUME | c→s | 恢复发送 | empty |
| 0x06 RESET  | s→c | ring buffer 已覆盖, 客户端清屏 | empty |
| 0x07 EXIT   | s→c | PTY 退出 | `code (u32 BE)` |

`seq` 字段:

- OUTPUT 帧: daemon 自增, 每帧 +1。客户端记 `lastSeq` 用于重连。
- INPUT/RESIZE/PAUSE/RESUME: 由客户端写, daemon 不校验, 仅用于客户端自己排序 (一般忽略)。

PAUSE/RESUME 是显式 backpressure, 不依赖 ws 内部 buffer 水位 (那个不可靠)。

---

## §6 SDK Integration

`@anthropic-ai/claude-agent-sdk` 是 ESM-only。daemon 用法:

- daemon 入口 `index.mjs` (ESM), 直接 `import { ... } from '@anthropic-ai/claude-agent-sdk'`。
- 实际 spawn `claude` CLI 还是用 `node-pty`, 因为我们要 PTY 语义 (full-screen TUI、color、resize)。SDK 适合非 TUI 场景, MVP 不用。
- 后续若要做 inline tool call 解析, 再引入 SDK 处理结构化输出 (out of MVP scope)。

`node-pty` 调用:

```js
import { spawn } from 'node-pty';
const pty = spawn('claude', [], {
  name: 'xterm-256color',
  cols: 80,
  rows: 24,
  cwd: opts.cwd,
  env: process.env,
});
pty.onData(data => session.broadcast(data));
pty.onExit(({ exitCode }) => session.notifyExit(exitCode));
```

Windows 上 `node-pty` 用 ConPTY, prebuilt binary 走 `npm install` 自带, 不需要用户装编译工具链 (验证: 起码 node-pty 1.0+ 在 Node 20 prebuilt 全)。

---

## §7 Frontend State

技术栈: React + TypeScript + xterm.js + zustand。

### 布局

单页, 单浏览器 tab。沿用 v0.2 桌面端 sidebar + main 双栏结构 (可拖拽分隔条):

```
┌─────────────────────────┬────────────────────────────────────┐
│ [+ New Session ▾] [ 🔍 ]│                                    │
│ ─────────────────────── │                                    │
│ GROUPS              [+] │                                    │
│   ▾ default             │                                    │
│       * a1b2  10:31     │   xterm.js (active session)        │
│         c3d4  10:42     │                                    │
│   ▸ scratch             │                                    │
│                         │                                    │
│ ─────────────────────── │                                    │
│ ▸ Archived              │                                    │
│ ─────────────────────── │                                    │
│ [ ⚙ Settings    ] [ ⬇ ] │                                    │
└─────────────────────────┴────────────────────────────────────┘
```

四个区:

- **顶**: `+ New Session` 主按钮 **(MVP 真实现, 点击直接创建)** + 搜索图标 **(占位, onClick 空)**。cwd 下拉 (`▾`) MVP 不做, 新建 session 的 cwd 固定用 daemon 启动时的 cwd (后续接 cwd picker)。
- **中**: GROUPS 区, 用户可建多个分组, 每组下挂多个 session, session 行支持 drag-to-reorder 跨组拖动, 行右侧 hover 出操作菜单 (rename / move / close)。active session 高亮。
- **下中**: Archived 折叠区, 默认折叠, 用来塞用户归档掉的旧 group。
- **底**: Settings 按钮 + 导入按钮 **(均占位, 渲染按钮但 onClick 空 / 弹"未实现" toast)**。

右侧 main 区 MVP 阶段只放 xterm.js, 不做 v0.2 的 StatusBar / FileTree / InputBar 等附属面板 (那些进 P2 之后)。

桌面端的 WindowControls (min/max/close) 不画 — 浏览器自带。

### Store 结构

```ts
type Session = {
  sid: string;
  createdAt: number;
  alive: boolean;
  ws: WebSocket | null;
  lastSeq: number;
  // 每 session 持自己的 ring buffer 副本 (字节序列 + lastSeq), 切走时 ws 保活继续填
  scrollback: Uint8Array[];
};

type Store = {
  token: string;
  sessions: Map<string, Session>;
  activeSid: string | null;
  term: Terminal;  // 全局唯一 xterm.js 实例

  createSession(cwd?: string): Promise<string>;
  setActive(sid: string): void;          // detach 旧渲染, 用 active session 的 scrollback 重绘 + 接管输入
  closeSession(sid: string): Promise<void>;
  sendInput(data: string): void;          // 路由到 activeSid
  resize(cols: number, rows: number): void;
};
```

### 切 session 行为

- 后台 session 的 ws 保持连接, 继续收 OUTPUT 写入 `scrollback`, 不渲染。
- `setActive(sid)`: `term.reset()` → 把目标 session 的 `scrollback` 一次性 `term.write()` 回放 → 之后该 session 的 OUTPUT 直接 `term.write()`。
- 关 session: REST DELETE + 关 ws + 从 Map 移除; 若关的是 active, 自动选 list 第一项 (或空状态)。

### 重连策略

- ws close → 等 1s 重试, 指数退避到 30s 上限。
- 重连成功后带 `lastSeq` 走 §F6。
- 收到 `RESET` 帧 → `term.reset()` + `lastSeq = 0`。

### 桌面 API 禁用

前端代码静态检查 (eslint rule) 禁止出现:

- `window.electron`
- `window.__TAURI__`
- `import('@tauri-apps/api/...')`
- `import('electron')`

CI 跑 `eslint --max-warnings=0`, 任何引用直接红。这是为了保证后续套壳时前端原样可用。

---

## §8 File Layout

monorepo (pnpm workspace):

```
ccsm/
├── package.json              # workspace 根
├── pnpm-workspace.yaml
├── packages/
│   ├── daemon/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── src/
│   │   │   ├── index.mts     # 入口, parse args, listen
│   │   │   ├── http.mts      # fastify routes
│   │   │   ├── ws.mts        # ws server + frame codec
│   │   │   ├── session.mts   # Session class + ring buffer
│   │   │   ├── manager.mts   # SessionManager
│   │   │   └── auth.mts      # token + origin 校验
│   │   └── bin/
│   │       └── ccsm.mjs      # #!/usr/bin/env node 入口
│   ├── frontend/
│   │   ├── package.json
│   │   ├── vite.config.ts
│   │   ├── index.html
│   │   └── src/
│   │       ├── main.tsx
│   │       ├── App.tsx
│   │       ├── store.ts
│   │       ├── components/
│   │       │   ├── TopBar.tsx
│   │       │   ├── SessionList.tsx
│   │       │   └── TerminalView.tsx
│   │       └── ws/
│   │           ├── client.ts # ws 连接 + 重连 + 帧 codec
│   │           └── frame.ts  # encode/decode 二进制帧
│   └── shared/
│       ├── package.json
│       └── src/
│           ├── frame.ts      # 帧常量 + 类型 (前后端共用)
│           └── api.ts        # REST 类型 (前后端共用)
└── README.md
```

`daemon` 启动时把 `frontend` 的 `dist/` 当静态资源 serve。

---

## §9 Phase Plan

### Phase 1 — Walking skeleton (1 周)

- daemon 起得来, 监听端口, 打 URL+token。
- REST `POST /api/sessions` 能 spawn `claude` 并返 sid。
- ws 接进来能看到 PTY 输出, 能打字。
- 前端按 §7 布局画出来: sidebar (顶 New Session + Search + 中 GROUPS + 底 Settings/Import) + main (xterm.js)。其中 Search / Settings / Import / cwd `▾` 下拉**只渲染按钮, onClick 空 (或弹未实现 toast)**, 不影响布局完整度。`+ New Session` 主按钮真实现, 点击 → POST /api/sessions → setActive。
- 单 session, 无 GROUPS 拖拽 / Archived / 多分组 (这些进 P2)。
- **验收**: 点 `+ New Session` → 浏览器跑通 `claude --help` 等价交互, 输出对得上; Search/Settings/Import 点了不崩。

### Phase 2 — Multi-session + 重连 (1 周)

- 前端 GROUPS 区接通, `+ New Session` 创建后挂到 default group 下, 列表点击切换 active。
- 后台 session 的 ws 保活 + scrollback 累积, setActive 时回放。
- ring buffer + lastSeq 重连 (网络抖动场景)。
- 跨浏览器 tab 复用 URL 看同一 sid 走通 (验 1:N fanout, 不做 UI 支持)。
- **验收**: 创 3 个 session 来回切, scrollback 不丢; 关 tab 重开 (带原 URL+token) 输出对齐。

### Phase 3 — 健壮性 (1 周)

- PAUSE/RESUME backpressure (前端 xterm.js 写慢时主动 PAUSE)。
- token 漏配 / origin 错误的 401/403 路径有测试覆盖。
- daemon 进程退出时优雅杀所有 PTY (SIGHUP)。
- Windows + macOS + Linux 各跑一次冷启动手测。
- **验收**: 灌一段超大输出 (`yes` 或 1MB log), UI 不卡死, 关 tab 重开数据完整。

---

## §10 Desktop Shell — Deferred

MVP 不做。但前端约束 (§7) 保证后续三条路任选其一都成本低:

- **Electron**: 主进程 fork daemon (或 spawn 子进程), 主窗口 `loadURL('http://127.0.0.1:<port>/?token=<t>')`。前端代码零改动。
- **Tauri**: 同上, Rust 进程 spawn daemon, webview 加载本地 URL。前端零改动 (前提是 §7 的 lint rule 一直没破)。
- **PWA**: 加 manifest + service worker, 用户点 "安装" 装到桌面。daemon 仍要单独跑, PWA 只是浏览器壳。

选哪条等真要做的时候再定, 当前不污染 daemon/frontend 设计。

---

## §11 Deployment Topologies

> 详细路线图见 `docs/ROADMAP.md`。本节只锁一条架构红线: **Tauri 壳与 Cloudflare Pages 入口完全独立, 互不依赖**。

ccsm 自 S2 起同时存在三种入口拓扑, 任一拓扑离线 / 下线均不影响其他拓扑:

1. **Tauri 桌面壳** — Rust 进程 spawn 本地 daemon, daemon 内嵌 (embed) 已 build 好的 `frontend-web` 静态资源, webview 加载 `http://127.0.0.1:<port>/?token=<t>`。**Tauri 壳永远不 fetch Cloudflare Pages**, 没有网络也能用, 安装包自带前端 bundle。
2. **浏览器 → 本地 daemon** (S0/S1) — 用户在普通浏览器开 daemon 自带的 `http://127.0.0.1:<port>/`, 拿 daemon 直接 serve 的 SPA。
3. **浏览器 → Cloudflare Pages → 本地 daemon** (S2) — 用户在浏览器开 `https://cc-sm.pages.dev`, Pages 派发同一份 SPA, SPA 在浏览器里 fetch loopback daemon (`http://127.0.0.1:<port>`); Pages 仅是静态资源 CDN, 不参与鉴权也不代理流量。

### 红线 (架构不变量)

- Tauri 壳的 webview URL **必须**是 `http://127.0.0.1:<port>/...`, **不得**指向 `https://cc-sm.pages.dev` 或任何远端 host。
- Tauri 壳的源码 (`packages/frontend-tauri/`) 中**不得**出现 `pages.dev` / `cc-sm` / 远端 fetch 逻辑。CI grep guard 兜底, 见 `.github/workflows/ci.yml`。
- 三种拓扑共用同一份 `frontend-web` 代码, 但分发渠道独立: Tauri 走 embed, S0/S1 走 daemon static, S2 走 Pages。任一渠道更新都不会偷偷把另一条强行切到自己上。

---

## §12 Changelog

- 2026-05-07 初版。web + daemon only, 桌面端 deferred。
- 2026-05-07 §11 Deployment Topologies: Tauri shell guard — 三拓扑独立, Tauri 永不 fetch Pages (Task #711, S2-T10)。
