# ReqGenie 自托管 Runner 设计（A 模式：reqgenie 为大脑）

> autopilot 作为 reqgenie 的**自托管 `agent_backend`**，复用 reqgenie 已有的 `dev_sessions` 事件协议 + 连接倒转。
> 日期：2026-06-23 · 状态：设计待审 · **rev3（A 模式；已纳入两轮对抗性审查，见 §13；旧 B 设计见 git f9ccbde）**

## 1. 背景

ReqGenie（Rust+Axum+PG 后端、React 前端、飞书、K8s）已有一整套「AI 自动开发编排」：
- **`dev_sessions`**：阶段机 `clarify→spec→eng_review→ui_review→dev→pr→done` × 运行态 `created/queued/running/waiting_input/waiting_gate/paused/completed/failed/cancelled`；**事件溯源 `dev_session_events`（seq 由后端 advisory 锁定序、唯一事实源）**；关卡 `dev_session_gates`（含 `rework_target_stage`）；阶段产物 `dev_session_stage_artifacts`（版本化）；多仓 `dev_session_repos`。
- **执行器 `agent-worker`**（Node `.mjs`，集中托管 k8s）：后端 `POST /sessions` push 派发 → worker 跑回合循环（拉事件流当事实源、调 `codex exec`、回写事件、30s 心跳、按需取 git-token）。
- **`agent_backend` 字段**（codex/claude_code/opencode，落库但**派发尚未消费它**）+ **`SessionDispatcher` trait（已对象安全，`PushDispatcher` 是其一）** = 执行器本就设计成可插拔。

**关键缺口**：`dev`/`pr` 阶段**枚举里有、Phase 2/3 未实现**（agent-worker 只读到 spec）。**autopilot 恰是「写代码 + 出 PR」的成熟引擎**，正好填这一半，且把执行下放到用户机器。

## 2. 核心决策（A 模式，已与用户对齐）

| 编号 | 决策 | 说明 |
|------|------|------|
| **D1 角色** | **reqgenie 是大脑，autopilot 是自托管执行器** | autopilot 注册为新 `agent_backend = autopilot_selfhosted`，**复用 reqgenie dev_sessions 事件协议**当线协议。reqgenie 拥有阶段机/关卡/事件流/飞书/验收；autopilot 每 stage 跑一轮、产事件、回写。 |
| **D2 机制** | 注册 → 定向下发到指定机器 → 回写 | 一个 `autopilot_selfhosted` session 由**整台 runner 执行全部 stage**（agent_backend 是 session 级、不跨后端拆）。 |
| **D3 连接倒转** | 仅倒转「派发」一段 | agent-worker 出站端点（events 拉/推、status、git-token、heartbeat）对 runner 原样复用；只把入站 `POST /sessions` push 改成「runner 注册 + 长轮询领待派 session」。 |
| **D4 复用而非新造** | 复用 dev_sessions 全套 | B 模式从零造协议暴露 9 blocker；A 复用 reqgenie 已验证的 seq 定序 / 事件溯源 / 关卡 rework / 心跳，那些 blocker 大半蒸发（§12）。飞书澄清/spec/gate 人审白拿。 |
| **D5 autopilot 实现未建阶段** | autopilot 实现各 stage round | clarify/spec/review = 读 + 产文档 + 开 gate；**dev = clone + AI 改码 + 产 diff（不 commit/push）+ 开 gate；pr = commit/push 交付分支 + 开 PR + `pr_created` 事件**（§4.5）。reqgenie 放开 `autopilot_selfhosted` session 的 `max_stage=pr`。 |
| **D6 凭证（相对 B 翻转，且是真改造非小改）** | **用 reqgenie vend 的 installation token** | 解决 B 模式「本机 gh 账号对组织私有仓没权限」。⚠ **工作量重估为 R1 实打实改造**（审查纠正）：clone 侧 `resolveGitToken` 无入参注入点；push/PR 侧 `builtin-deliver-pr.ts` **对 token 零管线**（裸 `git push` + `gh`，且 clone 后会抹除 origin 凭证）。需：token 全链路透传 + push/PR 时临时拼 auth URL 或注 `GH_TOKEN`（用后即抹，对齐零痕迹）+ **push 前现取**（1h installation token 跨 dev→gate 等人→pr 可能过期）。**已定（2026-06-23 用户确认）= 用 vend token**（非本机 gh）。 |
| **D7 fix 回路** | 用 reqgenie 的 gate rework（增量沙箱契约见 §4.5） | 驳回 = gate `rejected` + `rework_target_stage` → session 回退重做该 stage，autopilot 下一 round 在**保留的脏工作树上增量重做**（与 autopilot 既有返工语义一致）。autopilot 自己的 pr-poller/fix-revision-runner 在 A 模式不参与。 |

