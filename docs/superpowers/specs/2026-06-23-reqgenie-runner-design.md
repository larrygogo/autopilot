# ReqGenie 自托管 Runner 设计

> autopilot 作为 reqgenie 的客户端执行器（self-hosted runner），仿 GitHub Actions runner 模型。
> 日期：2026-06-23 · 状态：设计待审 · **rev2（已纳入对抗性审查，见 §12）**

## 1. 背景

### 1.1 reqgenie 现状
ReqGenie 是团队的 AI 驱动需求管理系统（Rust + Axum + PostgreSQL 后端、React 前端、飞书集成、K8s 部署）。它已有一套「AI 自动开发编排」：

- **`dev_sessions`**：双轴状态机（阶段 `clarify→spec→eng_review→ui_review→dev→pr→done` × 运行态 `running/waiting_input/waiting_gate/...`），事件溯源（`dev_session_events`，**seq 由后端 advisory 锁定序、是唯一事实源**），关卡人审（`dev_session_gates`），飞书澄清，多仓（`dev_session_repos`）。
- **执行器 = `agent-worker`**：Node `.mjs`，**集中托管在 reqgenie 自己的 k8s 集群里**的常驻 Deployment。后端 `POST http://worker:8900/sessions` push 派发 → worker pull 事件流当事实源、回写事件、30s 心跳、按需取 git token（GitHub App installation token，**按仓收窄**）、跑 `codex exec`。
- `dev_sessions.agent_backend` 字段（`codex`/`claude_code`/`opencode`）= 执行后端本就设计成可插拔，但全是「集中托管」。

**关键缺口**：reqgenie 的 AI 开发只落地到 **Phase 1（只读，只产 spec）**。写代码 / 出 PR 是 Phase 2/3，**未实现**。且没有「自托管 / 跑在用户机器上的 runner」概念。

### 1.2 autopilot 现状
autopilot 是需求驱动的多阶段任务编排引擎（Bun + TypeScript）。本地 daemon + 多客户端（Web/CLI/TUI）。具备 reqgenie 缺的那一半：需求 → 澄清 → 调度 → sandbox 独立 clone → AI 开发 → 出 PR → pr-poller 监听 PR → CHANGES_REQUESTED/CI 失败自动转 fix 回路。源仓库零痕迹、交付规范分支 `feat/<需求>` + PR。**需求状态机是 `awaiting_review ⇄ fix_revision → done`（双向）**；fix/重跑会换 task_id（`requirement.task_id` 指向新 run）。

### 1.3 目标
让 autopilot 作为**自托管 runner 注册到 reqgenie**，reqgenie 把需求**定向下发到指定机器**，autopilot 用自己的全套管线执行、把结果**回写**reqgenie。本质：**autopilot 补上 reqgenie 没做的「写代码 → 出 PR」那一半**，且执行下放到用户自己的机器。

## 2. 核心决策（已与用户对齐）

| 编号 | 决策 | 说明 |
|------|------|------|
| **D1 角色** | autopilot = 执行大脑 | reqgenie = 需求池 + 下发 + 人工验收 + 展示；autopilot = 澄清(可选)/调度/执行/PR/fix 全生命周期。 |
| **D2 机制** | 注册 → 定向下发到指定机器 → 回写 | 标准 GitHub self-hosted runner 三件套。 |
| **D3 传输** | 长轮询派发 + 独立 HTTPS 回写 | 照抄 GitHub。派发走长轮询通道，状态/PR 回写走**独立** HTTPS POST。WebSocket = 二期。 |
| **D4 reqgenie 侧** | 新开「external runner」轻通道 | **不复用** dev_sessions/agent-worker。现有集中式 codex worker 原样保留。**但两条通道在需求维度互斥**（§5.5，防双跑）。 |
| **D5 交接点** | 整包下发，autopilot 默认不重复澄清 | reqgenie 下发需求内容（description + organized_content + 可选 spec），autopilot 直接 `create→setWorkspaces→enqueue`（**跳过 clarifying 合法**，前置由 enqueue 闸门保证，见 §6.5）。「需要澄清回写」= 二期。 |
| **D6 git/AI 凭证** | 用 runner 本机自己的凭证 | runner 用本机 `gh`/git 与 AI provider 凭证；reqgenie **只传 repo URL/元数据，不下放 token**。⚠ **前置约束**：本机 gh 账号须对下发仓库集合有 read+push 权限（§8.4 + doctor 探测），否则私有组织仓会失败——这是相对 reqgenie installation-token 的退化点，靠前置检查兜。 |
| **D7 交付与 fix** | MVP 走 PR；fix 回路 autopilot 内部自管 | autopilot pr-poller + fix-revision-runner 直接盯自己的 PR 自动 fix，reqgenie 只观察。artifacts 交付、reqgenie 主动注入驳回 = 二期。 |

