---
status: draft
date: 2026-05-06
task: "#645"
pr: TBD
---

# PTY + session 子系统重设计 (从头做)

> Single-file design spec. Manager + user 一次读完拍板派 dev 实现。
> 不走 spec-pipeline 多 chapter 拆分。

## 1. Overview / Goals

### 1.1 一句话 problem statement

黑屏 bug (new session → terminal 一直黑屏 / claude prompt 不显) 的 root cause 不是单点 fix 能盖住的: preload bridge `electron/preload/bridges/ccsmPty.ts` 跟类型契约 `src/pty.d.ts` 在 W2-B 搬迁 (`b2300c28`) 之后 5 处错位**, **renderer 自己 mint sid 后用 lazy spawn-on-attach-null 推 daemon 起 PTY**, daemon 在 attach 之前压根不知道 session 存在。整条链条没有"谁拥有 session lifecycle"的明确答案, 任何一处类型 / 时序漂移就黑屏。

### 1.2 目标

| # | Goal | Why |
|---|------|-----|
| G1 | Daemon 是 session lifecycle 的 owner | 解决"renderer mint sid + lazy spawn"导致的状态分裂 / 多窗口 / crash recovery 难做 |
| G2 | 单源类型契约: daemon export → preload import → renderer 类型一致 | 消除 W2-B 那种 5 处类型错位再也不能发生; CI 编译期 catch |
| G3 | API 改成 session-shaped (不是 PTY-shaped): `POST /api/session/create` 替代 `POST /api/pty/spawn` | API 路径反映真实领域概念; "PTY" 是实现细节 |
| G4 | Renderer 退化为 view: 不持 PTY 状态 source-of-truth, 只订 SSE + render | 状态单源 = daemon, renderer 重启 / 多窗口都能从 SSE 重建 |
| G5 | 黑屏 bug 复现场景在 e2e 守住不再退步 | 回归保护 |

### 1.3 非目标