## 3. 架构总览

```
              reqgenie 后端 (大脑·公网经 cloudflared)
              ┌──────────────────────────────────────────┐
              │ dev_sessions 阶段机 + 事件流(seq) + gate    │
              │ + 飞书澄清 + stage_artifacts + 人工验收      │
              │ dispatch_session 拆 push_dispatch +         │
              │   assign_runner; 按 agent_backend 选:       │
              │   codex → PushDispatcher(原样)             │
              │   autopilot_selfhosted → RunnerDispatcher  │ ← 新增(只标 assigned_runner,不POST)
              │ ┌── 新增(连接倒转) ──────────────────────┐ │
              │ │ runners 注册表 + registration_tokens   │ │
              │ │ GET /sessions/pending(长轮询+原子claim) │ │ ← 替代入站 push
              │ │ POST /runners/register / heartbeat      │ │
              │ │ reaper: runner 心跳超时→session 回退     │ │ ← 拉模型回收(新, 非现成)
              │ │   created 等重领; session 心跳→failed    │ │
              │ └────────────────────────────────────────┘ │
              │ 原样复用(出站, runner 直接打, 鉴权改 runner):│
              │  POST /events · GET /events?after_seq ·    │
              │  GET /dev-sessions/{id} · GET /git-token · │
              │  POST /heartbeat (409=终态)                 │
              │  + 新增 pr_created 摄取分支(写 pr_url)       │
              └───────▲────────▲──────────▲────────────────┘
       ① register    │  ② 长轮询领待派     │ ③ 回合循环:拉事件流(事实源)
              ┌───────┴────────┴──────────┴────────────────┐
              │ autopilot daemon (用户机器, NAT 后)          │
              │  config mode:runner → 禁 scheduler/bridge/  │
              │   run-outcome/clarifier; runner.lock 单实例 │
              │ ┌── 新增 src/daemon/runner/ ──────────────┐ │
              │ │ registration + poller(忙则停领) +        │ │
              │ │ session-loop(TS 移植 sessionLoop.mjs) +  │ │
              │ │ rounds(按 stage 选 runRound)             │ │
              │ └──────────────┬───────────────────────────┘ │
              │ ┌── 新增 src/core/executor/ (复用3块,去副作用)┐│
              │ │ ensureCodebase(注入token, 目录按 sessionId)││
              │ │ Agent.run(包 runWithTaskContext, 幽灵 ctx) ││
              │ │ submitPR(纯 git+gh, 返回数据, 不写库/不transition)││
              │ └──────────────────────────────────────────┘ │
              └──────────────────────────────────────────────┘
                                  │ clone/push/PR (vend token, 用后即抹)
                                  ▼   GitHub (PR 在此 merge 签字)
```

## 4. 协议 = 复用 reqgenie dev_sessions（补「注册 + 拉式派发 + 拉模型回收」）

### 4.1 原样复用的出站端点（NAT 友好，鉴权改 runner 凭证）
| 方法 | 路径 | 用途 |
|------|------|------|
| `POST` | `/api/internal/dev-sessions/{id}/events` | 回写事件，**后端定 seq + 注入 gate_id**（runner 永不自定）；**新增 `pr_created` 摄取分支**写 `dev_sessions.pr_url` |
| `GET` | `/api/internal/dev-sessions/{id}/events?after_seq=N` | 拉增量事件流（**唯一事实源**） |
| `GET` | `/api/internal/dev-sessions/{id}` | 拉会话状态（检测终态 / 当前 stage） |
| `GET` | `/api/internal/dev-sessions/{id}/git-token?repo_id=` | 现取 git 凭证（installation token / PAT）；鉴权改 `ensure_runner_auth`，repo_id∈session.repos 校验复用 |
| `POST` | `/api/internal/dev-sessions/{id}/heartbeat` | session 心跳（30s；409=终态→优雅退出） |