## 3. 架构总览

```
                 reqgenie 后端 (控制平面, 公网经 cloudflared)
                 ┌───────────────────────────────────┐
                 │ dev_sessions(codex 集中托管, 原样)  │
                 │ ┌──── 新增: external runner ───────┐│
                 │ │ runners / runner_jobs /          ││
                 │ │ registration_tokens 表           ││
                 │ │ 路由: register(stdin token) /    ││
                 │ │   jobs(长轮询,原子claim) /        ││
                 │ │   heartbeat / events(seq幂等) /  ││
                 │ │   revoke / dispatch(查在线+互斥) ││
                 │ │ reaper: 心跳超时→orphaned;       ││
                 │ │         queued 超时→failed        ││
                 │ │ 前端: runner 管理页 + 需求详情     ││
                 │ │   RunnerDispatchSection           ││
                 │ └──────────────────────────────────┘│
                 └───────▲────────▲───────────▲────────┘
        ① register      │   ② GET /jobs       │ ③ POST /events
        (stdin token,    │   长轮询(挂起,      │ 带 per-job 单调 seq
         一次性消费,      │   原子 claim)       │ 独立HTTPS,乱序/重放防护
         换长期secret)    │   outbound + jitter │ + 内容脱敏
                 ┌───────┴────────┴───────────┴────────┐
                 │ autopilot daemon  (用户机器, NAT 后) │
                 │  runner.lock 单实例 (复用 pid.ts)    │
                 │ ┌── 新增 src/daemon/runner/ ───────┐ │
                 │ │ registration / poller /          │ │
                 │ │ job-sync(try/catch→failed回写) / │ │
                 │ │ outcome-reporter(seq+持久映射)   │ │
                 │ └──────────────┬───────────────────┘ │
                 │ job-sync: ensureWorkspaceByRemote →  │
                 │ create→setWorkspaces→enqueue         │
                 │  → [现有调度/执行管线零改]            │
                 │  sandbox clone(本机 gh凭证)→AI→PR→fix │
                 └──────────────────────────────────────┘
                                  │ git push / 开 PR (本机凭证)
                                  ▼
                            GitHub (PR 在此 merge 签字)
```

**信任与凭证边界**：reqgenie 不持有/不下发 git/AI 凭证；代码在用户机器上用用户凭证开发推送。但 **reqgenie 下发的文本（spec/描述）会成为本机 bypassPermissions 开发 agent 的指令**——故 reqgenie 控制平面及其鉴权（含防冒充注册）是本机安全边界的一部分（§8.5），不能误读成「凭证不下发=本机绝对安全」。

## 4. Runner 协议（契约）

### 4.1 状态机

**Runner（一台机器）**：`offline → idle ⇄ busy`
- `offline`：未连接 / 心跳超时（reaper 判定）。
- `idle`：已注册、在线、空闲（在长轮询等活）。
- `busy`：正在执行一个 job（MVP 单 job，§4.6）。

**Job（一次派发）**：
```
queued ──claim(原子)──► claimed ──job-sync ok──► running ◄──► awaiting_review ──merged/验收──► done
   │                      │                         ▲   fix(running↔review 回边)
   │ dispatch_timeout     │ job_sync_failed         │
   ▼                      ▼                         │
 failed ◄────────────── failed ◄───执行确定性失败────┘

任意活跃态(claimed/running/awaiting_review) ──runner掉线──► orphaned ──重连补发真实态──► (running/awaiting_review/done)
                                                            └──orphaned 超 24h──► failed
任意活跃态 ──admin cancel(经下行传达)──► cancelled
```
- **`running ⇄ awaiting_review` 是双向**：fix 回路 = awaiting_review→running（回写带 `fix_round`，reqgenie 展示「修复中(第 N 轮)」，不误判倒退）。`done` 的唯一合法前驱是 `awaiting_review`。
- **`orphaned`**（关键，防脑裂）：runner 掉线时 job **不直接 failed**，置 `orphaned`（非终态、非可调度、仍占用需求级互斥）。reqgenie **永不能凭控制面断连推断本地执行失败**——autopilot 可能还在本地跑、甚至已出 PR。重连后凭回写收敛回真实态；只有 runner 主动回写 failed、或 orphaned 超 24h 才转真 failed。
- **终态吸收**：done/failed/cancelled 进入后，后续非终态回写一律 ACK 但不改状态（防回放打回）。