- **不动 daemon 内部 ptyHost**: `entryFactory` / xtermHeadless / claude.exe spawn 链 / serializeAddon snapshot 算法都保留 (本 spec 只重设计 API + lifecycle owner, 不重设计 PTY 实现)。
- **不统一全局 daemon error envelope**: P0-1 in `project_v0_3_architecture_audit_2026_05_06.md`, 另算。本 spec 只在新 `/api/session/*` 内部用统一 `{ok:true,...}|{ok:false, error}`, 不强行扩到 `/api/data/*` `/api/health/*` 等老路由。
- **不动 thin/fat session 拆分** (Task #594), 也不改 SDK driver 与 PTY 的关系。
- **不改 Claude SDK transcript JSONL 格式 / sid 形状**: 仍用 v4 UUID, 仍由调用方 (现 renderer, 后 daemon) 决定 sid 字面值, 这样 `~/.claude/projects/<project>/<sid>.jsonl` 路径不变。

### 1.4 用户拍板

> "从头做不考虑沉没成本。" — 激进直删旧 PTY-level API, **不留 backward-compat shim**。

PR 之间允许整体 broken (新旧 API 混存断 5-30 min), ship 时整体 working。dev 不用为 mid-merge 状态写 fallback。

---

## 2. Current state & debt

### 2.1 类型契约 5 处错位 (W2-B 搬迁 `b2300c28` 后)

锚点 = `src/pty.d.ts` 与 `electron/preload/bridges/ccsmPty.ts` (W2-B 实际代码)。

| # | API | 类型 (`src/pty.d.ts`) | 实现 (`electron/preload/bridges/ccsmPty.ts`) | 后果 |
|---|-----|----------------------|---------------------------------------------|------|
| D1 | `pty.spawn` | `(sid: string, cwd: string)` (`pty.d.ts:64`) | `(opts: {sid, cwd})` (`ccsmPty.ts:227`) | renderer 调位置参数 → daemon 收到 `{0:"sid-uuid", 1:"/cwd"}` payload, 走 spawn 失败路径 |
| D2 | `pty.attach` | `Promise<AttachResult \| null>` (`pty.d.ts:65`) | `Promise<{ok:true, attach: ... \| null}>` (`ccsmPty.ts:229`) | renderer 拿到 `{ok:true, attach:...}` 当 `AttachResult` 用 → `res.snapshot` 是 `undefined` |
| D3 | `pty.onData` | `(cb: (e: PtyDataEvent) => void)` (`pty.d.ts:73`) | `(sid, cb: (data: string) => void)` (`ccsmPty.ts:248`) | 类型推断 cb 收 object, 实际收 string; renderer 写 `e.chunk` → undefined |
| D4 | `pty.onExit` | `(cb: (e: PtyExitEvent) => void)` (`pty.d.ts:74`) | `(sid, cb: (code: number\|null) => void)` (`ccsmPty.ts:250`) | 同 D3, classifier 拿到 `undefined` 没法判 clean vs crashed |
| D5 | `pty.getBufferSnapshot` | `Promise<BufferSnapshotResult>` (i.e. `{snapshot, seq}`) (`pty.d.ts:72`) | `Promise<string>` (`ccsmPty.ts:243`) | renderer 拿不到 `seq`, L4 PR-B (`#865`) 设计的 atomic seq 守恒被打穿 |

5 处都是编译期可 catch 的, 但因为 `src/pty.d.ts` 是手写 ambient, daemon export 没参与编译, 所以飘了也不报错。

### 2.2 Lifecycle 架构债

| # | Anchor | Debt |
|---|--------|------|
| L1 | `src/stores/slices/sessionCrudSlice.ts:51-65` (`newSessionId()`) + `:167` (`const id = newSessionId()`) | renderer mint sid, 没 `session:create` RPC, daemon 直到 attach 才知道这个 sid 存在 |
| L2 | `src/terminal/usePtyAttach.ts:198-220` | "spawn-on-attach-null" lazy 路径: attach 返回 null → renderer 主动调 `pty.spawn(sid, cwd)` 让 daemon 起 PTY → 再 attach。多窗口 / 自动复活时哪个 renderer 先 attach 哪个负责 spawn, race 不可解 |
| L3 | `daemon/api/pty.ts:299-307` | API 路径全是 `/api/pty/*`, 反映"renderer 视角的 PTY 操作", 不是"daemon owns session lifecycle" |
| L4 | `src/components/sidebar/NewSessionButton.tsx:30` 触发 → store.createSession → 仅本地添 sessions[], 不通知 daemon | 用户点 "New session" 那一刻 daemon 完全不知情, 一直等到 `<TerminalPane>` mount 才有人调 attach |
| L5 | session 状态 source-of-truth 飘在 renderer store (`session.state: 'idle' \| ...`) | daemon 只知道"这个 sid 有没有 PTY entry", 不知道用户对 session 的认知。renderer 重启 / 多窗口 / bot driver 没法对齐 |

### 2.3 影响范围

- 黑屏 bug (Task #639 紧急 patch 已 ship 一个 startup hard-fail 兜底, 但 root cause 没修)
- 多窗口 (#XXX 长期 backlog) 走不动
- crash recovery: daemon 重启后 renderer 没法恢复 session
- bot driver / headless: 没 daemon-owned session 概念就没法跑无 renderer 的 ccsm

---

## 3. Target API

### 3.1 路由表

```
POST   /api/session/create               body: { cwd?, hint? }
                                         → { ok:true, sid, status:'starting', cwd }
                                         → { ok:false, error }

GET    /api/session/list                 → { ok:true, sessions: SessionInfo[] }

GET    /api/session/:sid                 → { ok:true, session: SessionInfo }
                                         → { ok:false, error: 'not_found' }

POST   /api/session/:sid/input           body: { data }
                                         → { ok:true } | { ok:false, error }

POST   /api/session/:sid/resize          body: { cols, rows }
                                         → { ok:true } | { ok:false, error }

POST   /api/session/:sid/kill            → { ok:true, killed:boolean }
                                         → { ok:false, error }

GET    /api/session/:sid/snapshot        → { ok:true, snapshot:string, seq:number }
                                         → { ok:false, error }

POST   /api/session/:sid/attach          body: { subscriberId }
                                         → { ok:true, snapshot, seq, cols, rows, pid }
                                         → { ok:false, error }

POST   /api/session/:sid/detach          body: { subscriberId }
                                         → { ok:true } | { ok:false, error }

GET    /api/session/checkClaudeAvailable?force=1
                                         → { ok:true, available:true, path }
                                         → { ok:true, available:false, reason? }

SSE    /api/events?sid=<sid>             复用现有 channel, multi-sub OK
                                         events: session:status / pty:data / pty:exit / pty:ack
```

设计点:

- **`create` 是"daemon mint sid + 起 starting 状态"**, **不**起 PTY。PTY 在第一次 `attach` 才起。这样多 renderer 同时 attach 不 race, 也允许 "create now / open terminal later" workflow (e.g. bot driver 创建 session 但没 UI)。
- **`attach` 仍存在**, 但语义变成"开始接收 SSE + 拿 replay snapshot", 不再是"如果不存在就给我 spawn"。spawn 由 daemon 在 `create` 之后由 lifecycle 决定何时拉起 (默认: 第一次 `attach` 时)。
- **`subscriberId`** 由 renderer 生成 (e.g. webContents id + UUID), 给 daemon 做 attached set 引用计数, 跟既有 `daemon/api/pty.ts` 的 `subscriberId` 语义一致。
- **REST shape**: 资源化 `:sid`, 不再用 body 带 sid。create 是 collection-level, 其他都是 resource-level。
- **GET vs POST**: 只读 (list / get / snapshot) 用 GET; 状态变更用 POST。snapshot 标 GET 是因为它幂等, 但 `seq` 会随每次 read 推进 — 仍幂等 (read-only on caller's view), seq 是 server-side 时刻戳。

### 3.2 Error envelope

新 `/api/session/*` 全部统一:

```ts
type ApiResult<T> = ({ ok: true } & T) | { ok: false; error: string; code?: string };
```

`error` 是人读字符串, `code` 可选机读 token (e.g. `not_found` / `already_killed` / `pty_spawn_failed`)。Daemon 端在 `daemon/api/session/errors.ts` 维护 token 枚举, 上头 §4 type contract 一并 export。

### 3.3 SessionInfo / status 状态机

```ts
export type SessionStatus =
  | 'starting'    // create 已返回, PTY 还没 spawn (无 attach)
  | 'ready'       // PTY 已 spawn, 等 first input / claude bootstrap
  | 'running'     // PTY active, 正在跑 claude
  | 'exited'      // claude 进程 clean exit (code 0, no signal)
  | 'killed'      // 用户主动 kill / 被 daemon kill
  | 'failed';     // spawn 失败 / claude crash / SDK 报错

export interface SessionInfo {
  sid: string;
  cwd: string;
  status: SessionStatus;
  pid: number | null;            // null while starting / failed
  cols: number;
  rows: number;
  claudeSid: string | null;      // SDK-reported session id (Task #736 backfill)
  createdAt: number;             // ms epoch
  exitedAt: number | null;
  exitCode: number | null;
  exitSignal: number | null;
}
```

State diagram:

```
   create
     │
     ▼
 ┌─────────┐  attach (first)   ┌───────┐  first claude output  ┌────────┐
 │starting │──────────────────▶│ ready │─────────────────────▶│running │
 └─────────┘                    └───┬───┘                      └────┬───┘
      │                             │                               │
      │ spawn fail                  │ spawn fail                    │
      ▼                             ▼                               │
   failed ◀──────────────────── failed                              │
                                                                    │
              kill ───────────────────────────────────────▶ killed  │
                                                                    │
              claude exit code 0, no signal ──────────────▶ exited ◀┘
              claude exit non-0 / signal     ──────────────▶ failed
```

终态: `exited` / `killed` / `failed` (entry 保留 N 秒供最后一次 snapshot 拉取, 然后 GC; 由 daemon 决定, renderer 不参与)。

### 3.4 SSE 事件类型

复用现有 `/api/events?sid=<sid>` channel (现 `/api/events/pty?sid=<sid>` 路径), 重命名为 `/api/events?sid=<sid>` 表领域不只是 PTY:

| event | data |
|-------|------|
| `session:status` | `{ sid, status: SessionStatus, pid?, exitCode?, exitSignal? }` |
| `pty:data` | `{ chunk: string, seq: number }` (沿用现 `PtyDataEvent`) |
| `pty:exit` | `{ code: number\|null, signal: number\|null }` (沿用现 `PtyExitEvent`) |
| `pty:ack` | `{ seq: number }` (back-pressure, 沿用) |

`session:status` 是新增的 — 让 renderer 不用拿 `session.state` 当 source-of-truth。Daemon 每次状态机转移 broadcast 一次。

### 3.5 旧 API 全删 (无 shim)

`daemon/api/pty.ts:299-307` 注册的 9 条全删:

```
POST /api/pty/spawn                  → 由 /api/session/create + auto-spawn-on-attach 替代
POST /api/pty/attach                 → /api/session/:sid/attach
POST /api/pty/detach                 → /api/session/:sid/detach
POST /api/pty/get                    → GET /api/session/:sid
POST /api/pty/list                   → GET /api/session/list
POST /api/pty/input                  → POST /api/session/:sid/input
POST /api/pty/resize                 → POST /api/session/:sid/resize
POST /api/pty/kill                   → POST /api/session/:sid/kill
POST /api/pty/checkClaudeAvailable   → GET  /api/session/checkClaudeAvailable
POST /api/pty/getBufferSnapshot      → GET  /api/session/:sid/snapshot
```

`SSE /api/events/pty?sid=...` 也改成 `/api/events?sid=...` (路径迁移, payload 同)。

---

## 4. Type contract — single source

### 4.1 SSOT 位置

新建 `daemon/api/session/types.ts`:

```ts
export type SessionStatus = ...;
export interface SessionInfo { ... }
export interface CreateSessionRequest { cwd?: string; hint?: string }
export interface CreateSessionResponse { sid: string; status: SessionStatus; cwd: string }
export interface AttachResponse { snapshot: string; seq: number; cols: number; rows: number; pid: number }
export interface InputRequest { data: string }
export interface ResizeRequest { cols: number; rows: number }
export interface SnapshotResponse { snapshot: string; seq: number }
export interface PtyDataEvent { chunk: string; seq: number }
export interface PtyExitEvent { code: number | null; signal: number | null }
export interface PtyAckEvent { seq: number }
export interface SessionStatusEvent { sid: string; status: SessionStatus; pid?: number; exitCode?: number | null; exitSignal?: number | null }
export type ApiResult<T> = ({ ok: true } & T) | { ok: false; error: string; code?: string };
```

### 4.2 跨进程导入

Renderer / preload 通过 tsconfig path alias 或 monorepo workspace import 同一份 `daemon/api/session/types.ts`:

```jsonc
// tsconfig.json (root)
{
  "compilerOptions": {
    "paths": {
      "@ccsm/api-types": ["./daemon/api/session/types.ts"]
    }
  }
}
```

Preload bridge `electron/preload/bridges/ccsmPty.ts` 改名为 `ccsmSession.ts`, 类型签名直接 `import type { SessionInfo, AttachResponse, ... } from '@ccsm/api-types'`。

### 4.3 删旧定义

- 删 `src/pty.d.ts` 整个文件 (合并到 ambient `src/ccsmSession.d.ts`, 仅保留 `declare global { interface Window { ccsmSession: CcsmSessionApi } }`)。
- 删 preload `interface SpawnInfo / AttachOk / SimpleOk / ListResp / GetResp / KillResp / SnapResp / ClaudeResp` 本地重定义 (`ccsmPty.ts:193-220`), 全 import from `@ccsm/api-types`。

### 4.4 Contract test

新增 `daemon/api/session/__tests__/contract.spec.ts`:

```ts
// 编译期断言: preload 导入的类型 === daemon export
import type * as Daemon from '../../../../daemon/api/session/types';
import type * as Preload from '@ccsm/api-types';

type AssertEqual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const _check: AssertEqual<Daemon.SessionInfo, Preload.SessionInfo> = true;
// ... 每个 export 一行
```

外加 runtime contract: vitest 跑一遍 `POST /api/session/create` 拿真 response, 用 zod / valibot schema 校验 shape — 如果 daemon handler 漂移而 type 没更新, 这个测试 catch。

---

## 5. Renderer changes

### 5.1 Store: 删 sid mint

`src/stores/slices/sessionCrudSlice.ts`:

- 删 `newSessionId()` (`:51-65`)。
- `createSession` (`:143-`) 改 async: 调 `await window.ccsmSession.create({ cwd })` 拿 `{ sid, status, cwd }`, 再 `set` 添 sessions[]。
- `session.state` 字段保留但语义改成"renderer-side optimistic mirror", source-of-truth 是 daemon `session:status` SSE。

API 兼容点: `createSession` 现在签名是 `(cwdOrOpts?) => Promise<string>` (返回 sid), 调用点 (`NewSessionButton.tsx:30`) 跟着改成 await。

### 5.2 Hook: 删 spawn-on-attach-null

`src/terminal/usePtyAttach.ts:198-220`:

- 删 `if (!res) { spawn(...); attach again }` 整个 fallback。
- attach 之前 daemon 必有 session (因为 `createSession` 先 RPC 起了)。
- 如果 attach 仍返 `not_found`, 是 daemon 真的丢了 (e.g. crash recovery), 渲染 error overlay + "session lost" 文案 + Retry (Retry 跑一次 `recreate` flow 在 v0.4 处理, 本 spec 内 Retry 行为 = error → 用户手动删 session 重建)。

### 5.3 接 SSE session:status

新 hook `src/terminal/useSessionStatus.ts`:

```ts
export function useSessionStatus(sid: string | null): SessionStatus | null {
  // EventSource('/api/events?sid='+sid) → 'session:status' → setState
}
```

`session.state` 由这个 hook 喂值, store 上的 `_apply*` runtime mutators (`sessionRuntimeSlice`) 改成被 SSE 驱动而不是被 PTY direct callback 驱动。

### 5.4 NewSessionButton 流

```
User click "New session"
  ↓
NewSessionButton onClick
  ↓
store.createSession(cwd)  ──▶  POST /api/session/create  ──▶  daemon mint sid, store entry { status: 'starting' }
  ↓                                                  ◀── { ok:true, sid, status:'starting' }
store: sessions.unshift({ id: sid, ... }), activeId=sid
  ↓
TerminalPane mounts (sessionId=sid)
  ↓
usePtyAttach effect: pty=window.ccsmSession; await pty.attach(sid, subscriberId)
  ↓
daemon: status === 'starting' → spawn PTY → status='ready' → broadcast session:status
        return { snapshot:'', seq:0, cols, rows, pid }
  ↓
renderer: write empty snapshot, install onData, fit, focus
  ↓
claude 启动后 PTY 出第一笔 data → SSE pty:data → renderer write → 用户看到 prompt
```

无 race: daemon 是单线程 event loop, `create` → store entry 一定在 `attach` 之前可见。

### 5.5 受影响文件清单

| File | 改动 |
|------|------|
| `electron/preload/bridges/ccsmPty.ts` → 改名 `ccsmSession.ts` | 全重写: 删旧 9 个 method, 加新 9 个; types 全 import from `@ccsm/api-types`; SSE 路径改 `/api/events?sid=` |
| `src/pty.d.ts` | 删除整个文件 |
| `src/ccsmSession.d.ts` | 新增, 仅 `declare global { interface Window { ccsmSession: CcsmSessionApi } }` |
| `src/stores/slices/sessionCrudSlice.ts:51-65,143-200` | 删 `newSessionId`, `createSession` 改 async + RPC |
| `src/stores/slices/sessionRuntimeSlice.ts` | runtime mutators 改成被 SSE `session:status` 驱动 |
| `src/terminal/usePtyAttach.ts:198-220` | 删 spawn-on-attach-null fallback |
| `src/terminal/useSessionStatus.ts` (new) | SSE session:status hook |
| `src/components/sidebar/NewSessionButton.tsx:30` | onClick 改 async; await store.createSession 拿 sid 后才 setActive |
| `src/terminal/TerminalPane.tsx` (调用点) | 适配 createSession async |
| Test fixtures `harness-*` / `probe-e2e-*` | 之前 mock `pty.spawn` 的改 mock `session/create` |

---

## 6. State machine & SSE

详见 §3.3 状态机 + §3.4 事件表。要点:

1. **Daemon 是 owner**: 状态机所有转移由 daemon 触发, 通过 `session:status` SSE push。Renderer 不写 status, 只读。
2. **Renderer optimistic UI 仍允许**: 用户点 kill, renderer 可以即刻把 sidebar 转灰, 但最终状态等 daemon `session:status: killed` 确认。如果 daemon 回 `ok:false`, renderer 回退 optimistic state。
3. **SSE 是唯一 push channel**: 不再有 ad-hoc IPC。所有跨进程 push 走 `/api/events?sid=...`。多窗口直接多个 EventSource 订同一 sid。
4. **断流恢复**: EventSource 自动重连, daemon 端 keep-alive, 重连后 daemon broadcast 一次 `session:status` 当前态让 renderer 对齐。无 SSE replay log (本 spec 不引入), 重连期间错过的 `pty:data` 由 reattach 时的 snapshot 兜底 (renderer 收到 `session:status` 重连 OK 后调一次 `GET /api/session/:sid/snapshot` 重写 visible buffer)。

---

## 7. E2E & test plan

### 7.1 黑屏 bug 复现 (必须红 → 绿)

新 e2e probe 塞已有 `harness-ui` (按 dev.md §2 优先复用):

```
test: 'new session shows claude prompt within 5s'
  1. launch electron
  2. wait sidebar ready
  3. click "New session" → wait sid in store
  4. wait TerminalPane mount
  5. assert: 5s 内 xterm content 包含 'claude' (case-insensitive) 或非空
  6. assert: session.status === 'running' via SSE event log
```

**先复现红**: 在 `b2300c28` HEAD 跑这个 case 必失败 (黑屏)。然后实施 PR T1-T6 后必绿。reverse-verify 写 PR body。

### 7.2 契约 test

- §4.4 编译期 + runtime schema test。
- `npm run typecheck` 必须 catch type drift; CI matrix 三平台跑 contract spec。

### 7.3 既有 sigkill-reattach 不退步

- `test/integration/sigkill-reattach.spec.ts` (v0.3) 现验"daemon 重启后 renderer reattach 拿到 snapshot"。
- 新 API 下: renderer 先 `GET /api/session/list` 拿活的 sessions, 然后 `attach` 每条。daemon 重启时 entry 丢了 → list 返空 → renderer 走 "session lost" overlay (v0.4 再做 daemon 端 entry persist)。
- 这个测试改 expectation: 不再期待"daemon 重启后还能拿 snapshot", 改成"daemon 重启后 renderer 优雅显 lost 而不是黑屏 / crash"。

### 7.4 多 subscriber

新 e2e `multi-subscriber-attach`:
- 同一个 sid, 两个 EventSource 订阅, 一个 `pty.input`, 两个都收到对应的 `pty:data`。
- 给 v0.4 多窗口铺路。

---

## 8. PR slicing & rollout

PR 之间允许整体 broken (用户接受激进直删)。

| PR | Scope | Files (估) | Purpose |
|----|-------|----------|---------|
| **T1** | Daemon types SSOT + new session router stub | `daemon/api/session/types.ts`, `daemon/api/session/index.ts` (new), `daemon/api/session/errors.ts`, `tsconfig.json` paths | 落 §4 SSOT + 空 handler 占路由表; daemon 启动后 `/api/session/*` 200 但内部 noop |
| **T2** | Daemon session lifecycle owner: state machine + entry registry | `daemon/session/registry.ts` (new), `daemon/session/lifecycle.ts` (new), `daemon/api/session/handlers.ts` | 实现 §3.3 状态机, create/attach/input/... 真接 ptyHost; 写 unit test |
| **T3** | SSE `session:status` + `/api/events?sid=` 路径迁移 | `daemon/api/events.ts`, `daemon/sse/router.ts` | broadcast 状态机转移; 旧 `/api/events/pty` 也删 |
| **T4** | Preload bridge 重写 + 删 `src/pty.d.ts` | `electron/preload/bridges/ccsmSession.ts` (new, replaces `ccsmPty.ts`), `src/ccsmSession.d.ts` (new), `src/pty.d.ts` (delete), preload index | 类型契约 SSOT 跨进程生效 |
| **T5** | Renderer 调用点切 | `src/stores/slices/sessionCrudSlice.ts`, `src/stores/slices/sessionRuntimeSlice.ts`, `src/terminal/usePtyAttach.ts`, `src/terminal/useSessionStatus.ts` (new), `src/components/sidebar/NewSessionButton.tsx`, `src/terminal/TerminalPane.tsx` | renderer 走新 API; 黑屏 bug e2e 转绿 |
| **T6** | 删旧 `/api/pty/*` 路由 + 旧 preload glue + 旧 mock fixtures | `daemon/api/pty.ts` (delete), `daemon/api/index.ts` (unregister), test harness mocks | 清债 |

PR 顺序串行 (T1→T6), 每个 PR 各自 reviewer + ci 全绿后 merge。**T2 之后 daemon 双跑新旧 API 一段时间**, T6 才彻底删旧。Renderer 在 T5 一次切, 不做 feature flag。

每 PR 大约 file count 范围 5-15, 单 dev 一天可做完。manager 派单时按 T1...T6 顺序。

---

## 9. Risks / out of scope

### 9.1 Risks

| Risk | Mitigation |
|------|----------|
| T2-T5 之间 daemon 路由半 ready, renderer 仍走旧 API → 整体 broken | 接受 (用户拍板); manager 不在此期间 ship release |
| `tsconfig` paths cross daemon ↔ renderer 编译可能踩 ESM/CJS interop | T1 立刻 smoke test: `npm run build:electron && require('./dist/...')` 两边都 import 同一份 `types.ts` 实测 |
| daemon `entry registry` 如果用 in-memory Map, daemon 重启后 session 丢 | v0.3 接受 (renderer 显 "session lost"), v0.4 上 SQLite persist |
| SSE 事件名重命名 (`/api/events/pty` → `/api/events`) 漏改某处 | grep `events/pty` 全 codebase, T3 PR body 列清单 |
| `session:status: starting` → `ready` 时序漏 broadcast 导致 renderer 永远 attaching | T2 unit test 每个状态机转移强制断言 broadcast 调用次数 |

### 9.2 Out of scope (引用而非展开)

- **Daemon 全局 error envelope 统一**: P0-1 in `project_v0_3_architecture_audit_2026_05_06.md`, 另立 task。本 spec 只在 `/api/session/*` 内统一。
- **Thin/fat session 拆分** (#594): SDK driver 与 PTY 关系不动。
- **多窗口**: daemon-own-session 是前置条件, 多窗口的 store 同步 / focus 仲裁是另立 spec。本 spec 只确保新 API 设计**不阻碍**多窗口 (multi-subscriber 7.4 守住)。
- **Crash recovery / daemon restart 后 entry persist**: v0.4 candidate, SQLite-backed registry, 本 spec 仅 in-memory。
- **Bot driver / headless ccsm**: daemon-own-session 后天然支持 (bot 直接调 `/api/session/create + input + 订 SSE`), 但本 spec 不实现 bot binary。
- **`createSession` async 化对其他调用点的连锁影响** (e.g. CLI deeplink 启动 / restore session): T5 PR 内做, 但 spec 不展开每个 call site 的 await 改法 — dev 实现时 grep `createSession(` 处理。

### 9.3 决策记录 (供 manager review)

| # | Decision | Why | 可争论点 |
|---|----------|-----|---------|
| K1 | `/api/session/create` 不起 PTY, 第一次 `attach` 才起 | 多 renderer / "create-now-open-later" / bot driver 都不 race | 也可在 `create` 立刻起 — 但那样 bot driver 必须 attach 才不浪费 PTY |
| K2 | 删 `src/pty.d.ts` + tsconfig paths SSOT | 编译期 catch 漂移 | 也可走 codegen (zod schema → ts), 重 |
| K3 | SSE 路径 `/api/events?sid=` 而不是 `/api/sessions/:sid/events` | 现有 `daemon/api/events.ts` 已是 multiplexer, 改最小 | resource-style 更 REST, 但拆 dispatcher 改动大 |
| K4 | `session.status` 单独事件, 不塞 `pty:data` payload | 状态变化频率远低于 data, 单独事件让 subscriber 选订 | data 可以扛 status hint, 但语义混 |
| K5 | 旧 API 直删, 不留 shim | 用户拍板 | 留 shim 可减小 broken window 但增加技术债 |
| K6 | T5 一次切 renderer, 不做 feature flag | flag 在 v0.3 阶段成本 > 收益 | flag 可让 T5 拆 multiple PRs, 但 dev 得维护双路径 |