### 4.2 新增端点（连接倒转 + 拉模型回收）
runner 凭证 bearer 鉴权：
| 方法 | 路径 | 用途 |
|------|------|------|
| `POST` | `/api/runners/register` | 一次性注册 token 换长期凭证（token 走 stdin，§8.1） |
| `POST` | `/api/runners/{id}/heartbeat` | **runner 级**心跳（在线/离线；与 session 心跳分开） |
| `GET` | `/api/runners/{id}/sessions/pending?wait=50` | **长轮询领待派 session**：有派给本 runner 的 `created` session → **原子 claim**（`UPDATE … SET status='queued', claimed_at=now() WHERE status='created' AND assigned_runner=$id RETURNING *`，affected rows=1 判赢）返回 payload；否则挂起至超时 204 |
| `POST` | `/api/runners/{id}/deregister` | 优雅下线 |

管理端（JWT + 新增 `runner_manage` 权限）：`POST /api/admin/runners/registration-token`（15min 一次性，哈希存储）、`GET /api/runners`、`DELETE /api/runners/{id}`（revoke=作废 secret）。需求详情「AI 开发」创建 session 时选 `agent_backend=autopilot_selfhosted` + **目标 runner**（= 你的「下发到指定机器」）。

**派发寻址改造**：`dispatch_session` 拆成 `push_dispatch`（codex 原样 POST）+ `assign_runner`（标 `assigned_runner`，**不 POST**）。reaper 对 `autopilot_selfhosted` 只 `assign_runner`，由 runner 长轮询来 claim。

**拉模型回收（审查纠正，非「现成」）**：reqgenie reaper 检测 **runner 级心跳超时**（>90s）→ 该 runner 的 `queued`/`running` 且未终态的 session **回退 `created`、保留 `assigned_runner`**（= 只回原 runner，重启后重新 claim 续作；不改派，避免半成品脏树跨机丢失）+ 关残留 open 事件。**session 级**心跳超时（runner 在线但某 session 卡死）→ 该 session `failed`。明确：**reqgenie 不凭控制面断连推断本地执行失败**，回退 created 等重领是默认。

### 4.3 回合循环（autopilot 侧 TS 移植 agent-worker `sessionLoop.mjs`）
```
while session_rounds < SESSION_MAX(如30):           // 全 session 上限(双闸)
  SYNC : GET /events?after_seq=lastSeq (并入 user_message/驳回评论到 accumulated)
         GET /dev-sessions/{id} → status/current_stage; 终态则退出
  ROUND: 若 stage_rounds[stage] ≥ STAGE_MAX(如5): 产 limit_hit 事件 → failed   // per-stage 上限(防 rework 死循环)
         runRound = pickByStage(current_stage)  (§4.5)
         produced = await withTimeout(runRound(ctx), ROUND_TIMEOUT)  // 单 round 超时→limit_hit
         for ev in produced: POST /events(ev) → 后端回 seq(+gate_id)
  WAIT : last=produced[-1]
         clarification_requested → 等 user_message; gate_opened → 等 gate_decided 匹配 gate_id
         rejected → accumulated+=驳回评论 → 回 SYNC 重做本 stage(增量, §4.5)
```
- **等待唤醒**：MVP 接受 session 内 `user_message`/`gate_decided` 走 **30s 轮询**（人审/澄清场景对 30s 延迟容忍；派发用 50s 长轮询是因 runner 空转期需要）；统一长轮询留 R2。
- **成本闸门提到 R1**（安全闸非优化）：`ROUND_TIMEOUT`（单 round 墙钟）+ `STAGE_MAX`（per-stage 含 rework 轮）+ `SESSION_MAX`（全 session）双闸；触顶产 `limit_hit`/`session_failed` 事件让大脑可见，不静默退出。
- 照搬不变式：seq 后端定、gate_id 后端注入（防伪）、用户输入围栏化（防注入）、产物文本化、心跳 30s/reaper 90s。

### 4.4 鉴权
runner 用**独立 per-runner 凭证**（不复用全局 `DEV_SESSION_WORKER_SECRET`）；新 `ensure_runner_auth(runner_id, bearer, secret_hash)` 用于所有 runner 端点 + session 内部 API。详见 §8。

### 4.5 stage → runRound + 沙箱契约（A 模式核心，审查后钉死）
**交付分支命名（命名链在 A 模式断了，须新定）**：`reqgenie/<session_id>`（全局唯一、重连可重算、**同一 session 所有 dev/pr round 间恒定**——不变式：dev round N 与 pr round 必须同分支）。