> job 状态是 reqgenie 对 autopilot 需求状态的**投影**，由带 seq 的回写驱动；autopilot 内部状态机仍是唯一事实源（D1）。

### 4.2 端点（reqgenie 新增）

runner outbound（runner 凭证 bearer 鉴权）：
| 方法 | 路径 | 用途 |
|------|------|------|
| `POST` | `/api/runners/register` | 用一次性注册 token 换长期 runner 凭证（§4.3）；落 `runners` 行 |
| `GET` | `/api/runners/{id}/jobs?status=idle\|busy&wait=50` | **长轮询领活**：见 §4.2.1 |
| `POST` | `/api/runners/{id}/heartbeat` | 心跳（busy 期必发，§4.7 活性不变式）；响应体可回带 `pending_cancel` 下行信号 |
| `POST` | `/api/runners/{id}/jobs/{jobId}/events` | **回写**：带 per-job 单调 `seq` + `client_event_id`（§4.5） |
| `POST` | `/api/runners/{id}/deregister` | 优雅下线，置 offline（不作废凭证；作废走 admin revoke） |

管理端（reqgenie 现有 JWT + **新增 `runner_manage` 权限**）：
| 方法 | 路径 | 用途 |
|------|------|------|
| `POST` | `/api/admin/runners/registration-token` | 生成一次性注册 token（短时效 15min，落 `registration_tokens` 表，哈希存储） |
| `GET` | `/api/runners` | 列 runner（在线/离线/忙闲、机器信息、注册者、最后心跳） |
| `DELETE` | `/api/runners/{id}` | **revoke**：删 runner 行即作废 `secret_hash`，该 secret 后续请求 401 |
| `POST` | `/api/requirements/{reqId}/dispatch` | **下发到指定 runner**：body `{ runner_id }`。服务端校验 ①目标 runner `status=idle`（busy/offline → 409）②该需求无活跃执行（跨通道互斥，§5.5）→ 建 `runner_jobs`(queued) |
| `POST` | `/api/runner-jobs/{jobId}/cancel` | 取消 job（传达见 §4.7 cancel 下行） |

#### 4.2.1 长轮询领活（原子 claim + last-chance read）
1. handler 收到 GET，**先查一次** 该 runner 的 queued job。
2. 命中 → 执行**原子 claim**：
   ```sql
   UPDATE runner_jobs SET status='claimed', claimed_at=now(), claimed_by=$conn_id
   WHERE id=$job AND status='queued' RETURNING *;
   ```
   仅 `affected rows=1` 的连接把 job 返回给它的 GET（赢家独占）；rows=0 的继续挂起。**这是防「同一 job 被双 claim → 双跑双 PR」的根**。
3. 无命中 → `select! { _ = broadcast.recv() => 重查, _ = sleep(wait) => 走超时分支 }`。
4. **超时分支 204 前必须再查一次 queued（last-chance read）**，消除「dispatch 唤醒信号在判定 204 瞬间丢失」的 TOCTOU 窗口。
5. 唤醒机制用 **`tokio::sync::broadcast`**（reqgenie 已有 `DevSessionBroadcaster` 先例，比裸 `Notify` 的边沿丢信号更稳）；并以「每 5s 内部 re-check DB」兜底。
6. `wait` 缺省 50s、上限 60s；超时返回 `204 No Content`。

### 4.3 鉴权与凭证生命周期

- **注册 token**：admin 在 runner 管理页生成，**一次性、短时效（15min）**。reqgenie 侧 `registration_tokens` 表存哈希 + `consumed_at`；register 在事务内 `SELECT … FOR UPDATE` 校验「未消费且未过期」再标记消费 → **防并发重放**。
- **token 传递**：CLI **不在命令行明传**（会进 shell history）。`autopilot runner register` 优先从 **stdin / 环境变量 / 交互提示**读 token（仿 GitHub `config.sh`）；`--token-stdin` 受支持，`--token <x>` 标注不推荐。
- **runner 凭证**：注册成功返回 `{ runner_id, runner_secret }`，**bearer secret**（MVP 对称；RSA/JWT 留二期）。reqgenie 存 `secret_hash`（argon2/bcrypt，不存明文）。autopilot 落 `AUTOPILOT_HOME/runner/credentials.json`，**按平台收紧 ACL**（Windows: `icacls` 去继承 + 仅授当前用户；POSIX: 0600）——⚠ **纯 `{mode:0o600}` 在 NTFS 上是 no-op**（现有 `auth.ts:33` jwt-secret 同款弱点，一并修）。
- **register 幂等/冲突**：同 name 重注册 → 旋转 secret 并使旧 secret 失效；`credentials.json` 已存在时 CLI 要求 `--force` 覆盖，不静默接管。
- **回写鉴权与防伪**：回写端点强制 runner 凭证 + job 归属校验（runner 只能回写自己的 job）；**`pr_urls` 回写做 owner/repo 归属校验**——PR 必须落在该 job 下发的 `repos` 集合内，拒绝任意外部 URL（防钓鱼 PR 诱导 merge）。
- **独立 middleware**：runner 鉴权 ≠ 复用 dev_session 的全局 `DEV_SESSION_WORKER_SECRET`（那是单把全局密钥）；新增 `ensure_runner_auth(runner_id, bearer, secret_hash)`。

