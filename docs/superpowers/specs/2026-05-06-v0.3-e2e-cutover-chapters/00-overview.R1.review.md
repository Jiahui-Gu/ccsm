# R1 review of 00-overview — feature-preservation

Reviewer: R1 (feature-preservation)
Round: 1

## Findings

### P2 — "audit promotes them" 给 scope creep 留了未上锁的口子
**Location**: `00-overview.md` §2 "Out of scope" 第一行 ("deferred to v0.4 unless the audit promotes them")
**Issue**: Out-of-scope 列表用 "unless the audit promotes them" 措辞，等于把所有非目标都允许由后续 audit 升级回 v0.3，但没有定义"audit promote"需要哪一级签字 (manager? user?)。R1 角度下，这是 scope-creep 的法律口子，下游 fixer 看到 audit 章节里有"建议",就可能直接动手。
**Why blocker**: P2 — 不是已发生的 feature drift, 而是流程口子;但 v0.3 既然是 pure refactor, 任何 promotion 都该走 user 签字, 不该让 R1 / R3 reviewer 顺手放进来。
**Suggested fix**: 在 §2 末尾补一句 "Promotion of any out-of-scope item into v0.3 requires explicit user/product approval recorded in the spec; reviewers MAY recommend but MUST NOT promote."

### P2 — §3 iron rule §3.4 把 sigkill-reattach 从"修复"提升为"必修 feature"
**Location**: `00-overview.md` §3 第 4 条 "sigkill-reattach is a v0.3 must-fix"
**Issue**: 这条 iron rule 把 `attach-replay-from-headless-buffer` 的修复升级为 "snapshot/replay UT path itself must land too" — 即不仅恢复 v0.2 行为, 还要新增 UT 路径 (lifecycle.test.ts 的新 case)。如果 v0.2 这条路径本来就是 happy-path-only, 那么"必修 UT path"就是新增 quality bar, 不是恢复, 是 scope creep。
**Why blocker**: P2 — 边界争议;UT 加 case 严格说不改用户行为, 但和 chapter 01 HP-8 ("latent — only one harness case covers this and it currently errors out")、chapter 03 §4 (snapshot TTL=60s 是新引入策略) 合在一起读, 等于在 refactor 里塞进了"reattach 行为标准化"的小 feature work。
**Suggested fix**: §3.4 改写明确范围: "sigkill-reattach 的修复目标 = 恢复 v0.2 行为 (任何 v0.2 已观察到的 reattach 路径必须继续工作); 新增的 snapshot TTL / cwd-mismatch 语义不在 v0.3, defer 到 v0.4。"