**沙箱目录键**：A 模式无 autopilot reqId，clone 落 `runtime/runner-sessions/<session_id>/codebase/`，清单同此目录（替代既有 `runtime/requirements/<reqId>/`）。

| stage | runRound | 沙箱/复用 | 产出事件 |
|-------|----------|----------|---------|
| `clarify` | 读码+需求→提问或判清楚 | `ensureCodebase(shallow)` + `Agent.run` | `assistant_message` +(`clarification_requested`\|推进) |
| `spec`/`eng_review`/`ui_review` | 产文档/评审 | `Agent.run` | `assistant_message` + `stage_artifact` + `gate_opened` |
| **`dev`** | AI 改码 → 产 diff | `ensureCodebase(full, deliverBranch=reqgenie/<sid>)` + `Agent.run`(写)；**只改工作树 + `git diff`，不 commit/push** | `assistant_message` + `stage_artifact(kind=dev, diff 预览)` + `gate_opened` |
| **`pr`** | commit + push + 开 PR | `submitPR`（**checkout 交付分支 → add → commit → push → gh pr create**，纯函数返回 `[{repo,prUrl}]`） | `assistant_message` + `pr_created`(branch_name/pr_url) → 后端写 pr_url → `done` |

**关键沙箱契约**：
- **dev 只产 diff、pr 才 push**（审查指出现有 `submit_pr` 是 commit+push 一体，需拆）：dev round 编辑工作树不提交；pr round 负责全套 git。
- **clarify(浅)→dev(全) 升级 = 整库删重 clone**（非加深）；gate 等人久后 dev 起来要全量重 clone，接受其延迟，或 R2 优化 clarify 直接用 full。
- **dev rework（驳回重做）增量契约**：rework round 必须**命中既有 full clone 交付分支工作树（reused=true，零重 clone），保留上一轮脏树做增量**，把驳回评论注入 dev round prompt（等价既有 `${REJECTION}`）。仅当沙箱被清才退化重来，并在 prompt 如实声明现场。
- **dev 中间态重启安全（审查提到 R1 正确性）**：daemon 在 dev round 跑一半重启 → 事件流 after_seq 能续，但本地脏树不可靠。重入 dev round **先把工作树 reset 到交付分支 base（丢弃半成品）再重跑**（避免在脏树上叠加产不可预测结果）；rework 例外（rework 是受控增量，见上）。
- **多库需求**：repos 集合在 dev/pr 间冻结（需求 freeze）；submitPR 遍历实际有 diff 的库各开 PR。

> 须遵守 reqgenie 约定：事件枚举/seq 后端定/rework 回退/成本闸门 limit_hit/spec_md 同步 `requirements.implementation_plan`/飞书澄清卡 `questions[]` 结构。

## 5. reqgenie 侧改造

### 5.1 数据（迁移；号取账本下一可用并核对防撞号，现状最新 `059_*`，建议 060/061/062）
- `060_runners.sql`：`runners(id, name, secret_hash, status(offline/online/busy), machine_meta jsonb, registered_by, last_heartbeat_at)` + `registration_tokens(token_hash, expires_at, consumed_at, created_by)`。
- `061_dev_sessions_runner.sql`：`dev_sessions` 加 `assigned_runner`（nullable）；`agent_backend` 加 `CHECK IN ('codex','claude_code','opencode','autopilot_selfhosted')`；**单需求单活跃 session 唯一索引**（§5.5，现状无）。
- `062_runner_manage_perm.sql`：`permissions` 补 `('runner_manage','管理 Runner','系统配置')`。

### 5.2 派发多态 + 拉式领活 + 回收（审查确认全是新代码）
- `dispatch_session(db, &session, payload)` 按 `session.agent_backend` 选 dispatcher（现状硬编码 `PushDispatcher`，签名是 `(db, session_id, payload)` → 改取 session 读 agent_backend）。新增 `RunnerDispatcher impl SessionDispatcher`（只 `assign_runner`，不 POST）。
- reaper（`dev_session_reaper.rs`）现状是 push 容量派发；改为对 `autopilot_selfhosted` 只**批量 assign_runner**（含选 runner 策略，MVP=定向指定）+ 新增**拉模型回收**（§4.2）。
- `GET /sessions/pending` 长轮询用 **`tokio::broadcast`**（复用 `ws.rs` `DevSessionBroadcaster` 先例）+ **原子 claim**（条件 UPDATE）+ **last-chance 重查**。⚠ broadcast 是**进程内**的——reqgenie 多实例下跨实例叫醒失效，**last-chance 重查是多实例下唯一保障**（故 `wait` 不宜过长，50s 可接受）。
- `pr_created` 事件：`ingest_worker_event` 现状无此分支，**新增**写 `dev_sessions.pr_url`（+ 可选存 stage_artifact(kind=pr)）。