### 4.4 派发 payload（reqgenie → runner，经长轮询返回）

```jsonc
{
  "job_id": "rj-...",
  "seq_base": 0,                         // runner 回写 seq 从此基准 +1 递增
  "requirement": {
    "id": "<reqgenie requirement uuid>",
    "title": "...", "description": "...",
    "organized_content": { /* AI 整理结构化内容 */ },
    "implementation_plan": "..."         // 可选: reqgenie 已产 spec/计划
  },
  "repos": [
    { "owner": "ReverseGame", "repo_name": "xxx",
      "repo_url": "https://github.com/ReverseGame/xxx",
      "default_branch": "master", "primary": true }   // 显式标主库, 不靠数组下标
  ],
  "workflow": "dev"
}
```
`runner_jobs.payload` 存**完整 snapshot**（自包含、便于审计与重连对账），随 job 终态由保留策略清理。

### 4.5 回写事件（runner → reqgenie，独立 HTTPS POST，幂等 + 防回放）

```jsonc
{
  "seq": 7,                       // per-job 单调递增, runner 维护, 随重试队列持久化
  "client_event_id": "<uuid>",    // 去重同一事件被收两次
  "kind": "claimed|running|phase|pr_opened|awaiting_review|done|failed|cancelled",
  "fix_round": 0,                 // kind=running 时区分首跑(0)/修复轮(N), 供展示「修复中(第N轮)」
  "at": "<ISO8601>",              // 仅展示, 不作排序依据(本地时钟不可信)
  "task_id": "<autopilot 当前 run id>",   // 随事件附带, 不作映射键(fix 会变)
  "phase": "design|develop|...",
  "pr_urls": ["https://github.com/ReverseGame/xxx/pull/123"],
  "reason": "...",                // failed/cancelled 短摘要, 已脱敏
  "detail": { }                   // 已脱敏
}
```
- **reqgenie 侧防回放**：job 记 `last_applied_seq`，**只接受 `seq > last_applied_seq`**，旧 seq 直接 ACK 丢弃（幂等且防「乱序/重连补发把 done 打回 running」）。
- **终态吸收**：done/failed/cancelled 后非终态 kind 一律 ACK 不改状态。
- **内容脱敏**：`reason`/`detail` 复用 autopilot 既有脱敏（token / URL userinfo / 绝对路径裁剪），限长，避免本机敏感信息外泄到公网控制平面。
- **不传全量日志**：只带粗粒度进度 + PR 链接；详细执行看 PR / autopilot（执行视图深链留二期）。

### 4.6 并发
MVP **一台 runner 一次一个 job**：busy 时长轮询带 `status=busy`，dispatch 服务端拒绝给 busy runner 派新活。多 job 并发留二期（autopilot 调度器本就支持全局并发，去掉这层闸门即可）。

### 4.7 失败、活性与下行

**活性不变式**（消除脑裂误判）：`heartbeat_interval(30s) < poll_wait(50s) < reaper_threshold(90s)` 且 `reaper_threshold ≥ 2×busy_heartbeat`。
- **idle 期**：长轮询 GET（wait=50s）每轮往返自然续活，无需额外心跳。
- **busy 期**：runner 不发 GET，**必须独立心跳 ≤30s**；回写成功也顺带刷新 `last_heartbeat_at`。

