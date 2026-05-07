# ccsm-web Roadmap

本文档记录 ccsm-web 当前的鉴权 / 部署演进路线图 (S0 → S5), 描述前端、Tauri 壳、Cloudflare 中间层、本地 daemon 与鉴权方式在每个阶段的形态。

**当前位置**: S0 完工 (wave-1 + wave-2 主线 14/14)。S1 进行中 2/4: PR #36 wave-2.5 已落 Tauri 注入 `CCSM_TOKEN` env + 端口固定 9876; 还差 (a) token 移到 `~/.ccsm/token` (现硬编码), (b) web 前端不再依赖 URL `?token=`。

---

## 阶段 S0 起点 (现状)
- Web 前端: 同源连本地 daemon, token 从 URL 写入 sessionStorage
- Tauri 壳: 同壳 spawn daemon, 端口 0 + 一次性随机 token, stdout 握手
- Cloudflare 中间层: — 不存在
- Daemon (本地): 每次启动随机 mint token, 仅信本地 127.0.0.1
- 鉴权方式: 每实例独立随机 token, 用户手动 / Tauri stdout 传递

## 阶段 S1 本地固定 token
- Web 前端: 读固定 token (打包注入 / 本地配置), 直连 daemon
- Tauri 壳: spawn daemon 时塞 CCSM_TOKEN=<固定值> 环境变量, 端口固定 9876
- Cloudflare 中间层: —
- Daemon (本地): 优先用 CCSM_TOKEN env (代码已支持), 端口固定
- 鉴权方式: 固定共享 token, 写在本地 ~/.ccsm/token (chmod 600)

## 阶段 S2 引入云壳 (但不鉴权云)
- Web 前端: 改部署到 Cloudflare Pages (https://ccsm.pages.dev), 仍直连本地 daemon (http://127.0.0.1:17832)
- Tauri 壳: 同 S1
- Cloudflare 中间层: 仅托管静态资源 (Pages), 不参与鉴权也不代理
- Daemon (本地): 同 S1, 但需放开 CORS / WS Origin 白名单接受 https://ccsm.pages.dev
- 鉴权方式: 仍是固定本地 token

## 阶段 S3 云端代理流量
- Web 前端: 改连 wss://ccsm.pages.dev/ws/<user>, 不再知道本地 daemon 地址
- Tauri 壳: 启动时主动向云注册一条隧道 (Tunnel / Durable Object 长连接), 把本地 daemon 暴露给云
- Cloudflare 中间层: Worker + Durable Object 做 reverse proxy, 把浏览器请求转给对应用户的隧道
- Daemon (本地): 不再监听公网, 只接 Tauri 起的隧道; token 改成隧道层校验
- 鉴权方式: 浏览器 → 云仍用固定 token, 云 → daemon 用隧道内部凭证

## 阶段 S4 云端接 GitHub OAuth
- Web 前端: 跳 Sign in with GitHub → 拿到云端签发的 session cookie / JWT
- Tauri 壳: 启动时也走 GitHub OAuth (device flow), 拿到云端签发的隧道凭证, 用它注册隧道
- Cloudflare 中间层: 新增 GitHub OAuth + 用户 → 隧道映射表; 校验 web 来的 JWT 后路由到该用户的隧道
- Daemon (本地): 不再认 token, 只认隧道层 mTLS / 一次性凭证
- 鉴权方式: GitHub 身份: web 走浏览器 OAuth, Tauri 走 device flow; 云端是唯一信任锚

## 阶段 S5 终态
- Web 前端: 纯 SPA, 只懂 JWT + WS, 不知道 daemon 在哪
- Tauri 壳: 后台守护进程 + 隧道客户端, 启动即注册, 断线重连
- Cloudflare 中间层: 全权: OAuth, 用户↔隧道路由, 速率限制, 审计
- Daemon (本地): 纯本地执行体, 只信任来自隧道的请求, 无独立鉴权
- 鉴权方式: 单一身份源 = GitHub; 凭证生命周期 = OAuth refresh token