### 5.3 阶段放开
创建时 `max_stage` 现状硬编码 `PHASE1_MAX_STAGE='ui_review'`；改为 `agent_backend=='autopilot_selfhosted' ? 'pr' : PHASE1_MAX_STAGE`。`next_stage()` 逻辑本就支持任意 max_stage，仅创建入口要按 backend 分。dev/pr 阶段后端摄取（`worker_ingest_event`）现状只认 spec/review 类事件，需确认对 stage=dev/pr 的 stage_artifact/gate 正常落库。

### 5.4 前端
Runner 管理页（`runner_manage`）：列表 + revoke + 生成注册 token（给 `autopilot runner register` 命令，提示 stdin 输入）。需求详情「AI 开发」：`agent_backend` 选择 + 选 `autopilot_selfhosted` 时多「目标 runner ▾[在线机器]」。dev/pr 的 gate 卡（diff 预览 / PR 确认）复用现有 gate 卡。

### 5.5 单需求单活跃 session（现状缺失，须新增）
现状创建端不拒同需求第二个会话。新增 partial unique index `uq_dev_sessions_active_per_req ON dev_sessions(requirement_id) WHERE status NOT IN ('completed','failed','cancelled')` + 创建前 409 校验。A 模式只有 dev_sessions 一条通道，故 B 模式「跨通道互斥」blocker 不存在。

## 6. autopilot 侧改造

### 6.1 新模块 `src/daemon/runner/`（协议客户端）
- `registration.ts`：`autopilot runner register --url <reqgenie>`（token 走 stdin/env/交互）→ 换凭证 → 落 `AUTOPILOT_HOME/runner/credentials.json`（**平台 ACL 收紧**，非纯 `0o600`——NTFS 上无效；顺带修 `auth.ts:33` 同款）。
- `poller.ts`：检测凭证 → 抢 `runner.lock`（复用 `pid.ts`）→ runner 心跳 + 长轮询 `/sessions/pending`（jitter 退避）。**单 session 自律**：领到 session 后停止 `/pending` 长轮询直到本 session 终态（避免 claim 第二个跑不动的 session 卡 queued；多 session 并发留 R3）。
- `session-loop.ts`：**TS 移植 agent-worker `sessionLoop.mjs`**（§4.3），依赖注入 `backend` 适配器。⚠ 须与 agent-worker 行为对齐（seq 不自定、gate_id 匹配、围栏化），PR 带**对齐证明**（mock backend 同事件流的一致性测试）。
- `rounds.ts`：`runRound` 按 stage 分派（§4.5）。

### 6.2 新模块 `src/core/executor/`（复用三块，**剥离状态机/DB 副作用**——审查重点）
| 文件 | 包装 | 改造（审查纠正：不是「加个参数」） |
|------|------|------|
| `sandbox.ts` | `ensureCodebase(sessionId, repos, {fidelity, deliverBranch, gitToken})` | clone 链路全程**透传注入 token**（现状 `resolveGitToken` 无入参点，cloneRepo→cloneOneRepo 多层要穿透）；目录键用 sessionId（无 autopilot reqId）；clone 后仍抹 origin 凭证（零痕迹） |
| `agent-runner.ts` | `Agent.run` 包在 `runWithTaskContext` 内 | `Agent.run` 现状无 ctx null 守卫——加守卫；executor wrapper 显式 `runWithTaskContext({taskId,phase,sandboxDir},…)`。**幽灵 task**：不建 task 行（避免 `createTask` emit `task:created` 造 WS 幻影），用临时 taskId 仅落 `.worktree.json`+`agent-calls.jsonl`；pr 成功后由 runner 外壳按需补建真 task 行记录交付 PR |
| `submit-pr.ts` | `submitPR(repos, {title, body, gitToken}) → [{repo,prUrl}]` | **拆 `builtin-deliver-pr.ts`**：现状它**不纯**（含 `transition`/`updateTask`/`updateRequirement`/`appendSubPr` 写库）——抽出「git+gh 机械层」给 executor，状态机/DB 副作用层留给 autopilot 原 workflow。push/PR 注入 token（拼 auth URL 或 `GH_TOKEN`，用后即抹）；**push 前现取 token**（防 1h 过期） |