| 场景 | 处理 |
|------|------|
| runner 掉线（心跳超 90s） | reaper 置 runner `offline`，其活跃 job 置 **`orphaned`（非终态，保互斥）**，**不标 failed**。重连补发收敛真实态；orphaned 超 24h 才转 failed。 |
| job-sync 翻译失败（私有仓无权限 / create/enqueue 被拒 / repos 空） | job-sync **try/catch 整段**，任一步失败 outcome-reporter 立即回写 `failed`(reason=`job_sync_failed:<详情>`)。兜底：心跳活但 `claimed` 超 60s 仍无本地 task → 自检回写 failed（防卡死 claimed）。 |
| dispatch 到 offline/busy runner | 服务端 dispatch 直接 409（不靠前端）。 |
| queued 无人领 | queued-timeout reaper：超阈值无 claim → job `failed`(reason=`dispatch_timeout`) + 通知用户。 |
| daemon 重启 | runner.lock 防双实例；poller 重连**带 jitter 指数退避**（区分「服务端断开」vs「正常超时」）。outcome-reporter 启动时扫描本地 `running/fix_revision/awaiting_review` 需求 → 据 `requirement_id→job` 持久映射 + 当前 `requirement.task_id` **补发一条当前态快照**（非全量历史，靠 seq 幂等）。 |
| reqgenie 重启（挂起长轮询全断） | runner 重连退避 + jitter 防 thundering herd；reqgenie 可临时 `503 + Retry-After`。 |
| 同机重复注册 / 双 daemon | 一份凭证 ↔ 一个在线 daemon：daemon 认领凭证时写 `runner.lock`（PID 存活检测，复用 `pid.ts`）；reqgenie 侧同 runner_id 出现并发长轮询时拒第二条。 |
| 需求被 reqgenie 取消（runner 在跑） | 下行无 push 通道 → **复用 reqgenie 既有模式**：heartbeat / 回写响应回带 `pending_cancel` 或 `409`（参 `dev_sessions` 终态返 409），runner 收到调本地 `tasks.cancel`。MVP：cancel 对 queued/claimed 即时生效；running 后经下行尽力取消。 |
| PR 已 merge 但 job 未 done（poller 间隔 / runner 离线） | MVP 接受「done 唯一由 runner 回写」+ 记录窗口风险；R2：reqgenie 侧对 `pr_urls` 兜底查 GitHub merge 状态，把 orphaned/卡住但已 merge 的 job 收敛到 done。 |

## 5. reqgenie 侧改造

### 5.1 数据（迁移）
> 迁移号取账本**下一可用号**并核对防撞号（reqgenie 现状最新 `059_*` + 若干日期式 `2026xxxx_*`；建议 `060_runners.sql` / `061_runner_jobs.sql` / `062_registration_tokens_and_perm.sql`，落地前再核对账本）。

- **`runners`**：`id, name, secret_hash, labels(jsonb, 二期), status(offline/idle/busy), machine_meta(jsonb: os/arch/version/gh_account), registered_by(user_id), last_heartbeat_at, created_at`。
- **`runner_jobs`**：`id, runner_id, requirement_id, status, payload(jsonb snapshot), last_applied_seq(int default 0), outcome(jsonb), pr_urls(jsonb), error_reason, claimed_at, finished_at, created_at`。
  - 活跃唯一约束（partial index，对标 `052_dev_sessions.sql` 写法）：
    ```sql
    CREATE UNIQUE INDEX uq_runner_jobs_active ON runner_jobs(requirement_id)
      WHERE status NOT IN ('done','failed','cancelled');
    ```
    注意 `orphaned` 是**非终态**，故掉线期间仍占约束、阻止对同需求重新 dispatch（堵脑裂双 PR）。
- **`registration_tokens`**：`token_hash, expires_at, consumed_at, created_by, created_at`。
- **`permissions`** 补行：`('runner_manage','管理 Runner','系统配置')`，授予 admin 角色。

### 5.2 路由与长轮询实现
§4.2 全部端点。长轮询 handler 用 **`tokio::sync::broadcast`**（复用 `ws.rs` 的 `DevSessionBroadcaster` 模式，**勿用裸 `Notify`**——代码库无先例且边沿丢信号），handler 框架 = 先查 → `select!{recv, timeout}` → last-chance 重查 → claim 原子更新 / 204。reaper 两个：心跳超时 reaper（→orphaned/offline）+ queued 超时 reaper（→failed），与现有 `dev_session_reaper` 平行注册到 `main.rs`。

### 5.3 前端
- **Runner 管理页**（受 `runner_manage` 权限）：runner 列表（在线/离线/忙闲、机器信息、注册者、最后心跳、revoke 按钮）+「生成注册 token」（弹窗显示一次性 token + `autopilot runner register` 命令，提示用 stdin 输入）。
- **需求详情**：在现有 `DevSessionEntry`（codex 入口）**下方**新增 `RunnerDispatchSection`：「下发到 runner ▾[选在线机器]」+ job 状态徽标 + PR 链接 + autopilot 回链。两入口文案明确区分「① AI 设计(codex 集中托管，到 spec)」vs「② 下发到我的 runner(本机执行，到 PR)」。

