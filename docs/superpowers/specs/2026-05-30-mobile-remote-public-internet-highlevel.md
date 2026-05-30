# Mobile Remote 公网直连 — High-Level 设计(冻结)

> 这是**唯一**的 high-level 文档。除本文件描述的三角色拓扑外,其余一切
> (组件接口、消息格式、握手时序、错误/回退、安全、测试)都属于 mid-level
> 或 detail-level,放在 HTML 设计文档里。本文件存在的目的:防止后续会话再把
> 目标退化成 LAN。
>
> 用户裁定(2026-05-30):「除了这个都不是 high level 了,都是 mid level 或者
> detail level。以这个为 high level 来做。」

## 目标

手机从**任意网络**(4G / 外网 / 不同 WiFi)连回桌面端跑着的 ccsm,**不是局域网**。
参考 Tailscale 思路:**中间件只做握手,数据走直连。**

## 三个角色

1. **桌面端(Electron 主进程)** —— WebRTC 的一个 peer,持有真正的 PTY 会话。
   引入 werift(纯 TS,无原生编译)建立 DataChannel。
2. **手机端(浏览器 PWA)** —— 另一个 WebRTC peer,用浏览器原生
   `RTCPeerConnection`。**推翻**现有 WebSocket 客户端,改用 DataChannel。
3. **Cloudflare 中间件(Worker + Durable Object)** —— **只做两件事**:
   GitHub 鉴权 + 信令撮合(交换 SDP/ICE)。**握手完就退场,终端数据一个
   字节都不经过它。**

## 拓扑

```
桌面端 Electron                Cloudflare 中间件              手机端 PWA
[PTY] --- [werift Peer]        [Worker: GitHub 鉴权]        [RTCPeerConnection] --- [xterm]
     |                         [Durable Object: 配对/信令]            |
     |  1. 登录 + 注册信令 ------------> CF <------------ 1. 登录 + 发起信令  |
     |                                                                       |
     |================ 2. WebRTC P2P 直连(终端数据,CF 看不到)============|
     |  3. 打洞失败 → 回退 TURN 中继(类比 Tailscale 的 DERP)              |
```

一句话:Cloudflare 是"婚介所"——只负责让两端认识、交换地址;认识完两端直接
私奔(P2P 直连),婚介所看不到之后说的话。少数 NAT 打不通时回退 TURN。

## 关键裁定(已与用户对齐)

| 决策 | 选定 |
|---|---|
| 手机端形态 | 浏览器 PWA(可推翻现有实现),改 WebRTC DataChannel |
| 直连机制 | WebRTC P2P + STUN 打洞,TURN 兜底 |
| 中间件 | Cloudflare Worker + Durable Object,只握手不碰数据;TURN 用 Cloudflare TURN |
| GitHub 鉴权 | 同一 GitHub 账号登录两端即配对 |
| 桌面 WebRTC 库 | werift(纯 TS,不进 postinstall 原生重建) |
| 上层协议 | 复用现有 `sessions.list` / `session.snapshot` / `session.input` / `session.resize` / `pty.data`,只换管道(WS → DataChannel) |

## 与现状的关系

- 现有 `electron/remote/mobileRemoteServer.ts`(HTTP+WS,LAN-only)被取代。
- 但其**上层协议层**(`remoteMessages.ts` 消息处理、`pty.data` 扇出、session
  列表轮询)几乎原样复用,只是底层管道从 WS socket 换成 WebRTC DataChannel。

## 不可退化约束

任何后续会话:mobile-remote 的目标**默认是公网**,不是 LAN。提到"两端如何知道
对方地址"时,答案是**经 Cloudflare 信令交换 + WebRTC 打洞**,不是屏幕显示 LAN IP。
见 memory `project_mobile_remote_public_internet.md`。