事件：executor 三块本身**无 phase:\* 事件**（`codebase.ts`/`builtin-deliver-pr.ts` 零 emit，`agent.ts` 仅 agent-call 日志）——只要不复用 `runner.ts` 的 `executePhase`（它发 phase:started/completed/error）即可；phase 级编排事件由 session-loop 层负责，与 `requirement-task-bridge` 隔离。

### 6.3 runner 模式开关（绕开状态机）
`config.yaml` `mode: runner` 时，daemon 入口**不启动** `requirement-scheduler`/`requirement-task-bridge`/`run-outcome`/`clarifier`——需求/阶段状态全由 reqgenie 事件协议驱动。传统 scheduler daemon 与 runner daemon 两套启动流程分离。

### 6.4 CLI / config
`autopilot runner register|start|status|stop|remove`；`config.yaml` 加 `runner:` 段（control_plane_url / poll_wait / 间隔 / name / mode），凭证单独落盘。

## 7. 端到端时序
1. **注册**：admin 生成 token → 机器 `autopilot runner register`（stdin token）→ 换凭证 + 抢 runner.lock → poller 上线。
2. **下发**：需求详情「AI 开发」选 `autopilot_selfhosted` + 目标 runner → 建 dev_session(created, assigned_runner)。
3. **领活**：该 runner `/sessions/pending` 长轮询原子 claim → queued → running；领到后停止 /pending。
4. **执行（回合循环）**：clarify→spec→…→dev→pr，每 round 回写事件（后端定 seq），gate 处等人审（飞书/web，30s 轮询感知），驳回带评论增量重做。
5. **dev/pr**：dev 用 vend token clone(full,`reqgenie/<sid>`)+改码+`git diff`→dev gate；pr checkout 交付分支+commit+push+开 PR→`pr_created`→后端写 pr_url→done。
6. **验收**：人 review PR，merge 签字；spec_md 已同步 `requirements.implementation_plan`。

## 8. 安全
- **8.1 注册**：一次性 token、哈希存储、`consumed_at`+`FOR UPDATE` 防并发重放；token 经 stdin 不进 history；register 记录 `machine_meta`/`registered_by`。
- **8.2 runner 凭证**：独立 per-runner secret、`secret_hash` 存储、**revoke 端点**（删即作废）、落盘平台 ACL。被盗→冒领 assigned session/伪造回写，靠 revoke + `pr_created` 的 owner/repo 归属校验（PR 须属 session.repos）兜。
- **8.3 vend token**：installation token 按仓收窄、1h、push 前现取、用后即抹、不进 dispatch payload。
- **8.4 下发文本=本机 agent 指令**：session 文本驱动本机 bypassPermissions agent，故 reqgenie 控制平面及鉴权是本机安全边界一部分，注册防冒充是 MVP 必需。

## 9. 范围与分期
**MVP（R1）**
- reqgenie：060/061/062 迁移 + dispatch 多态(push_dispatch/assign_runner) + RunnerDispatcher + `/runners/register|heartbeat` + `/sessions/pending`(长轮询+原子claim) + **拉模型回收 reaper** + revoke + `pr_created` 摄取 + max_stage=pr(按 backend) + 单需求单活跃 session + `runner_manage` + 前端。
- autopilot：`src/daemon/runner/`(注册+poller+session-loop 移植+rounds) + `src/core/executor/`(三块**含 token 注入 + 副作用剥离 + dev/pr commit-push 拆分**) + runner.lock + `mode:runner` 开关 + CLI/config。
- **R1 正确性（审查从 R2 提上来）**：成本闸门（round 超时/STAGE_MAX/SESSION_MAX/limit_hit）、dev 中间态重启安全（重入 reset 基线）、rework 增量沙箱契约、交付分支命名不变式。
- 跑通 clarify→spec→dev→pr 全链路（复用 reqgenie 事件/gate/飞书）。

**R2**：eng_review/ui_review round 完善 + session 内等待统一长轮询(替 30s) + clone 升级优化 + 打断恢复打磨 + 多 runner 体验。
**R3**：WebSocket 派发 + labels 路由 + 单 runner 多 session 并发 + 非对称 runner 鉴权。