### 5.4 与 dev_sessions 的关系
代码/表层面**平行、零改动**；但**需求维度互斥**（§5.5），不是「互不感知」。

### 5.5 跨通道互斥（防双跑双 PR — blocker）
两条执行通道（codex dev_session / runner job）对**同一需求**不可同时活跃：
- `dispatch` 建 runner_job 前查该需求有无非终态 `dev_session`，命中 → 409。
- `create_session`（codex）建会话前查该需求有无非终态 `runner_job`，命中 → 409。
- 实现可在 requirement 维度加单例执行锁（统一闸门），或两端互查。MVP 必须有，否则误操作直接出两份 PR、双份算力、分支互踩。

## 6. autopilot 侧改造

### 6.1 新模块 `src/daemon/runner/`
- **`registration.ts`**：`autopilot runner register --url <reqgenie>`（token 走 stdin/env/交互）→ 调 `/register` 换凭证 → 落 `AUTOPILOT_HOME/runner/credentials.json`（平台 ACL 收紧；已存在要 `--force`）。
- **`poller.ts`**：daemon 启动若检测到 runner 凭证，先抢 `runner.lock`（PID 存活，复用 `pid.ts`），再开 outbound 长轮询循环（带 status + machine_meta + gh_account，jitter 退避）；busy 期并发独立心跳。
- **`job-sync.ts`**（**try/catch 整段，失败即回写 failed**）：把 job 翻译成本地需求——
  1. 每个 repo：`ensureWorkspaceByRemote(projectId, repo_url, default_branch)`——⚠ **autopilot 无此现成能力**，需在 `workspaces.ts` 新增 `getWorkspaceByRemote(projectId, remoteUrl)`（`workspaces` 表 `remote_url` 无唯一约束，应用层去重：命中多条取 `created_at` 最早；命中且 branch 不一致按 payload 为准）。
  2. `requirements.create({ title, spec=组装(description+organized_content+implementation_plan), workflow })`（停 drafting）。
  3. `requirements.setWorkspaces(reqId, wsIds)`（主库 = payload `primary:true` 的仓，非数组下标）。
  4. `requirements.enqueue(reqId)`（§6.5 闸门）。
  5. **持久化映射**（强制落表，不留内存口子）：新迁移在 autopilot 侧建 `runner_job_links(runner_job_id PK, requirement_id, control_plane_url, seq_cursor)`，**锚定键 = requirement_id**（稳定不变；task_id 在 fix/重跑会变，仅作回写 payload 字段）。
- **`outcome-reporter.ts`**：订阅 event-bus，按 `requirement_id` 查映射拿 `job_id`，组装带**单调 seq**（从 `seq_cursor` 递增、随重试队列持久化）的回写 POST；本地重试队列（指数退避）+ 内容脱敏。
  - ⚠ **不存在 `requirement:awaiting_review` 事件**（我原 spec 臆造）。改订阅 **`requirement:status-changed`**，在 handler 里按 `payload.to` 映射 job kind（`awaiting_review`/`fix_revision`→running+fix_round/`done`/`failed`/`cancelled`）；`phase:*` 映射 `kind=phase`。
  - 启动对账：扫本地 `running/fix_revision/awaiting_review` 需求补发当前态快照（§4.7）。
- **`heartbeat.ts`**：busy 期独立心跳（≤30s）；处理响应里的 `pending_cancel` 下行。

### 6.2 CLI
`autopilot runner register | start | status | stop | remove`（薄客户端）。

### 6.3 config / 凭证
新增 `src/core/config.ts` 的 `loadRunnerConfig()`/`saveRunnerConfig()`：读写 `config.yaml` 的 `runner:` 段（`control_plane_url` / `poll_wait_ms` / `heartbeat_interval_ms` / `name` / `labels`）。**凭证不进 config.yaml**，单独落 `credentials.json`（防误提交）。

### 6.4 零改动复用
调度器（requirement-scheduler，FIFO + `max_concurrent_tasks`）、状态机、sandbox/clone（本机 gh 凭证，`resolveGitToken`）、runner.ts、pr-poller、fix-revision-runner、现有 RPC——全不动。runner 只给系统加「新需求来源」+「新状态出口」。

