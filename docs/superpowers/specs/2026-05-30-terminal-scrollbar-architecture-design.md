# 终端滚动条架构级修复设计

日期: 2026-05-30
状态: 待 review

## 1. 问题

右侧 CLI(xterm.js)的滚动条和内容位置「总是不匹配」。表现为:thumb 停在顶部而内容在底部、拖 thumb 内容跳得不对、改字号 / 拖分隔条 / resize 后 thumb 漂移。

### 根因:两个互相手动同步的滚动真相源

xterm.js 把滚动状态存在**两个独立的地方**:

1. **xterm 内部** `buffer.active.viewportY` / `baseY` —— 决定 CanvasAddon 画哪一段 buffer。这是逻辑真相。
2. **`.xterm-viewport` 这个真实 DOM 元素**的 `scrollTop` / `scrollHeight` —— 用户看到并能拖动的那条**原生浏览器滚动条**就长在它上面。

xterm 靠自己的 RenderService 把 (1) 写进 (2) 来「同步」。问题是这个写操作:

- **和尺寸结算有竞态**:cold-start 写完 snapshot、`fit.fit()` 之后立刻 `scrollToBottom()`,此时 `.xterm-viewport` 还没 reflow 到 fit 后的尺寸,`scrollTop` 写入被 clamp 到 0 —— 内容画在底部(对),但原生 thumb 停在顶部(错)。这就是 bug #82。
- **会在 reflow 后漂移**:改字号、resize 触发 xterm 重排,DOM scroll 几何和内部 viewportY 重新错位。

### 至今全是胶水

- `usePtyAttachShell.ts` 里的 rAF defer + 「保险」第二个 rAF(`runColdStartSuffix` 末尾)。
- `tests/terminal/usePtyAttachShell.scrollDefer.test.tsx` 把这个 rAF 调用顺序锁成契约。
- `scripts/dogfood-bug-82-scrollbar.mjs` 探针(其 honesty box 自己承认:加了 fix 能稳定 PASS,但**没 fix 也不能稳定 FAIL** —— 竞态是 sub-frame 的)。

补同步点治不了双真相源。只要原生滚动条还在,它就永远是 xterm 真实状态的滞后影子。

## 2. 方案对比

| 方案 | 改动面 | 风险 | 能根治哪些症状 |
|------|--------|------|----------------|
| **A. 自绘 thumb + 隐藏原生(推荐)** | 隐藏 `.xterm-viewport` 原生滚动条;新增一个 React 组件,直接读 `baseY/viewportY` 算 thumb 几何;拖动调 `scrollToLine`;`onScroll/onLineFeed` 驱动回来。删掉两个 rAF 胶水。 | 低-中。全部基于 xterm 公开 API(已验证 5.5.0 都有)。需要自己实现拖动 / 点击轨道 / 滚轮透传,但都是纯几何。 | 全部。单一真相源 = xterm buffer,thumb 不存在「同步」所以不可能错位。 |
| **B. 让原生滚动条成为唯一真相源** | 反过来:不读 xterm 内部 viewportY,改成监听 `.xterm-viewport` 真实 `scroll` 事件驱动一切。 | 高。要绕开 / 改 xterm 自己的滚动集成,和 CanvasAddon 的内部假设打架,升级 xterm 易碎。 | 全部,但代价是和 xterm 内部耦合更深。 |
| **C. 继续加胶水** | 再加 rAF / ResizeObserver 里补一次 `scrollToBottom`。 | 低,但不根治。 | 临时压住,下个 reflow 路径又复现。已被否决(用户明确要求别再粘胶水)。 |

**选 A。** 唯一真相源是 xterm buffer 的 `baseY/viewportY`;thumb 是这个状态的纯函数投影,没有反向同步,竞态类别整个消失。

## 3. 架构设计(方案 A)

### 数据流

```
xterm buffer (baseY/viewportY/rows)   ← 唯一真相源
        │ onScroll / onLineFeed / onResize / onWrite
        ▼
  useTerminalScroll(sid)   ← 订阅 top shell 的 xterm,读出 {thumbTop, thumbHeight, visible}
        │ React state
        ▼
  <TerminalScrollbar/>     ← 纯展示 + 拖动手柄;拖动/点击 → term.scrollToLine(n)
```

### 几何(纯函数,可单测)

设 `total = baseY + rows`(scrollback 总行 + 一屏),`rows` 为可视行数,`viewportY` 为视口顶行号,轨道像素高 `H`:

```
visible      = baseY > 0                      // 有 scrollback 才显示
thumbHeight  = max(MIN_THUMB, H * rows / total)
thumbTop     = (H - thumbHeight) * viewportY / baseY   // baseY>0 时;否则 0
```

拖动:鼠标 Δpx → `targetViewportY = round(baseY * thumbTop' / (H - thumbHeight))` → `term.scrollToLine(clamp(0, baseY, targetViewportY))`。
点击轨道空白:`term.scrollLines(±rows)`(翻页)。

### 组件边界

- **`src/terminal/useTerminalScroll.ts`** — hook。输入 sid,订阅 `getTopShell().term` 的 `onScroll` + `onLineFeed`(沿用 `useAtBottom` 已验证的事件组合)+ `onResize`,输出 `{visible, thumbTop, thumbHeight, dragTo(px), pageBy(dir)}`。所有几何是上面那组纯函数,单独 export 给单测。
- **`src/components/TerminalScrollbar.tsx`** — 受控展示组件。绝对定位在 `TerminalPane` host 右侧,`pointer-events` 仅落在 thumb / track 上(不挡终端文字)。拖动用 pointer events,`setPointerCapture`。
- **`TerminalPane.tsx`** — 挂载 `<TerminalScrollbar sessionId=.../>`(和现有 `ScrollToBottomButton` 并列);其余不动。
- **`useAtBottom.ts`** — 保留(jump-to-bottom 按钮仍需要),它和新 hook 读同一组事件、同一真相源,天然一致。

### CSS

- `global.css` 把**终端视口**的原生滚动条藏掉:`.xterm-viewport { scrollbar-width: none; }` + `.xterm-viewport::-webkit-scrollbar { display: none; }`(只限定在 `.xterm-viewport`,不动 app 其它地方那条全局 `::-webkit-scrollbar` 样式)。
- 自绘 thumb 复用现有设计 token(`--color-border-subtle/default/strong`),视觉和现在一致。

### 删除的胶水

- `runColdStartSuffix` 末尾的 rAF defer + 第二个保险 rAF → 直接同步 `scrollToBottom()` 即可(原生滚动条已不存在,没有 DOM scrollTop 竞态可言;xterm 内部 viewportY 是同步更新的,thumb 立即跟上)。
- `tests/terminal/usePtyAttachShell.scrollDefer.test.tsx` → 删除(它锁的是即将消失的 rAF 契约)。
- `scripts/dogfood-bug-82-scrollbar.mjs` → 改写成「断言 thumb 几何 = f(viewportY, baseY)」,或直接删(其断言对象 `.xterm-viewport.scrollTop` 已不再是用户可见滚动条)。

## 4. 错误 / 边界处理

- **没有 top shell / term 未就绪**:hook 返回 `visible:false`,不渲染 thumb。
- **alt-buffer(claude TUI 全屏)**:`buffer.active.type === 'alternate'` 时 `baseY` 恒 0、无 scrollback → `visible:false`,滚动条自动隐藏(和终端真实行为一致)。
- **Ctrl+滚轮改字号**:`TerminalPane` 现有 wheel 逻辑不变;改字号后 xterm reflow 触发 `onResize` → hook 重算几何 → thumb 自动归位(不再需要 anchor 那套 best-effort,但那段是改字号定位、和滚动条解耦,本次不动)。

## 5. 测试

- **单元(vitest)**:`useTerminalScroll` 的几何纯函数 —— 顶部 / 底部 / 中部 / `baseY=0` / `MIN_THUMB` 夹取 / 拖动反算 viewportY 的取整。
- **dogfood(Playwright)**:新探针断言「cold-start 后 thumb 在底部」改为读 `__ccsmTerm.buffer.active.viewportY/baseY` 和自绘 thumb 的 `style.top/height`,断言三者满足几何关系。这是**确定性**断言(纯几何,无竞态),比 bug-82 那个「不能稳定 FAIL」的探针强。
- **回归**:`useAtBottom` 既有测试不动;跑 `npm run typecheck && npm run lint && npm test` + harness-ui 全绿后才推(遵守本地 pre-push gate)。

## 6. 明确不做(YAGNI)

- 不做横向滚动条(终端不横向滚)。
- 不做滚动条 hover 自动淡入淡出(现有设计是常驻低对比,保持)。
- 不重构改字号的 anchor 逻辑(和滚动条错位无关)。
- 不碰 app 全局那条 `::-webkit-scrollbar` 样式(其它面板还用)。
```