## 10. 已知权衡
1. autopilot 编排层（scheduler/workflow/状态机/自家 fix-runner）在 A 模式闲置；换来复用 reqgenie 成熟协议、风险大降。autopilot 贡献执行核（clone 零污染 + 多 provider AI + PR）。
2. agent_backend 是 session 级：autopilot session 跑全部 stage（含 clarify/spec/review），须实现这些 round（不止 dev/pr）。
3. D6 vend token 是 R1 实打实改造（token 全链路 + push/PR 注入 + 现取）；换来组织私有仓可靠。
4. 回合循环 TS 移植须与 agent-worker 行为对齐（测试保障，漂移隐蔽）。
5. dev 只产 diff / pr 才 push 是对现有 commit+push 一体逻辑的拆分。

## 11. 测试要点
- reqgenie：dispatch 按 backend 选择 · `/sessions/pending` 原子 claim 并发只一赢 + last-chance · **拉模型回收（claim 后 runner 静默→reaper 回退 created→重新可 claim）** · 注册 token 一次性+并发重放拒 · revoke 后 401 · max_stage=pr 放开 · `pr_created` 写 pr_url · 单需求单活跃 session 409。
- autopilot：session-loop 移植与 agent-worker 行为对齐(seq/gate_id/围栏) · executor 三块脱状态机(无 phase:\*/task:created 误发) · token 注入 clone+push/PR + push 前现取 · dev 只产 diff、pr 才 push · **dev 中间态重启重入 reset 基线** · rework 命中既有脏树增量 · 交付分支命名恒定 · runner.lock 防双实例 · 凭证 ACL · 成本闸门触顶产 limit_hit。
- 端到端：注册→下发到指定机器→clarify/spec(gate)→dev(diff gate)→pr(PR)→merge；驳回→增量 rework；runner 重启→事件流续 + 本地重入安全；session 取消→409 优雅退出。

## 12. 为何 A 优于 B（blocker 蒸发对照 + 审查校正）
| B 模式 blocker | A 模式现状 |
|---|---|
| 回写乱序把 done 打回 running | reqgenie seq 后端定序、事件流唯一事实源——**不存在** |
| job 状态机缺 fix 回路 | reqgenie 阶段机 + gate rework_target_stage——**现成** |
| 重连对账自造 | agent-worker `after_seq` 拉式对账——**现成**（但**本地脏树续作不在其内**，§4.5 重入 reset 解决） |
| runner_lost 脑裂 | ⚠ **非「现成」**（审查纠正）：拉模型需新增 reaper 回收（session 回退 created 等重领，§4.2），比 B 的 orphaned 简单但仍是新代码 |
| 双执行路径无互斥出两份 PR | 只有 dev_sessions 一条通道 + 单需求单活跃 session——**不存在** |
| `ensureWorkspaceByRemote` 不存在 | executor 用 `ensureCodebase`+payload repos——**不需要** |
| `awaiting_review` 事件臆造 | autopilot 发 reqgenie 协议事件——**不适用** |
| D6 本机 gh 对组织私有仓没权限 | reqgenie vend installation token——**解决**（但注入是 R1 实打实改造，§D6） |

A 模式真正新增面（比 B 小、稳）：**注册 + 拉式派发 + 拉模型回收 reaper** · **dev/pr round 实现（含 commit/push 拆分、diff、交付分支命名）** · **executor 三块抽取（token 注入 + 副作用剥离 + 幽灵 task）** · **成本闸门 + dev 重启安全** · 注册安全。

## 13. 对抗性审查纪要
- **rev1→rev2（B 模式）**：4 路审查挖 9 blocker（claim 原子/fix 回路/seq 防回放/orphaned 脑裂/跨通道互斥/注册防冒充/凭证 revoke/ensureWorkspaceByRemote/awaiting_review 臆造）+ 一批 major，全修于 B 模式 spec（git f9ccbde）。
- **A 模式切换**：用户定 A（reqgenie 为大脑），B 模式 9 blocker 大半因复用 reqgenie 成熟协议而蒸发（§12）。
- **rev3（A 模式）3 路审查**：未发现推翻 A 架构的问题；纳入 major/minor 修正——拉模型 reaper 回收（非现成）、D6 token 注入是真改造、dev 中间态重启安全、交付分支命名源、rework 增量沙箱契约、dev/pr commit-push 拆分、executor 三块副作用剥离（submitPR 不纯/幽灵 task emit）、成本闸门提到 R1、session 等待 30s 延迟取舍、多实例 broadcast 仅 last-chance 兜底、runner 忙则停领。