### 6.5 enqueue 闸门与「跳过澄清」的合法性（澄清审查矛盾）
`create→setWorkspaces→enqueue` **跳过 clarifying 是合法路径**（`requirements.create` 本就停 drafting、不自动进 clarifying；enqueue 不强制经 clarifying）。前置由 enqueue 自带闸门保证：① `hasUsableProvider`（无可用 provider 拒）② `validateWorkflowInput(workflow, hasWs)`（按工作流 `requires.git` 校验代码库集合非空）。故 spec D5「不重复澄清」与 CLAUDE.md「确认代码库是进入澄清的前置」**不冲突**——后者约束的是「进 clarifying」这条路，我们走的是「直接 enqueue」另一条路，但仍要满足 provider + 代码库非空。若下发需求缺这些前置 → enqueue 被拒，job 回写 failed 报人（reqgenie 下发前应保证 spec/repos 充分）。

## 7. 端到端时序

**注册**：admin 生成注册 token → 用户机器 `autopilot runner register --url ...`（token 经 stdin）→ 换长期凭证落盘 + 抢 runner.lock → poller 上线（idle）。

**下发→执行→交付**：
1. 需求在 reqgenie 备好 → 点「下发到 runner ▾」选在线机器 → dispatch 校验(在线+无活跃 dev_session) → `runner_jobs`(queued)。
2. 该 runner 长轮询**原子 claim** 返回 job（claimed）→ 回写 `claimed`(seq=1)。
3. job-sync 建本地需求 enqueue（成功→running，回写 `running`/`phase`；失败→回写 `failed`）。
4. sandbox 用本机 gh 凭证 clone → AI 开发 → `submit_pr` 推 `feat/...` 开 PR → 回写 `pr_opened`+`awaiting_review`。
5. reqgenie 展示 PR 链接 + 状态。

**验收 / fix**：
- 人在 GitHub review PR。**merge** → autopilot pr-poller 检测 → 需求 done → 回写 `done`（job=done，吸收态）。
- **CHANGES_REQUESTED / CI 失败** → autopilot 自动转 fix_revision → fix run（task_id 变）→ 回写 `running`(fix_round=N) → 再 `awaiting_review`。**全程 autopilot 内部闭环**，reqgenie 据 fix_round 展示「修复中(第 N 轮)」。

## 8. 安全（威胁模型）

### 8.1 注册
一次性 token、哈希存储、`consumed_at` + `FOR UPDATE` 防并发重放；token 经 stdin/env 不进 history；register 绑定并记录 `machine_meta`/`registered_by`，管理员可识别冒充。

### 8.2 runner 凭证被盗影响面与缓解
被盗者可冒领 job（窃需求/私有仓 URL/spec）、伪造回写（谎报 done/failed、注入钓鱼 pr_urls）。缓解：①`pr_urls` owner/repo 归属校验（限下发 repos 集合）②**admin revoke 端点**（被盗即单方面作废，MVP 必需）③seq 防回放④凭证落盘 ACL 收紧。非对称鉴权（private_key_jwt，不传密钥）留二期。

### 8.3 凭证落盘
Windows 用 `icacls`（去继承 + 仅授当前用户），非纯 `0o600`；顺带修 `auth.ts` jwt-secret 同款弱点。

### 8.4 D6 私有组织仓权限（退化点）
本机 gh 账号须对下发仓库集合有 read+push。register/dispatch 时 runner 上报 gh 账号身份，reqgenie 对照可给「该 runner 可能无权访问 repo X」预警；doctor 前置检查扩展为「对本 job 每个 repo 跑 `ls-remote` 探测可达」。

### 8.5 下发文本 = 本机 agent 指令（信任假设）
下发 payload 文本进 `requirements.create` 的 spec，被本机 bypassPermissions 开发 agent 执行。故 reqgenie 控制平面（公网）及其鉴权是本机安全边界的一部分——这把 §8.1/§8.2 的注册/凭证安全与本机执行权限关联，避免「凭证不下发=本机安全」误读。

## 9. 范围与分期

**MVP（R1）— 跑通命脉 + 必要正确性**
- reqgenie：3 张表 + register(stdin token,一次性)/jobs(长轮询+原子claim+last-chance)/heartbeat/events(seq幂等)/revoke/dispatch(查在线+跨通道互斥) + 两 reaper(orphaned/queued-timeout) + 最小前端(runner 列表+生成 token+下发+状态/PR) + `runner_manage` 权限。
- autopilot：`src/daemon/runner/` 四模块 + `getWorkspaceByRemote` + 映射表迁移 + CLI register/start/status + config/凭证(ACL) + runner.lock + job-sync try/catch 回写 + outcome-reporter(订 status-changed + seq + 启动对账)。
- 交付 PR；fix 靠 autopilot 既有 pr-poller 自管。

**R2 — 健壮与体验**
- 运行中 cancel 下行完善 + reqgenie 侧 PR merge 兜底感知 + 重连风暴退避打磨。
- 回写加 phase 进度 + autopilot 执行视图深链。
- reqgenie 主动「驳回→注入反馈」映射 autopilot fix（人在 reqgenie 而非只在 GitHub 驳回）。

**R3 — 扩展**
- WebSocket 派发升级。labels/多 runner 路由 + 单 runner 多 job。artifacts 交付通道。「需要澄清」回写透传飞书。非对称鉴权。

## 10. 已知权衡（非缺陷，有意选择）
1. 两套执行路径并存（D4）：靠需求级互斥（§5.5）而非合并，代价是两入口需 UI 讲清。
2. 回写不传全量日志：控制平面轻量，详情看 PR。
3. MVP 对称 secret + revoke（非非对称）：runner 少、scope 窄；被盗能力靠 revoke + pr 归属校验 + seq 兜。
4. 整包下发不重复澄清（D5）：靠人审 PR 兜模糊需求，二期补「需要澄清」回写。
5. 本机凭证（D6）：相对 installation-token 在私有组织仓是退化，靠前置探测兜（§8.4）。

## 11. 测试要点
- reqgenie：原子 claim 并发双连接只一个赢、last-chance 不丢 dispatch、seq 防回放（旧 seq 不改态）、终态吸收、orphaned 不变终态且占互斥、queued/心跳两 reaper、跨通道互斥 409、注册 token 一次性+并发重放拒、revoke 后 401、pr_urls 归属校验。
- autopilot：`getWorkspaceByRemote` 去重/branch 对齐、job-sync 失败回写 failed、claimed 卡死自检、outcome-reporter 订 status-changed 映射 + seq 单调 + 重试队列 + 启动对账、映射锚 requirement_id 经 fix 换 task_id 不丢、runner.lock 防双实例、凭证 ACL。
- 端到端：注册→下发→PR→merge→done；驳回→fix(fix_round)→再 awaiting_review；runner 掉线→orphaned→重连收敛(非 failed)；同需求双通道下发被拒。

## 12. 对抗性审查纪要（rev1→rev2 修正项）
四路审查（协议/reqgenie 可行性/autopilot 接入/安全）发现并已修：
- **blocker**：claim 非原子(§4.2.1 原子 UPDATE+单实例锁) · job 状态机缺 fix 回路(§4.1 running⇄awaiting_review+fix_round) · 乱序/重连把 done 打回 running(§4.5 per-job seq+last_applied+终态吸收) · runner_lost 脑裂(§4.1/§4.7 orphaned 中间态) · 双执行路径无互斥(§5.5) · 注册 token 明传+重放(§4.3 stdin+一次性消费) · 凭证被盗无 revoke/pr 伪造(§8.2 revoke+pr 归属校验) · `ensureWorkspaceByRemote` 不存在(§6.1 新写) · `awaiting_review` 事件臆造(§6.1 改订 status-changed)。
- **major**：长轮询 204 TOCTOU(last-chance read) · 重注册/吊销语义(§4.3) · dispatch 到离线无降级(§4.2 校验+queued reaper) · 心跳活性不变式(§4.7) · 映射须持久+锚 requirement_id(§6.1) · daemon 重启对账(§4.7/§6.1) · config/凭证落盘(§6.3) · 迁移号(§5.1) · 长轮询用 broadcast 非 Notify(§5.2) · 唯一约束 SQL(§5.1) · runner 鉴权独立 middleware(§4.3) · 跳过澄清合法性澄清(§6.5) · 0600 在 Windows 无效(§8.3) · job-sync 失败无回写(§4.7) · 私有仓本机 gh 权限(§8.4) · reqgenie 重启重连风暴+同机双注册(§4.7) · payload jsonb snapshot(§4.4) · 前端双入口共存(§5.3)。
- **minor/nit**：done 的 PR merge 兜底(R2/§4.7) · cancel 下行通道(§4.7) · 主库显式标记+branch 对齐(§4.4/§6.1) · 注册 token 表(§5.1) · runner reaper 对齐 dev_session_reaper(§5.2) · `runner_manage` 权限(§5.1) · 下发文本=agent 指令信任假设(§8.5) · 回写脱敏(§4.5)。
