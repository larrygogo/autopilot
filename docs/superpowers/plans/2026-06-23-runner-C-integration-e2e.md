# Runner 计划 C — 端到端集成与验收 Implementation Plan

> ## ⚠️ 审查修正（执行前必读，覆盖下方对应处）
> **定位澄清（重要）**：C 是**最终集成计划**，硬性执行顺序 = **A1 → A2 → B → C**。C 的各 Task 依赖前三者已实现——这是设计意图，**不是缺陷**（审查把「A1/A2/B 代码还不存在」当 blocker 是把计划当已落地代码的误读）。修正如下：
> 1. **[blocker→改前置守卫] 每个 Task 开头加前置检查**：缺 `src/core/executor/index.ts`（A1）/ `src/daemon/runner/session-loop.ts`（A2）/ `reqgenie backend/migrations/060_runners.sql` 等（B）则 `exit 2` 打印「前置阻塞：X 未落地，请先完成对应计划」，**而非当失败**。
> 2. **[blocker] mock control plane 的 `claimAny` 在 Task 2 当场实现**（不是拖到 Task 6）：`#claimAny` 字段 + `enableClaimAny()` + pending 端点判据 `(this.#claimAny || s.assigned_runner===rid) && s.status==='created'`；Task 2 加第 5 个测试验证 claimAny；Task 6 runner-smoke 用 `cp.enableClaimAny()` 后任意 runner 可领（解决「脚本拿不到 daemon 内真实 runner_id」）。
> 3. **[major·已修正] gate 驳回评论传递（对齐 agent-worker，见 spec §14.4）**：评论放 **`gate_decided` 事件的 `payload.comment`**，session-loop 读到 `gate_decided(rejected)` 时直接 `accumulated += payload.comment`（agent-worker `sessionLoop.mjs` 原样）。mock `decideGate` 把 comment 落进 `gate_decided` 事件 payload 即可——**不另追加 `user_message` 事件**（本条早先「追加 user_message」的说法作废）。
> 8. **[blocker·安全·见 spec §14.1] mock 内部 API 鉴权用 runner secret**：mock-control-plane 的 `/api/internal/dev-sessions/{id}/*`（events/git-token/heartbeat）**用 per-runner secret + 会话归属校验**，不用全局 `DEV_SESSION_WORKER_SECRET`（与 A2 `backend.ts` 对齐；全局 worker secret 不下发 runner 机器）。
> 9. **[major·见 spec §14] 其余跨契约修正**：B 摄取补 `session_failed`/`limit_hit`；迁移 CHECK 含 `kind=dev/pr` + 全 7 stage；`assigned_runner` 在 create_session 落库；`PendingSession` 含 `status`。C 的契约测试（Task 4）按 spec §14 校这些。
> 4. **[major] CI 契约测试 = 多仓 checkout（方案 a）**：Task 10 CI 用 `actions/checkout` 把 reqgenie checkout 到同级 `../reqgenie`，保持 052 枚举单一真理来源（不用 fixture，避免漂移）。
> 5. **[major] Task 9 验收脚本两阶段**：先前置检查（A1/A2/B 落地？缺则 `exit 2` 报「前置阻塞」），再跑机检——避免「11 项全红」被误读成 C 有缺陷。
> 6. **[major] live e2e（Task 7）开头加 smoke 检查**：后端 `/api/health` 可达 + JWT 有效（GET 需求）+ runner 在线；任一不过即 `fail` 明确报因，避免轮询 30min 后以 `limit_hit` 掩盖 token 过期/权限问题。
> 7. **[minor] 端口从 `docker-compose.dev.yml` 读**（不硬写 5433/6379）；Task 5 `build_state` 与 reqgenie 真实 `AppState` 字段对齐核对（建议抽 `backend/tests/common/mod.rs` 公用）。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to run this plan task-by-task. 本计划偏「联调 / e2e / 契约一致性 / 验收勾稽」，不引入新功能代码——它把 A1（executor 核）+ A2（autopilot runner 协议客户端：注册 / poller / session-loop / rounds）+ B（reqgenie 侧改造：迁移 / dispatch 多态 / `/sessions/pending` / 拉模型回收 / `pr_created` / max_stage=pr / 单需求单活跃 session）接通，跑通 spec §7 时序 + §11 e2e 场景，最后勾稽 spec §9 R1 验收清单。步骤用 checkbox（`- [ ]`）追踪。

**Goal:** 给 reqgenie-runner（A 模式）提供**可重复执行的联调启动手册 + 三层自动化验证**：① 一条 `bun run runner-smoke` 离线契约冒烟（无 reqgenie / 无 GitHub，纯 mock control-plane，断言 autopilot 侧 session-loop / executor 三块 / runner CLI 的行为）；② 一份 reqgenie 侧 `cargo test --test runner_e2e -- --ignored` 真库（PG+Redis）集成测试（断言 B 侧注册 / 拉式 claim / 拉模型回收 / `pr_created` / max_stage=pr / 单活跃 session）；③ 一条 `bun run runner-e2e-live`（标注**需真 reqgenie 后端 + 真 GitHub 私有仓**）的全链路 e2e（注册 → 建 session → clarify→spec(gate)→dev(diff gate)→pr(出 PR)→merge→done，含驳回增量 rework / runner 重启续作 / session 取消 409 / token 过期重取四条失败路径）。最后输出可勾稽的 R1 验收清单脚本 `bun run runner-acceptance`。

**Architecture:** C 是**验证层**，不改 A1/A2/B 的实现。它建立三道防线：
- **契约一致性测试（mockable，CI 可跑）**：autopilot 的 `session-loop.ts`（A2 从 `agent-worker/sessionLoop.mjs` 移植）必须与参考实现**行为逐字对齐**——同一组事件流喂进两边、断言产出 reason/rounds/accumulated 完全一致（防移植漂移，spec §11「session-loop 移植与 agent-worker 行为对齐」+ §6.1 「PR 带对齐证明」）。
- **reqgenie 真库集成（需 PG+Redis，CI 可选）**：复用 reqgenie 既有 `dev_session_http.rs` 的 env 驱动 setup_db 模式（`ORCH_PG`/`ORCH_REDIS` + `--ignored`），新增 `runner_e2e.rs` 专测 B 侧新端点与回收逻辑。
- **全链路 live e2e（需真后端+真 GitHub，人工/夜间）**：用 `mock-control-plane` 不可替代的部分（真飞书/真 gate/真 PR merge）由手册 + 半自动断言脚本覆盖，标注清楚哪步要人点 gate。

**Tech Stack:** autopilot 侧 Bun + TypeScript（`bun:test`、Bun.spawn 子进程）；reqgenie 侧 Rust + `cargo test` + `axum_test::TestServer` + sqlx（真 PG/Redis）；联调用 docker-compose.dev.yml（PG 5433 / Redis 6379）+ git/gh CLI。

**Spec:** `docs/superpowers/specs/2026-06-23-reqgenie-runner-design.md`（§7 端到端时序、§11 测试要点、§4 协议、§9 R1 范围、§4.5 stage→runRound 沙箱契约、§4.3 回合循环、§D6 token）。

**前置依赖（C 在它们之后执行）：**
- A1 已落地（`src/core/executor/`：`git-ops.ts` / `submit-pr.ts` / `agent-runner.ts` / `index.ts` + `codebase.ts` 的 `pickCloneToken`/`gitToken`）——见 `docs/superpowers/plans/2026-06-23-runner-A1-executor-core.md`。
- A2 已落地（`src/daemon/runner/`：`registration.ts` / `poller.ts` / `session-loop.ts` / `rounds.ts`；CLI `autopilot runner register|start|status|stop|remove`；`config.yaml` 的 `mode: runner` + `runner:` 段；`runner.lock`）——见 spec §6.1/§6.3/§6.4。
- B 已落地（reqgenie 迁移 060/061/062 + `RunnerDispatcher` + `/api/runners/register|heartbeat|deregister` + `GET /api/runners/{id}/sessions/pending` 原子 claim + 拉模型回收 reaper + `pr_created` 摄取 + max_stage=pr + 单需求单活跃 session + `runner_manage` + 前端）——见 spec §5。

**关键既有事实（实现前必读，已核对）：**
- **reqgenie e2e 测试模式**：`backend/tests/dev_session_http.rs:33-68` —— env 驱动（`ORCH_PG`=`postgresql://user:pwd@host:port` 不含库名、`ORCH_REDIS`），`#[ignore = "需要 ORCH_PG + ORCH_REDIS 真实服务"]`，`setup_db(base)` 建全新库 `reqgenie_e2e_http` 并按文件名排序应用 `migrations/*.sql`（`let _ = sqlx::raw_sql(...)` 忽略个别 CONCURRENTLY 失败）。`build_state(pool, redis_url)` 装配完整 `AppState`（含 `DevSessionBroadcaster::new()`）。worker 内部端点鉴权用 `DEV_SESSION_WORKER_SECRET`（`dev_session_http.rs:161` `set_var`）。
- **dev_session 协议事实源**：迁移 `backend/migrations/052_dev_sessions.sql` —— status 枚举 `created|queued|running|waiting_input|waiting_gate|paused|completed|failed|cancelled`；current_stage 枚举 `clarify|spec|eng_review|ui_review|dev|pr|done`；event_type 枚举含 `assistant_message|stage_change|gate_opened|gate_decided|clarification_requested|user_message|stage_artifact|limit_hit|session_cancelled|dispatch_failed|...`；`seq` 由后端 advisory 锁内分配（`uq_dev_session_events_seq`）；gate `uq_dev_session_gates_pending`（同 session 同 stage 仅一未决）。
- **dev_session 路由**：`backend/src/routes/dev_sessions.rs:47-92` —— JWT 路由 `/api/dev-sessions/{id}`（get/events/messages/gates/{gid}/decision/cancel/resume）+ 需求路由 `POST /api/requirements/{req_id}/dev-sessions`（创建，body `{ agent_backend, repo_ids? }`，返回 `data.id/status/current_stage/agent_backend`）；worker 内部路由 `/api/internal/dev-sessions/{id}/events`（post `worker_ingest_event` / get `worker_list_events`）、`/{id}`（`worker_get_session`）、`/{id}/heartbeat`、`/{id}/git-token?repo_id=`。
- **gate / 终态守卫已验证**：`dev_session_http.rs:251-458` —— `open_gate` + `/gates/{gid}/decision` CAS（重复裁决 409）；`approved` 推进 stage、`rejected` 必带 comment（缺则 400）；worker 回写 `gate_opened` 后端注入 `payload.gate_id`、at-least-once 重发幂等复用同一 gate_id；`stage_artifact(kind=spec)` 暂存 `spec_md`、approve 时同步 `requirements.implementation_plan`（冻结开关卡时的快照，非后改 v2）；终态 session 拒绝 worker 事件 → 409。
- **派发现状**：`backend/src/services/worker_client.rs:170` `dispatch_session(db, session_id, payload)` 硬编码 `PushDispatcher`（`SessionDispatcher` trait `:184`，对象安全）。`backend/src/services/dev_session_reaper.rs` —— `heartbeat_timeout_s()`（默认 90，`DEV_SESSION_HEARTBEAT_TIMEOUT_S`）、`max_active()`、`working_count()`、`tick(db)` 用 `pg_try_advisory_xact_lock`；心跳超时 → fail_batch。**B 会新增 runner 级心跳超时 → session 回退 created**（spec §4.2 拉模型回收）。
- **agent-worker 参考实现（A2 移植源 + C 对齐基线）**：`agent-worker/src/sessionLoop.mjs` —— `runSessionLoop({ backend, queue, ctx })` 返回 `{reason: 'approved'|'terminal'|'max_rounds', rounds}`；`backend` 适配器三方法 `postEvent(ev)→{...,seq,gate_opened注入gate_id}` / `fetchEvents(afterSeq)→事件升序` / `fetchSession()→{status,current_stage,spec_md}`；`SignalQueue`；`maxRounds` 默认 10、`pollMs` 默认 30000。其测试 `agent-worker/test/sessionLoop.test.mjs` 是行为契约（8 个用例：澄清闭环 / 丢信号轮询兜底 / 伪造 gate_id 不生效 / 驳回带评论重做 / session_cancelled 优雅退出 / maxRounds 兜底 / 多人插话按 seq 序）。
- **autopilot daemon 子进程模式**：`tests/daemon-startup-gate.test.ts:46-62` —— `Bun.spawn(["bun","run", "src/daemon/index.ts"], {cwd: REPO_ROOT, env: {...process.env, AUTOPILOT_HOME: home}})` + `Promise.race([proc.exited, Bun.sleep(ms).then(()=>{proc.kill();return -1})])`；每用例独立端口 + 临时 `AUTOPILOT_HOME`（`mkdtempSync`）+ `afterAll` 清理（Windows zombie LISTEN 注意）。
- **autopilot 既有 smoke-test 模式**：`scripts/smoke-test.ts` —— `runCli(args, expectedExit)` 用 `Bun.spawnSync(["bun","run","bin/autopilot.ts",...args], {env:{AUTOPILOT_HOME:tmpHome}})`、`assertContains`、`cleanup()`、失败立即 `process.exit(1)`。是 C 的 runner-smoke 模板。
- **autopilot client**：`src/client/index.ts:18` `AutopilotClient`（`connect/disconnect/subscribe`），`src/client/http.ts` HTTP RPC 面。C 的 live e2e 用它驱动 daemon。
- **docker-compose.dev.yml**：PG `postgres:16-alpine` 映射宿主 `5433:5432`（库/用户/密码均 `reqgenie`，`POSTGRES_HOST_AUTH_METHOD=trust`，挂 `./backend/migrations` 到 initdb），Redis `7-alpine` `6379:6379`。reqgenie 测试连接串 `postgresql://reqgenie:reqgenie@127.0.0.1:5433`、`redis://127.0.0.1:6379`。
- **git-token 端点**：`dev_sessions.rs:198-269` `worker_git_token` —— `?repo_id=` 须 ∈ session.repos（否则 400），installation_id 现签 1h token、否则 PAT 兜底、都无 → 400。

---

## File Structure

**autopilot 仓（`C:\Users\larry\Desktop\workspace\autopilot`）**
- Create `scripts/runner/mock-control-plane.ts` — 内存版 reqgenie control-plane（HTTP server）：实现 spec §4.1/§4.2 端点子集（`POST /api/runners/register`、`POST /api/runners/{id}/heartbeat`、`GET /api/runners/{id}/sessions/pending`、`POST /api/internal/dev-sessions/{id}/events`(后端定 seq + 注入 gate_id)、`GET …/events?after_seq=`、`GET …/dev-sessions/{id}`、`GET …/git-token`、`POST …/heartbeat`），可脚本化「派一个 session」「裁决 gate」「取消 session」「让 runner 心跳超时回收」。给 runner-smoke 当被测对端。无 PG、无飞书、无 GitHub。
- Create `scripts/runner/runner-smoke.ts` — 离线契约冒烟脚本：起 mock-control-plane → `bun run bin/autopilot.ts runner register`（stdin token）→ 起 `mode:runner` daemon → 派一个 dev_session（clarify→spec→dev→pr，dev/pr 用 file:// bare 远程当 GitHub 替身、gh 步骤桩）→ 断言事件流出现 `pr_created` + session done。纯本机，CI 可跑。
- Create `tests/runner-session-loop-conformance.test.ts` — 契约一致性测试：把 `agent-worker/test/sessionLoop.test.mjs` 的 8 个事件剧本喂给 autopilot `src/daemon/runner/session-loop.ts`，断言 reason/rounds 与参考实现一致（防移植漂移）。
- Create `tests/runner-protocol-contract.test.ts` — 协议枚举对齐校验：断言 autopilot `rounds.ts` 产出的 event_type / stage 值落在 reqgenie 052 迁移定义的枚举集合内（从迁移文件解析枚举，单一真理来源防双侧漂移）。
- Create `scripts/runner/runner-e2e-live.ts` — 全链路 live e2e（标注需真 reqgenie+真 GitHub）：半自动，跑到 gate 处暂停等人点（或读环境变量 `RUNNER_E2E_AUTO_APPROVE` 调真后端 gate decision API 自动批），断言每阶段事件 + 最终真 PR url。
- Create `scripts/runner/runner-acceptance.ts` — R1 验收清单勾稽（spec §9 R1 逐条 check，机检项自动跑、人工项打印待办）。
- Create `docs/runner-integration-guide.md` — 联调启动手册（起 PG/Redis、起 reqgenie 后端、迁移、起 autopilot `mode:runner` daemon、注册、建 session、看链路）。
- Modify `package.json` — 加 scripts：`runner-smoke` / `runner-e2e-live` / `runner-acceptance`。

**reqgenie 仓（`C:\Users\larry\Desktop\workspace\reqgenie`）**
- Create `backend/tests/runner_e2e.rs` — B 侧真库集成测试（env 驱动 `ORCH_PG`/`ORCH_REDIS`，`--ignored`），复用 `dev_session_http.rs` 的 setup_db/build_state 模式，专测：注册 token 一次性+并发重放、revoke 后 401、dispatch 按 backend 选择、`/sessions/pending` 原子 claim 并发只一赢 + last-chance、拉模型回收（claim 后 runner 静默→reaper 回退 created→重新可 claim）、max_stage=pr、`pr_created` 写 pr_url、单需求单活跃 session 409。

---

## Task 1：联调启动手册 `docs/runner-integration-guide.md`

把「本地起全套 → 注册 → 下发 → 看链路」固化成确切命令，后续所有 e2e 都引用它。手册先行，因为 Task 3/5 的 live e2e 依赖它描述的环境。

**Files:**
- Create: `docs/runner-integration-guide.md`

- [ ] **Step 1：写手册**

写入以下完整内容（命令均已对照两仓既有事实，非占位）：

````markdown
# ReqGenie Runner 本地联调手册（A 模式）

> 把 reqgenie（大脑）与 autopilot（自托管 runner）在本机接通，跑通 clarify→spec→dev→pr 全链路。
> 对应设计：`docs/superpowers/specs/2026-06-23-reqgenie-runner-design.md` §7。

## 0. 端口与连接串约定（与两仓测试一致）

| 服务 | 地址 | 来源 |
|------|------|------|
| PostgreSQL | `postgresql://reqgenie:reqgenie@127.0.0.1:5433/reqgenie` | reqgenie `docker-compose.dev.yml` |
| Redis | `redis://127.0.0.1:6379` | 同上 |
| reqgenie 后端 | `http://127.0.0.1:3001` | reqgenie `BACKEND_PORT` |
| autopilot daemon | `http://127.0.0.1:6180` | autopilot 默认 |

## 1. 起 PG + Redis（reqgenie 仓）

```bash
cd C:/Users/larry/Desktop/workspace/reqgenie
docker compose -f docker-compose.dev.yml up -d
# 等就绪
docker exec reqgenie-postgres pg_isready -U reqgenie    # 期望 "accepting connections"
docker exec reqgenie-redis redis-cli ping               # 期望 PONG
```

迁移：`docker-compose.dev.yml` 已把 `./backend/migrations` 挂到 PG 的 initdb 目录，**首次** `up` 时按文件名排序自动应用全部迁移（含 B 的 060/061/062）。若库已存在需重置：`docker compose -f docker-compose.dev.yml down -v && docker compose -f docker-compose.dev.yml up -d`。

## 2. 起 reqgenie 后端（真后端，本地）

```bash
cd C:/Users/larry/Desktop/workspace/reqgenie/backend
# 本地开发连接串（不进 Docker），见 .env.example 注释段
export REQGENIE__DATABASE__URL=postgresql://reqgenie:reqgenie@127.0.0.1:5433/reqgenie
export REQGENIE__REDIS__URL=redis://127.0.0.1:6379
export REQGENIE__JWT__SECRET=integration-test-secret-key-2024
export REQGENIE__AI__API_KEY=<你的 claude key>          # clarify/spec round 真跑 AI 才需要
export DEV_SESSION_WORKER_SECRET=dev-worker-secret       # session 内部 API 鉴权（runner 也用它访问 events/git-token）
export GITHUB_APP_PRIVATE_KEY=<App 私钥 PEM>             # 私有仓 vend token 才需要（§D6）
cargo run --release
# 期望日志：listening on 127.0.0.1:3001
```

健康检查：`curl -s http://127.0.0.1:3001/api/health`（或既有探针路由）。

## 3. 起 autopilot daemon（runner 模式）

`AUTOPILOT_HOME/config.yaml` 加 runner 段（spec §6.4）：

```yaml
mode: runner
runner:
  control_plane_url: http://127.0.0.1:3001
  name: dev-laptop
  poll_wait: 50          # /sessions/pending 长轮询秒
```

```bash
cd C:/Users/larry/Desktop/workspace/autopilot
bun run build:web                                # web-dist 是 gitignore 产物
autopilot daemon run                             # mode:runner → 不起 scheduler/bridge/clarifier（§6.3）
# 期望日志：autopilot daemon ... started + runner poller 待注册
```

## 4. 注册 runner

reqgenie 管理端生成一次性注册 token（15min，需 `runner_manage` 权限）：

```bash
# 管理员 JWT 调（或在 reqgenie 前端「Runner 管理」页点「生成注册 token」）
curl -s -X POST http://127.0.0.1:3001/api/admin/runners/registration-token \
  -H "Authorization: Bearer <admin-jwt>" | jq -r .data.token
```

机器侧注册（token 走 stdin，不进 shell history，§8.1）：

```bash
printf '<注册token>' | autopilot runner register --url http://127.0.0.1:3001
# 期望：换得 per-runner 凭证写入 AUTOPILOT_HOME/runner/credentials.json，poller 上线、runner 心跳开始
autopilot runner status                          # 期望：online，control_plane=...，runner_id=...
```

reqgenie 侧确认：`GET /api/runners`（admin）能看到该 runner `status=online`。

## 5. 下发一个 session 到本 runner

reqgenie 前端「需求详情 → AI 开发」选 `agent_backend = autopilot_selfhosted` + 目标 runner = `dev-laptop`，建 dev_session。或 API：

```bash
curl -s -X POST http://127.0.0.1:3001/api/requirements/<req_id>/dev-sessions \
  -H "Authorization: Bearer <dev-jwt>" \
  -H "Content-Type: application/json" \
  -d '{"agent_backend":"autopilot_selfhosted","assigned_runner":"<runner_id>","repo_ids":["<repo uuid>"]}'
# 期望：data.status=created, data.current_stage=clarify, data.agent_backend=autopilot_selfhosted
```

## 6. 观察全链路

- runner 长轮询 `/sessions/pending` 原子 claim → session `created→queued→running`（领到后停止 /pending）。
- 每 stage 一轮：clarify（飞书/web 答澄清）→ spec（gate 等人审）→ dev（diff gate）→ pr（出 PR，`pr_created` 事件 → 后端写 `dev_sessions.pr_url`）→ `done`。
- 看事件流：`GET /api/dev-sessions/<sid>/events?after_seq=0`（JWT）。
- gate 裁决：reqgenie 前端 gate 卡点「通过/驳回」，或 `POST /api/dev-sessions/<sid>/gates/<gid>/decision {"decision":"approved"}`。

## 7. 收尾

```bash
autopilot runner stop                             # 释放 runner.lock，deregister
docker compose -f docker-compose.dev.yml down     # 留 -v 才删数据卷
```

## 故障对照

| 现象 | 排查 |
|------|------|
| runner register 401 | 注册 token 过期（15min）/ 已被消费（一次性）→ 重新生成 |
| session 卡 created 不领 | 检查 `assigned_runner` 是否=本 runner_id；runner 是否在线（`/api/runners`）；poller 是否因正忙跑别的 session 而停领（单 session 自律，§6.1） |
| dev/pr git fatal | 老 dev workflow 副本统一子目录布局未同步——A 模式不用 dev workflow，确认走 executor 路径而非 builtin |
| push/PR 403 | vend token 未注入或过期（§D6 push 前现取）；私有仓需 `GITHUB_APP_PRIVATE_KEY` + 仓库装 App |
````

- [ ] **Step 2：校验手册内引用准确**

Run（确认手册引用的端口/连接串与 reqgenie 真值一致）：
```bash
cd /c/Users/larry/Desktop/workspace/reqgenie && grep -nE '5433|6379|3001|reqgenie:reqgenie|DEV_SESSION_WORKER_SECRET|integration-test-secret' docker-compose.dev.yml .env.example backend/tests/dev_session_http.rs
```
Expected: 输出含 `5433:5432`、`reqgenie:reqgenie@127.0.0.1:5433`、`DEV_SESSION_WORKER_SECRET`、`integration-test-secret-key-2024` —— 与手册一致。

- [ ] **Step 3：提交**

```bash
cd /c/Users/larry/Desktop/workspace/autopilot
git add docs/runner-integration-guide.md
git commit -m "docs(runner): A 模式本地联调启动手册（起 PG/Redis+reqgenie 后端+runner 注册+下发链路）"
```

---

## Task 2：mock control-plane（autopilot 离线被测对端）

runner-smoke 需要一个不依赖 reqgenie/PG 的对端，实现 spec §4 协议子集，能脚本化驱动 session 状态机。

**Files:**
- Create: `scripts/runner/mock-control-plane.ts`
- Test: `tests/runner-mock-control-plane.test.ts`

- [ ] **Step 1：写失败测试**

```ts
// tests/runner-mock-control-plane.test.ts
import { test, expect, afterEach } from "bun:test";
import { MockControlPlane } from "../scripts/runner/mock-control-plane";

let cp: MockControlPlane | null = null;
afterEach(async () => { if (cp) { await cp.stop(); cp = null; } });

test("注册换凭证 + runner 心跳", async () => {
  cp = new MockControlPlane();
  await cp.start();
  const regTok = cp.issueRegistrationToken();
  const reg = await fetch(`${cp.url}/api/runners/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: regTok, name: "t1" }),
  });
  const body = (await reg.json()) as { data: { runner_id: string; secret: string } };
  expect(body.data.runner_id).toBeTruthy();
  expect(body.data.secret).toBeTruthy();
  // 一次性：同 token 再注册 401
  const again = await fetch(`${cp.url}/api/runners/register`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: regTok, name: "t2" }),
  });
  expect(again.status).toBe(401);
});

test("派 session → /sessions/pending 原子 claim 只一次返回 payload", async () => {
  cp = new MockControlPlane();
  await cp.start();
  const { runnerId, secret } = await cp.registerRunner("r1");
  const sid = cp.dispatchSession({ assignedRunner: runnerId, repos: [], stage: "clarify" });
  const h = { authorization: `Bearer ${secret}` };
  const r1 = await fetch(`${cp.url}/api/runners/${runnerId}/sessions/pending?wait=0`, { headers: h });
  expect(r1.status).toBe(200);
  const claimed = (await r1.json()) as { data: { session_id: string; status: string } };
  expect(claimed.data.session_id).toBe(sid);
  expect(claimed.data.status).toBe("queued"); // claim 翻 created→queued
  // 再领 → 无待派 → 204
  const r2 = await fetch(`${cp.url}/api/runners/${runnerId}/sessions/pending?wait=0`, { headers: h });
  expect(r2.status).toBe(204);
});

test("回写事件：后端定 seq + gate_opened 注入 gate_id", async () => {
  cp = new MockControlPlane();
  await cp.start();
  const { secret } = await cp.registerRunner("r1");
  const sid = cp.dispatchSession({ assignedRunner: "any", repos: [], stage: "spec" });
  const post = (ev: object) =>
    fetch(`${cp.url}/api/internal/dev-sessions/${sid}/events`, {
      method: "POST", headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify(ev),
    }).then((r) => r.json() as Promise<{ data: { seq: number; payload: Record<string, unknown> } }>);
  const e1 = await post({ event_type: "assistant_message", stage: "spec", actor: "agent", payload: { message: "x" } });
  const e2 = await post({ event_type: "gate_opened", stage: "spec", actor: "agent", payload: { stage: "spec" } });
  expect(e2.data.seq).toBeGreaterThan(e1.data.seq);
  expect(e2.data.payload.gate_id).toBeTruthy(); // 后端注入
});

test("裁决 gate / 取消 session 走事件流", async () => {
  cp = new MockControlPlane();
  await cp.start();
  const { secret } = await cp.registerRunner("r1");
  const sid = cp.dispatchSession({ assignedRunner: "any", repos: [], stage: "spec" });
  const opened = await fetch(`${cp.url}/api/internal/dev-sessions/${sid}/events`, {
    method: "POST", headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: JSON.stringify({ event_type: "gate_opened", stage: "spec", actor: "agent", payload: { stage: "spec" } }),
  }).then((r) => r.json() as Promise<{ data: { payload: { gate_id: string } } }>);
  cp.decideGate(sid, opened.data.payload.gate_id, "approved");
  const evs = await fetch(`${cp.url}/api/internal/dev-sessions/${sid}/events?after_seq=0`, {
    headers: { authorization: `Bearer ${secret}` },
  }).then((r) => r.json() as Promise<{ data: Array<{ event_type: string; payload: Record<string, unknown> }> }>);
  expect(evs.data.some((e) => e.event_type === "gate_decided" && e.payload.decision === "approved")).toBe(true);
});
```

- [ ] **Step 2：运行确认失败**

Run: `bun test tests/runner-mock-control-plane.test.ts`
Expected: FAIL —— `../scripts/runner/mock-control-plane` 不存在。

- [ ] **Step 3：实现 `scripts/runner/mock-control-plane.ts`**

```ts
// 内存版 reqgenie control-plane —— 实现 spec §4 协议子集，供 autopilot runner-smoke 当被测对端。
// 无 PG / 无飞书 / 无 GitHub。seq 后端定、gate_id 后端注入，与真 reqgenie 行为对齐（dev_session_http.rs 契约）。
import { randomUUID } from "crypto";

interface SessionState {
  id: string;
  assigned_runner: string;
  status: string;       // created|queued|running|waiting_input|waiting_gate|completed|failed|cancelled
  current_stage: string; // clarify|spec|eng_review|ui_review|dev|pr|done
  spec_md: string | null;
  pr_url: string | null;
  repos: Array<{ id: string; owner: string; repo_name: string; repo_url: string; default_branch: string }>;
}
interface EventRow { seq: number; event_type: string; stage: string | null; actor: string | null; payload: Record<string, unknown>; }

const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const STAGE_ORDER = ["clarify", "spec", "eng_review", "ui_review", "dev", "pr", "done"];

export class MockControlPlane {
  #server: ReturnType<typeof Bun.serve> | null = null;
  #regTokens = new Map<string, boolean>(); // token -> consumed
  #runners = new Map<string, { secret: string; name: string; lastHeartbeat: number; revoked: boolean }>();
  #sessions = new Map<string, SessionState>();
  #events = new Map<string, EventRow[]>();
  #seq = new Map<string, number>();
  #gates = new Map<string, { sessionId: string; stage: string; status: string }>(); // gate_id -> gate
  #workerSecret = "dev-worker-secret"; // session 内部 API（events/git-token/heartbeat）用全局 worker secret，与真后端一致
  #gitToken: string | null = null; // injectGitToken 设了才返回

  get url(): string {
    if (!this.#server) throw new Error("control-plane 未启动");
    return `http://127.0.0.1:${this.#server.port}`;
  }

  async start(port = 0): Promise<void> {
    this.#server = Bun.serve({ port, fetch: (req) => this.#handle(req) });
  }
  async stop(): Promise<void> {
    if (this.#server) { this.#server.stop(true); this.#server = null; }
  }

  // ── 脚本化驱动（测试/smoke 用，非 HTTP）──
  issueRegistrationToken(): string { const t = randomUUID(); this.#regTokens.set(t, false); return t; }
  async registerRunner(name: string): Promise<{ runnerId: string; secret: string }> {
    const tok = this.issueRegistrationToken();
    const r = await fetch(`${this.url}/api/runners/register`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: tok, name }),
    });
    const b = (await r.json()) as { data: { runner_id: string; secret: string } };
    return { runnerId: b.data.runner_id, secret: b.data.secret };
  }
  dispatchSession(opts: { assignedRunner: string; repos: SessionState["repos"]; stage?: string }): string {
    const id = randomUUID();
    this.#sessions.set(id, {
      id, assigned_runner: opts.assignedRunner, status: "created",
      current_stage: opts.stage ?? "clarify", spec_md: null, pr_url: null, repos: opts.repos,
    });
    this.#events.set(id, []); this.#seq.set(id, 0);
    this.#appendEvent(id, "stage_change", opts.stage ?? "clarify", "agent", { to: opts.stage ?? "clarify" });
    return id;
  }
  decideGate(sessionId: string, gateId: string, decision: "approved" | "rejected", comment = ""): void {
    const g = this.#gates.get(gateId);
    if (!g || g.sessionId !== sessionId || g.status !== "pending") throw new Error(`gate ${gateId} 不可裁决`);
    g.status = decision;
    this.#appendEvent(sessionId, "gate_decided", g.stage, "user", { gate_id: gateId, decision, comment });
    const s = this.#sessions.get(sessionId)!;
    if (decision === "approved") {
      const idx = STAGE_ORDER.indexOf(s.current_stage);
      const next = STAGE_ORDER[Math.min(idx + 1, STAGE_ORDER.length - 1)]!;
      s.current_stage = next;
      s.status = next === "done" ? "completed" : "running";
    } else {
      s.status = "running"; // 留本 stage 带评论重做
    }
  }
  injectUserMessage(sessionId: string, message: string, byName = "tester"): void {
    this.#appendEvent(sessionId, "user_message", null, "user", { message, by_name: byName });
    const s = this.#sessions.get(sessionId); if (s && s.status === "waiting_input") s.status = "running";
  }
  cancelSession(sessionId: string): void {
    const s = this.#sessions.get(sessionId); if (!s) return;
    s.status = "cancelled";
    this.#appendEvent(sessionId, "session_cancelled", null, "user", { by_name: "tester" });
  }
  /** 模拟 runner 心跳超时被 reaper 回收：session 回退 created、保留 assigned_runner。 */
  reapStaleRunner(runnerId: string): void {
    for (const s of this.#sessions.values()) {
      if (s.assigned_runner === runnerId && !TERMINAL.has(s.status) && s.status !== "created") s.status = "created";
    }
  }
  injectGitToken(token: string): void { this.#gitToken = token; }
  sessionStatus(id: string): SessionState | undefined { return this.#sessions.get(id); }
  events(id: string): EventRow[] { return this.#events.get(id) ?? []; }

  // ── 内部 ──
  #appendEvent(sid: string, event_type: string, stage: string | null, actor: string | null, payload: Record<string, unknown>): EventRow {
    const seq = (this.#seq.get(sid) ?? 0) + 1; this.#seq.set(sid, seq);
    const p = { ...payload };
    if (event_type === "gate_opened") {
      const gateId = randomUUID();
      this.#gates.set(gateId, { sessionId: sid, stage: stage ?? "", status: "pending" });
      p.gate_id = gateId;
      const s = this.#sessions.get(sid); if (s) s.status = "waiting_gate";
    }
    if (event_type === "clarification_requested") { const s = this.#sessions.get(sid); if (s) s.status = "waiting_input"; }
    if (event_type === "stage_artifact" && payload.kind === "spec") { const s = this.#sessions.get(sid); if (s) s.spec_md = String(payload.content ?? ""); }
    if (event_type === "pr_created") { const s = this.#sessions.get(sid); if (s) { s.pr_url = String(payload.pr_url ?? ""); s.current_stage = "done"; s.status = "completed"; } }
    const row: EventRow = { seq, event_type, stage, actor, payload: p };
    this.#events.get(sid)!.push(row);
    return row;
  }
  #bearer(req: Request): string | null {
    const h = req.headers.get("authorization"); return h?.startsWith("Bearer ") ? h.slice(7) : null;
  }
  #runnerBySecret(secret: string | null): string | null {
    if (!secret) return null;
    for (const [id, r] of this.#runners) if (r.secret === secret && !r.revoked) return id;
    return null;
  }
  async #handle(req: Request): Promise<Response> {
    const u = new URL(req.url);
    const json = (data: unknown, status = 200) => new Response(JSON.stringify({ success: status < 400, data }), { status, headers: { "content-type": "application/json" } });

    // 注册
    if (req.method === "POST" && u.pathname === "/api/runners/register") {
      const b = (await req.json()) as { token: string; name: string };
      if (!this.#regTokens.has(b.token) || this.#regTokens.get(b.token) === true) return json({ error: "token 无效或已消费" }, 401);
      this.#regTokens.set(b.token, true);
      const runnerId = randomUUID(); const secret = randomUUID();
      this.#runners.set(runnerId, { secret, name: b.name, lastHeartbeat: Date.now(), revoked: false });
      return json({ runner_id: runnerId, secret });
    }
    // runner 心跳
    const hbMatch = u.pathname.match(/^\/api\/runners\/([^/]+)\/heartbeat$/);
    if (req.method === "POST" && hbMatch) {
      const rid = this.#runnerBySecret(this.#bearer(req)); if (!rid) return json({ error: "unauthorized" }, 401);
      this.#runners.get(rid)!.lastHeartbeat = Date.now(); return json({});
    }
    // 长轮询领待派 + 原子 claim
    const pendMatch = u.pathname.match(/^\/api\/runners\/([^/]+)\/sessions\/pending$/);
    if (req.method === "GET" && pendMatch) {
      const rid = this.#runnerBySecret(this.#bearer(req)); if (!rid) return json({ error: "unauthorized" }, 401);
      const claimable = [...this.#sessions.values()].find((s) => s.assigned_runner === rid && s.status === "created");
      if (!claimable) return new Response(null, { status: 204 });
      claimable.status = "queued"; // 原子 claim（内存单线程，天然原子）
      return json({ session_id: claimable.id, status: claimable.status, current_stage: claimable.current_stage, repos: claimable.repos });
    }
    // session 内部 API（worker secret 鉴权，与真后端一致）
    const evPost = u.pathname.match(/^\/api\/internal\/dev-sessions\/([^/]+)\/events$/);
    if (evPost && req.method === "POST") {
      if (this.#bearer(req) !== this.#workerSecret) return json({ error: "unauthorized" }, 401);
      const sid = evPost[1]!; const s = this.#sessions.get(sid); if (!s) return json({ error: "not found" }, 404);
      if (TERMINAL.has(s.status)) return json({ error: "终态会话拒绝事件" }, 409);
      const b = (await req.json()) as { event_type: string; stage?: string; actor?: string; payload?: Record<string, unknown> };
      if (s.status === "queued") s.status = "running";
      const row = this.#appendEvent(sid, b.event_type, b.stage ?? null, b.actor ?? "agent", b.payload ?? {});
      return json(row);
    }
    if (evPost && req.method === "GET") {
      if (this.#bearer(req) !== this.#workerSecret) return json({ error: "unauthorized" }, 401);
      const sid = evPost[1]!; const after = Number(u.searchParams.get("after_seq") ?? 0);
      return json((this.#events.get(sid) ?? []).filter((e) => e.seq > after));
    }
    const sGet = u.pathname.match(/^\/api\/internal\/dev-sessions\/([^/]+)$/);
    if (sGet && req.method === "GET") {
      if (this.#bearer(req) !== this.#workerSecret) return json({ error: "unauthorized" }, 401);
      const s = this.#sessions.get(sGet[1]!); if (!s) return json({ error: "not found" }, 404);
      return json({ id: s.id, status: s.status, current_stage: s.current_stage, spec_md: s.spec_md, pr_url: s.pr_url });
    }
    const sHb = u.pathname.match(/^\/api\/internal\/dev-sessions\/([^/]+)\/heartbeat$/);
    if (sHb && req.method === "POST") {
      if (this.#bearer(req) !== this.#workerSecret) return json({ error: "unauthorized" }, 401);
      const s = this.#sessions.get(sHb[1]!); if (!s) return json({ error: "not found" }, 404);
      if (TERMINAL.has(s.status)) return json({ error: "终态" }, 409);
      return json({});
    }
    const gitTok = u.pathname.match(/^\/api\/internal\/dev-sessions\/([^/]+)\/git-token$/);
    if (gitTok && req.method === "GET") {
      if (this.#bearer(req) !== this.#workerSecret) return json({ error: "unauthorized" }, 401);
      if (this.#gitToken == null) return json({ error: "无 git 凭据" }, 400);
      return json({ token: this.#gitToken, expires_at: new Date(Date.now() + 3600_000).toISOString() });
    }
    return json({ error: `未实现：${req.method} ${u.pathname}` }, 404);
  }
}

// 直接运行：起一个 control-plane 供手动联调（端口固定 3099）
if (import.meta.main) {
  const cp = new MockControlPlane();
  await cp.start(3099);
  console.log(`mock control-plane 起在 ${cp.url}（Ctrl-C 退出）`);
}
```

- [ ] **Step 4：运行确认通过**

Run: `bun test tests/runner-mock-control-plane.test.ts` → PASS（4 用例全绿）
Run: `bun run typecheck` → 无错

- [ ] **Step 5：提交**

```bash
git add scripts/runner/mock-control-plane.ts tests/runner-mock-control-plane.test.ts
git commit -m "test(runner): 内存版 reqgenie control-plane（协议子集：注册/原子claim/事件后端定seq+注入gate_id）"
```

---

## Task 3：session-loop 契约一致性测试（防移植漂移）

spec §6.1/§11 要求 autopilot 的 `session-loop.ts`（A2 从 `agent-worker/sessionLoop.mjs` 移植）**与参考实现行为对齐**，PR 带「对齐证明」。本任务把参考实现的 8 个事件剧本同时喂两边，断言一致。

**Files:**
- Create: `tests/runner-session-loop-conformance.test.ts`

- [ ] **Step 1：核对 A2 session-loop 的导出签名**

Run（确认 A2 已落地且导出与参考一致）：
```bash
cd /c/Users/larry/Desktop/workspace/autopilot && grep -nE 'export (async )?function runSessionLoop|export class SignalQueue|reason|rounds' src/daemon/runner/session-loop.ts | head
```
Expected: 出现 `export ... runSessionLoop` + `export class SignalQueue`，返回 `{reason, rounds}`。**若签名与参考 `sessionLoop.mjs` 不一致**（如改名/改返回形状），按真实签名调整下方测试的 import 与断言字段，并在 PR 记录差异——这是 C 暴露 A2 偏离 spec 的设计点。

- [ ] **Step 2：写测试（直接复用参考实现的 fakeBackend + 8 剧本，断言 autopilot 移植版输出一致）**

```ts
// tests/runner-session-loop-conformance.test.ts
// 对齐证明：autopilot src/daemon/runner/session-loop.ts 必须与参考 agent-worker/sessionLoop.mjs 行为逐字一致。
// 同一组事件剧本喂两边，断言 reason/rounds/accumulated 完全相同。剧本 = 参考实现测试的 8 个用例。
import { test, expect } from "bun:test";
import { runSessionLoop, SignalQueue } from "../src/daemon/runner/session-loop";

// 与 agent-worker/test/sessionLoop.test.mjs 完全相同的假后端（seq 分配 / gate_id 注入 / 状态）
function fakeBackend() {
  const events: Array<{ seq: number; event_type: string; payload: Record<string, unknown> }> = [];
  let seq = 0, gateN = 0;
  const state: { status: string; current_stage?: string; spec_md?: string } = { status: "running" };
  return {
    events, state,
    emit(event_type: string, payload: Record<string, unknown> = {}) { events.push({ seq: ++seq, event_type, payload }); },
    async postEvent(ev: { event_type: string; payload?: Record<string, unknown> }) {
      const stored = { ...ev, seq: ++seq, payload: { ...(ev.payload ?? {}) } } as { seq: number; event_type: string; payload: Record<string, unknown> };
      if (ev.event_type === "gate_opened") stored.payload.gate_id = `gate-${++gateN}`;
      events.push(stored); return stored;
    },
    async fetchEvents(afterSeq: number) { return events.filter((e) => e.seq > afterSeq); },
    async fetchSession() { return { status: state.status, current_stage: state.current_stage, spec_md: state.spec_md }; },
  };
}
const clarifyRound = () => [
  { event_type: "assistant_message", payload: { message: "v1" } },
  { event_type: "clarification_requested", payload: { question: "默认值?" } },
];
const gateRound = (v: string) => [
  { event_type: "stage_artifact", payload: { kind: "spec", content: v } },
  { event_type: "gate_opened", payload: { stage: "spec" } },
];

test("对齐①：澄清→拉到回答→重跑→gate approve 结束（reason=approved, rounds=2, 第2回合含答案）", async () => {
  const b = fakeBackend(); const q = new SignalQueue(); const contexts: string[] = [];
  const outputs = [clarifyRound(), gateRound("v2")];
  const loop = runSessionLoop({ backend: b, queue: q, ctx: { roundFn: async (ctx: { accumulated: string }) => { contexts.push(ctx.accumulated); return outputs.shift()!; }, requirement: "x", pollMs: 5 } });
  setTimeout(() => { b.emit("user_message", { message: "默认 medium", by_name: "甲" }); q.push({ type: "wake" }); }, 10);
  setTimeout(() => { b.emit("gate_decided", { gate_id: "gate-1", decision: "approved" }); q.push({ type: "wake" }); }, 30);
  const r = await loop;
  expect(r.reason).toBe("approved"); expect(r.rounds).toBe(2);
  expect(contexts[1]).toContain("默认 medium");
});

test("对齐②：丢信号轮询兜底推进（reason=approved）", async () => {
  const b = fakeBackend(); const q = new SignalQueue();
  const loop = runSessionLoop({ backend: b, queue: q, ctx: { roundFn: async () => gateRound("s"), requirement: "x", pollMs: 5 } });
  setTimeout(() => b.emit("gate_decided", { gate_id: "gate-1", decision: "approved" }), 20);
  expect((await loop).reason).toBe("approved");
});

test("对齐③：伪造/错配 gate_id 不生效（rounds=1, reason=approved）", async () => {
  const b = fakeBackend(); const q = new SignalQueue();
  const loop = runSessionLoop({ backend: b, queue: q, ctx: { roundFn: async () => gateRound("s"), requirement: "x", pollMs: 5 } });
  setTimeout(() => { b.emit("gate_decided", { gate_id: "gate-999", decision: "approved" }); q.push({ type: "wake" }); q.push({ type: "wake" }); }, 10);
  setTimeout(() => b.emit("gate_decided", { gate_id: "gate-1", decision: "approved" }), 40);
  const r = await loop; expect(r.reason).toBe("approved"); expect(r.rounds).toBe(1);
});

test("对齐④：驳回带评论重做再批准（rounds=2, 重做回合含评论）", async () => {
  const b = fakeBackend(); const q = new SignalQueue(); const contexts: string[] = [];
  const loop = runSessionLoop({ backend: b, queue: q, ctx: { roundFn: async (ctx: { accumulated: string }) => { contexts.push(ctx.accumulated); return gateRound("s"); }, requirement: "x", pollMs: 5 } });
  setTimeout(() => b.emit("gate_decided", { gate_id: "gate-1", decision: "rejected", comment: "漏了错误处理" }), 10);
  setTimeout(() => b.emit("gate_decided", { gate_id: "gate-2", decision: "approved" }), 40);
  const r = await loop; expect(r.reason).toBe("approved"); expect(r.rounds).toBe(2);
  expect(contexts[1]).toContain("漏了错误处理");
});

test("对齐⑤：session_cancelled → 等待点优雅退出（reason=terminal）", async () => {
  const b = fakeBackend(); const q = new SignalQueue();
  const loop = runSessionLoop({ backend: b, queue: q, ctx: { roundFn: async () => gateRound("s"), requirement: "x", pollMs: 5 } });
  setTimeout(() => { b.emit("session_cancelled", { by_name: "甲" }); b.state.status = "cancelled"; }, 15);
  expect((await loop).reason).toBe("terminal");
});

test("对齐⑥：maxRounds 兜底（reason=max_rounds, rounds=3）", async () => {
  const b = fakeBackend(); const q = new SignalQueue(); let n = 0;
  const loop = runSessionLoop({ backend: b, queue: q, ctx: { roundFn: async () => { setTimeout(() => b.emit("user_message", { message: `答${n++}` }), 5); return clarifyRound(); }, requirement: "x", maxRounds: 3, pollMs: 5 } });
  const r = await loop; expect(r.reason).toBe("max_rounds"); expect(r.rounds).toBe(3);
});

test("对齐⑦：多人插话按 seq 序并入（先<后）", async () => {
  const b = fakeBackend(); const q = new SignalQueue(); const contexts: string[] = [];
  const outputs = [clarifyRound(), gateRound("v")];
  const loop = runSessionLoop({ backend: b, queue: q, ctx: { roundFn: async (ctx: { accumulated: string }) => { contexts.push(ctx.accumulated); return outputs.shift()!; }, requirement: "x", pollMs: 5 } });
  setTimeout(() => { b.emit("user_message", { message: "先", by_name: "甲" }); b.emit("user_message", { message: "后", by_name: "乙" }); }, 10);
  setTimeout(() => b.emit("gate_decided", { gate_id: "gate-1", decision: "approved" }), 40);
  await loop; const c = contexts[1]!; expect(c.indexOf("先")).toBeLessThan(c.indexOf("后"));
});

test("对齐⑧：SignalQueue push/next 双向（push 先入队 / next 先挂起）", async () => {
  const q = new SignalQueue();
  q.push({ type: "wake" });
  expect((await q.next()).type).toBe("wake");
  const pending = q.next(); q.push({ type: "wake" });
  expect((await pending).type).toBe("wake");
});
```

- [ ] **Step 3：运行确认通过**

Run: `bun test tests/runner-session-loop-conformance.test.ts`
Expected: PASS（8 用例全绿，证明 autopilot 移植版与参考行为一致）。
Run（并行确认参考实现自身仍绿，作为「基线未变」证据）：
```bash
cd /c/Users/larry/Desktop/workspace/reqgenie && node --test agent-worker/test/sessionLoop.test.mjs
```
Expected: 参考 8 用例全绿。

- [ ] **Step 4：提交**

```bash
cd /c/Users/larry/Desktop/workspace/autopilot
git add tests/runner-session-loop-conformance.test.ts
git commit -m "test(runner): session-loop 移植与 agent-worker 参考行为逐字对齐（8 剧本对齐证明，防漂移）"
```

---

## Task 4：协议枚举对齐校验（双侧单一真理来源）

spec §11「契约一致性：seq/gate_id/stage 枚举对齐」。autopilot `rounds.ts` 产出的 event_type / stage 值必须落在 reqgenie 052 迁移定义的枚举集合内。从迁移文件解析枚举当 oracle，避免 autopilot 侧写死字符串与后端漂移。

**Files:**
- Create: `tests/runner-protocol-contract.test.ts`

- [ ] **Step 1：核对 reqgenie 迁移路径 + rounds.ts 产出枚举**

Run:
```bash
cd /c/Users/larry/Desktop/workspace/autopilot && grep -nE "event_type:|stage:|\"clarify\"|\"spec\"|\"dev\"|\"pr\"|assistant_message|gate_opened|stage_artifact|pr_created|clarification_requested" src/daemon/runner/rounds.ts | head -40
ls ../reqgenie/backend/migrations/052_dev_sessions.sql
```
Expected: 看到 rounds.ts 用的字面量集合 + 052 迁移存在。**若 rounds.ts 用常量枚举而非字面量**，下方测试改为 import 该枚举再校验。

- [ ] **Step 2：写测试**

```ts
// tests/runner-protocol-contract.test.ts
// 契约：autopilot runner 产出的 event_type / stage 必须 ⊆ reqgenie 052 迁移定义的枚举（单一真理来源）。
import { test, expect } from "bun:test";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const MIGRATION = join(import.meta.dir, "../../reqgenie/backend/migrations/052_dev_sessions.sql");

// autopilot runner 在 A 模式会回写的事件类型（spec §4.5 stage→产出事件）
const RUNNER_EMITTED_EVENTS = [
  "assistant_message", "clarification_requested", "stage_artifact",
  "gate_opened", "pr_created", "limit_hit",
] as const;
// autopilot runner 会处理 / 推进的 stage（spec §2 D5 + §4.5）
const RUNNER_STAGES = ["clarify", "spec", "eng_review", "ui_review", "dev", "pr"] as const;

function enumsFromMigration(): { events: Set<string>; stages: Set<string> } {
  if (!existsSync(MIGRATION)) throw new Error(`reqgenie 迁移不存在：${MIGRATION}（确认两仓同级 checkout）`);
  const sql = readFileSync(MIGRATION, "utf8");
  // event_type 枚举写在 052 注释里（052_dev_sessions.sql 的 event_type 列注释多行枚举）
  const events = new Set<string>();
  for (const m of sql.matchAll(/\b(assistant_message|reasoning|tool_call|tool_result|stage_change|gate_opened|gate_decided|clarification_requested|clarification_answered|user_message|limit_hit|error|token_usage|heartbeat|stage_artifact|pr_created|session_cancelled|dispatch_failed)\b/g)) {
    events.add(m[1]!);
  }
  const stages = new Set<string>();
  for (const m of sql.matchAll(/\b(clarify|spec|eng_review|ui_review|dev|pr|done)\b/g)) stages.add(m[1]!);
  return { events, stages };
}

test("autopilot 回写的 event_type 全部 ∈ reqgenie 052 枚举", () => {
  const { events } = enumsFromMigration();
  // pr_created / stage_artifact 是 B 在 052 基础上摄取的事件；若 052 未含，B 必须扩枚举——此断言会逼出该差异
  for (const e of RUNNER_EMITTED_EVENTS) {
    expect(events.has(e), `event_type "${e}" 未在 reqgenie 052 迁移枚举中（B 侧需补充摄取分支/枚举）`).toBe(true);
  }
});

test("autopilot 处理的 stage 全部 ∈ reqgenie 052 枚举", () => {
  const { stages } = enumsFromMigration();
  for (const s of RUNNER_STAGES) {
    expect(stages.has(s), `stage "${s}" 未在 reqgenie 052 枚举中`).toBe(true);
  }
});

test("runner 永不自定 seq：rounds 产出的事件对象不含 seq 字段（seq 后端定）", async () => {
  // 静态校验 rounds.ts 不构造 seq 字段（防开发者误自定 seq，spec §4.3 不变式）
  const src = readFileSync(join(import.meta.dir, "../src/daemon/runner/rounds.ts"), "utf8");
  expect(/\bseq\s*:/.test(src), "rounds.ts 不应自定 seq 字段（seq 由后端 advisory 锁分配）").toBe(false);
});

test("runner 永不自定 gate_id：rounds.ts 不构造 gate_id（后端注入）", () => {
  const src = readFileSync(join(import.meta.dir, "../src/daemon/runner/rounds.ts"), "utf8");
  expect(/gate_id\s*:/.test(src), "rounds.ts 不应自定 gate_id（gate_opened 的 gate_id 由后端注入）").toBe(false);
});
```

> 注：`pr_created` 是 B 新增的摄取分支（spec §5.2「`ingest_worker_event` 现状无此分支，新增」）。052 迁移注释里若尚未列 `pr_created`，第 1 个断言会失败——这正是契约测试的价值：逼 B 在迁移/枚举里登记 `pr_created`，或在 061/062 扩 event_type 注释。执行 C 时若该断言红，应回到 B 计划补登记，而非在此放宽断言。

- [ ] **Step 3：运行确认通过**

Run: `bun test tests/runner-protocol-contract.test.ts`
Expected: PASS（前提：B 已登记 `pr_created`；若红 → B 侧补枚举后再跑）。

- [ ] **Step 4：提交**

```bash
git add tests/runner-protocol-contract.test.ts
git commit -m "test(runner): 协议枚举契约（event_type/stage ⊆ reqgenie 052；runner 不自定 seq/gate_id）"
```

---

## Task 5：reqgenie 侧 B 真库集成测试 `runner_e2e.rs`

spec §11 reqgenie 测试要点。复用 `dev_session_http.rs` 的 env 驱动 setup_db/build_state 模式，专测 B 新增面：注册一次性+并发重放、revoke 401、dispatch 按 backend 选择、`/sessions/pending` 原子 claim 并发只一赢 + last-chance、拉模型回收、max_stage=pr、`pr_created` 写 pr_url、单需求单活跃 session 409。

**Files:**
- Create: `C:\Users\larry\Desktop\workspace\reqgenie\backend\tests\runner_e2e.rs`

- [ ] **Step 1：核对 B 已落地的端点/服务签名**

Run:
```bash
cd /c/Users/larry/Desktop/workspace/reqgenie && grep -rnE 'runners/register|runners/.*pending|runners/.*heartbeat|RunnerDispatcher|assign_runner|pr_created|fn registration_token|registration_tokens' backend/src/routes backend/src/services | head -40
ls backend/migrations/060* backend/migrations/061* backend/migrations/062*
```
Expected: 出现 B 的路由注册 + RunnerDispatcher + 060/061/062 迁移。**按真实路由路径 / handler 名 / service 方法名调整下方测试的 URL 与断言**（B 计划落地后这些才确定；下方用 spec §4.2 钉死的路径，路径与 spec 不符时以代码为准并在 PR 记差异）。

- [ ] **Step 2：写测试（仿 `dev_session_http.rs` 自包含 env 驱动）**

```rust
//! Runner（A 模式）后端 e2e：注册 / 拉式领活 / 原子 claim / 拉模型回收 / pr_created / max_stage=pr /
//! 单需求单活跃 session。真实全 schema + Redis + JWT + worker secret。
//!
//! 运行：
//!   ORCH_PG=postgresql://reqgenie:reqgenie@127.0.0.1:5433 \
//!   ORCH_REDIS=redis://127.0.0.1:6379 \
//!   cargo test --test runner_e2e -- --ignored --nocapture

use std::sync::Arc;
use std::{fs, path::PathBuf};

use axum::http::StatusCode;
use axum_test::TestServer;
use reqgenie_backend::AppState;
use reqgenie_backend::config::*;
use reqgenie_backend::middleware::auth::generate_token;
use reqgenie_backend::models::developer::UserRole;
use reqgenie_backend::routes;
use reqgenie_backend::routes::ws::{DevSessionBroadcaster, WsBroadcaster};
use reqgenie_backend::services::cache_service::QueryCache;
use reqgenie_backend::services::conversation_context_service::ConversationContextService;
use reqgenie_backend::services::feishu_service::FeishuService;
use reqgenie_backend::services::group_service::GroupService;
use reqgenie_backend::services::notification_service::NotificationService;
use reqgenie_backend::services::permission_service::PermissionService;
use serde_json::{Value, json};
use sqlx::PgPool;
use sqlx::postgres::PgPoolOptions;
use uuid::Uuid;

const E2E_DB: &str = "reqgenie_e2e_runner";
const JWT_SECRET: &str = "integration-test-secret-key-2024";

async fn setup_db(base: &str) -> PgPool {
    let admin = PgPool::connect(&format!("{base}/postgres")).await.unwrap();
    sqlx::raw_sql(&format!("DROP DATABASE IF EXISTS {E2E_DB} WITH (FORCE)")).execute(&admin).await.unwrap();
    sqlx::raw_sql(&format!("CREATE DATABASE {E2E_DB}")).execute(&admin).await.unwrap();
    admin.close().await;
    let pool = PgPoolOptions::new().max_connections(10).connect(&format!("{base}/{E2E_DB}")).await.unwrap();
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("migrations");
    let mut files: Vec<PathBuf> = fs::read_dir(&dir).unwrap()
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().map(|x| x == "sql").unwrap_or(false)).collect();
    files.sort();
    for f in files { let sql = fs::read_to_string(&f).unwrap(); let _ = sqlx::raw_sql(&sql).execute(&pool).await; }
    pool
}

async fn build_state(pool: PgPool, redis_url: &str) -> AppState {
    let client = redis::Client::open(redis_url).unwrap();
    let redis_conn = redis::aio::ConnectionManager::new(client).await.unwrap();
    let query_cache = QueryCache::new(redis_conn.clone());
    let conversation_ctx = Arc::new(ConversationContextService::new(redis_conn.clone()));
    let permission_service = Arc::new(PermissionService::new(pool.clone(), redis_conn.clone()));
    let server_config = ServerConfig { host: "127.0.0.1".into(), port: 3001, public_url: "http://localhost:3000".into(), oauth_redirect_base: None };
    let feishu_service = Arc::new(FeishuService::new(FeishuConfig {
        app_id: "".into(), app_secret: "".into(), verification_token: "".into(), encrypt_key: "".into(),
        daily_report_webhook_url: None, workhour_reminders_enabled: false, user_sync_enabled: false,
    }));
    let notification_service = Arc::new(NotificationService::new(pool.clone(), feishu_service.clone(), server_config.clone(), redis_conn.clone()));
    let group_service = Arc::new(GroupService::new(pool.clone(), feishu_service.clone(), query_cache.clone()));
    AppState {
        db: pool, server_config,
        ai_config: AiConfig { api_key: "test".into(), api_base_url: "http://localhost:9999".into(), model: "test".into() },
        jwt_config: JwtConfig { secret: JWT_SECRET.into(), expiration_hours: 24 },
        dev_auth_config: DevAuthConfig {
            enabled: false, user_id: "00000000-0000-0000-0000-000000000001".into(), name: "e2e".into(),
            email: "e2e@test.dev".into(), feishu_user_id: "e2e".into(), feishu_open_id: "e2e".into(),
            department: "test".into(), role: "admin".into(),
        },
        ws_broadcaster: Arc::new(WsBroadcaster::new()),
        dev_session_broadcaster: Arc::new(DevSessionBroadcaster::new()),
        feishu_service, conversation_ctx, permission_service, notification_service, group_service, query_cache,
    }
}

fn admin_token() -> String {
    let cfg = JwtConfig { secret: JWT_SECRET.into(), expiration_hours: 24 };
    generate_token(&cfg, Uuid::new_v4(), "e2e_admin", "e2e管理员", &UserRole::Admin).unwrap()
}
fn dev_token() -> String {
    let cfg = JwtConfig { secret: JWT_SECRET.into(), expiration_hours: 24 };
    generate_token(&cfg, Uuid::new_v4(), "e2e_dev", "e2e开发", &UserRole::Developer).unwrap()
}

/// 注册一个 runner，返回 (runner_id, secret)。
async fn register_runner(server: &TestServer, admin: &str, name: &str) -> (String, String) {
    let tok: Value = server.post("/api/admin/runners/registration-token")
        .authorization_bearer(admin).json(&json!({})).await.json();
    let reg_token = tok["data"]["token"].as_str().expect("注册 token").to_string();
    let reg: Value = server.post("/api/runners/register")
        .json(&json!({ "token": reg_token, "name": name })).await.json();
    (reg["data"]["runner_id"].as_str().unwrap().to_string(), reg["data"]["secret"].as_str().unwrap().to_string())
}

#[tokio::test]
#[ignore = "需要 ORCH_PG + ORCH_REDIS 真实服务"]
async fn runner_e2e() {
    let base = std::env::var("ORCH_PG").expect("需要 ORCH_PG");
    let redis_url = std::env::var("ORCH_REDIS").expect("需要 ORCH_REDIS");
    unsafe { std::env::set_var("DEV_SESSION_WORKER_SECRET", "dev-worker-secret") };

    let pool = setup_db(&base).await;
    let req_id: Uuid = sqlx::query_scalar("INSERT INTO requirements (title) VALUES ('runner e2e 需求') RETURNING id")
        .fetch_one(&pool).await.unwrap();
    let state = build_state(pool.clone(), &redis_url).await;
    let server = TestServer::new(axum::Router::new().nest("/api", routes::api_routes(state)));
    let admin = admin_token();
    let dev = dev_token();

    // ── 1. 注册 token 一次性 + 并发重放拒绝 ──
    let tok: Value = server.post("/api/admin/runners/registration-token")
        .authorization_bearer(&admin).json(&json!({})).await.json();
    let reg_token = tok["data"]["token"].as_str().unwrap().to_string();
    let first: Value = server.post("/api/runners/register")
        .json(&json!({ "token": reg_token, "name": "r1" })).await.json();
    assert!(first["success"].as_bool().unwrap(), "首次注册应成功: {first}");
    let runner_id = first["data"]["runner_id"].as_str().unwrap().to_string();
    let secret = first["data"]["secret"].as_str().unwrap().to_string();
    // 同 token 再注册 → 401（一次性，consumed_at）
    server.post("/api/runners/register").json(&json!({ "token": reg_token, "name": "r2" }))
        .await.assert_status_unauthorized();
    println!("✓ 注册 token 一次性：重放 → 401");

    // ── 2. runner 凭证鉴权 + revoke 后 401 ──
    server.post(&format!("/api/runners/{runner_id}/heartbeat")).authorization_bearer(&secret)
        .json(&json!({})).await.assert_status_ok();
    server.post(&format!("/api/runners/{runner_id}/heartbeat")).authorization_bearer("wrong-secret")
        .json(&json!({})).await.assert_status_unauthorized();
    server.delete(&format!("/api/runners/{runner_id}")).authorization_bearer(&admin).await.assert_status_ok();
    server.post(&format!("/api/runners/{runner_id}/heartbeat")).authorization_bearer(&secret)
        .json(&json!({})).await.assert_status_unauthorized();
    println!("✓ 凭证鉴权 + revoke 后 401");

    // 重新注册一个干净 runner 供后续用
    let (runner_id, secret) = register_runner(&server, &admin, "r-main").await;

    // ── 3. dispatch 按 backend 选择：autopilot_selfhosted 只 assign_runner、不 POST，留 created 等领 ──
    let s: Value = server.post(&format!("/api/requirements/{req_id}/dev-sessions"))
        .authorization_bearer(&dev)
        .json(&json!({ "agent_backend": "autopilot_selfhosted", "assigned_runner": runner_id, "repo_ids": [] }))
        .await.json();
    assert!(s["success"].as_bool().unwrap(), "创建失败: {s}");
    let sid = s["data"]["id"].as_str().unwrap().to_string();
    assert_eq!(s["data"]["status"], "created", "selfhosted 不 push，应留 created 等 runner 领");
    assert_eq!(s["data"]["agent_backend"], "autopilot_selfhosted");
    // max_stage 放开到 pr（按 backend）
    let (max_stage,): (String,) = sqlx::query_as("SELECT max_stage FROM dev_sessions WHERE id = $1")
        .bind(Uuid::parse_str(&sid).unwrap()).fetch_one(&pool).await.unwrap();
    assert_eq!(max_stage, "pr", "autopilot_selfhosted 的 max_stage 应放开到 pr");
    println!("✓ dispatch 多态：selfhosted 留 created + max_stage=pr");

    // ── 4. 单需求单活跃 session：同需求第二个 → 409 ──
    server.post(&format!("/api/requirements/{req_id}/dev-sessions"))
        .authorization_bearer(&dev)
        .json(&json!({ "agent_backend": "autopilot_selfhosted", "assigned_runner": runner_id, "repo_ids": [] }))
        .await.assert_status(StatusCode::CONFLICT);
    println!("✓ 单需求单活跃 session → 409");

    // ── 5. /sessions/pending 原子 claim：并发两请求只一赢，另一 204 ──
    let h = secret.clone();
    let f1 = server.get(&format!("/api/runners/{runner_id}/sessions/pending?wait=0")).authorization_bearer(&h);
    let f2 = server.get(&format!("/api/runners/{runner_id}/sessions/pending?wait=0")).authorization_bearer(&h);
    let (r1, r2) = tokio::join!(f1, f2);
    let codes = [r1.status_code(), r2.status_code()];
    let won = codes.iter().filter(|c| **c == StatusCode::OK).count();
    let empty = codes.iter().filter(|c| **c == StatusCode::NO_CONTENT).count();
    assert_eq!(won, 1, "并发 claim 只能一个 200，得到 codes={codes:?}");
    assert_eq!(empty, 1, "另一个应 204（last-chance 重查后无待派）");
    // claim 后 session 翻 queued
    let after: Value = server.get(&format!("/api/dev-sessions/{sid}")).authorization_bearer(&dev).await.json();
    assert_eq!(after["data"]["status"], "queued");
    println!("✓ /sessions/pending 原子 claim：并发只一赢 + last-chance 另一 204");

    // ── 6. 拉模型回收：runner 心跳静默 → reaper 把该 runner 非终态 session 回退 created（保留 assigned_runner）──
    // 把心跳超时压到 0 秒 + runner 心跳时刻调老，跑一次 reaper tick
    unsafe { std::env::set_var("DEV_SESSION_HEARTBEAT_TIMEOUT_S", "0") };
    sqlx::query("UPDATE runners SET last_heartbeat_at = NOW() - INTERVAL '120 seconds' WHERE id = $1")
        .bind(Uuid::parse_str(&runner_id).unwrap()).execute(&pool).await.unwrap();
    reqgenie_backend::services::dev_session_reaper::DevSessionReaper::tick(&pool).await.unwrap();
    let recovered: Value = server.get(&format!("/api/dev-sessions/{sid}")).authorization_bearer(&dev).await.json();
    assert_eq!(recovered["data"]["status"], "created", "runner 心跳超时 → session 回退 created 等重领");
    let (assigned,): (Option<Uuid>,) = sqlx::query_as("SELECT assigned_runner FROM dev_sessions WHERE id = $1")
        .bind(Uuid::parse_str(&sid).unwrap()).fetch_one(&pool).await.unwrap();
    assert_eq!(assigned, Some(Uuid::parse_str(&runner_id).unwrap()), "回退后须保留 assigned_runner（只回原 runner 续作）");
    // 重新可 claim
    sqlx::query("UPDATE runners SET last_heartbeat_at = NOW() WHERE id = $1")
        .bind(Uuid::parse_str(&runner_id).unwrap()).execute(&pool).await.unwrap();
    let reclaim = server.get(&format!("/api/runners/{runner_id}/sessions/pending?wait=0")).authorization_bearer(&secret).await;
    assert_eq!(reclaim.status_code(), StatusCode::OK, "回退后应能重新 claim 续作");
    println!("✓ 拉模型回收：runner 静默 → 回退 created（留 assigned_runner）→ 重新可 claim");

    // ── 7. pr_created 摄取 → 写 dev_sessions.pr_url ──
    let pr_url = "https://github.com/acme/repo/pull/42";
    server.post(&format!("/api/internal/dev-sessions/{sid}/events"))
        .authorization_bearer("dev-worker-secret")
        .json(&json!({ "event_type": "pr_created", "stage": "pr", "actor": "agent",
                       "payload": { "branch_name": "reqgenie/abc", "pr_url": pr_url, "repo": "acme/repo" } }))
        .await.assert_status_ok();
    let (pr,): (Option<String>,) = sqlx::query_as("SELECT pr_url FROM dev_sessions WHERE id = $1")
        .bind(Uuid::parse_str(&sid).unwrap()).fetch_one(&pool).await.unwrap();
    assert_eq!(pr.as_deref(), Some(pr_url), "pr_created 应写 dev_sessions.pr_url");
    println!("✓ pr_created 摄取 → pr_url 落库");

    pool.close().await;
    println!("\nrunner_e2e 全部通过 ✅");
}
```

- [ ] **Step 3：跑测试（需 PG+Redis；先起 docker-compose.dev.yml）**

Run:
```bash
cd /c/Users/larry/Desktop/workspace/reqgenie
docker compose -f docker-compose.dev.yml up -d
ORCH_PG=postgresql://reqgenie:reqgenie@127.0.0.1:5433 ORCH_REDIS=redis://127.0.0.1:6379 \
  cargo test --test runner_e2e -- --ignored --nocapture
```
Expected: 7 个 `✓` 全打印 + `runner_e2e 全部通过 ✅`。
**前置**：B 已落地（060/061/062 + 路由 + RunnerDispatcher + 回收 reaper）。若某断言红，定位是 B 实现缺口（按 §4.2 spec 修 B），不是放宽断言。

- [ ] **Step 4：编译检查（不跑真库也要保证编译过，CI 用）**

Run:
```bash
cd /c/Users/larry/Desktop/workspace/reqgenie/backend && cargo test --test runner_e2e --no-run
```
Expected: 编译通过（`--ignored` 测试默认不跑，但必须能编译；这一步在无 PG 环境也能做）。

- [ ] **Step 5：提交（reqgenie 仓）**

```bash
cd /c/Users/larry/Desktop/workspace/reqgenie
cargo +nightly fmt
cargo clippy --test runner_e2e -- -D warnings
git add backend/tests/runner_e2e.rs
git commit -m "test(runner): B 侧真库 e2e（注册一次性/原子claim并发/拉模型回收/pr_created/max_stage=pr/单活跃session）"
```

---

## Task 6：离线契约冒烟 `runner-smoke.ts`（autopilot 端到端，CI 可跑）

把 mock-control-plane（Task 2）+ runner CLI（A2）+ executor（A1）接起来，跑 clarify→spec→dev→pr 全链路，**无 reqgenie/无 GitHub**：dev/pr 的远程用本地 bare 仓当 GitHub 替身，gh PR 步骤通过 `submitPrPure` 的 `openPr` 注入桩。这是 CI 能跑的最高保真 e2e。

**Files:**
- Create: `scripts/runner/runner-smoke.ts`
- Modify: `package.json`（加 `runner-smoke` script）

- [ ] **Step 1：核对 runner CLI 注册命令与凭证落盘路径（A2）**

Run:
```bash
cd /c/Users/larry/Desktop/workspace/autopilot && grep -rnE 'runner.*register|credentials\.json|control_plane_url|runner\.lock|mode.*runner' src/cli/index.ts src/daemon/runner/registration.ts src/core/config.ts | head -30
```
Expected: 看到 `autopilot runner register`、`AUTOPILOT_HOME/runner/credentials.json`、`mode: runner`。**按真实 CLI 形态调整下方脚本的命令参数 / 凭证读取路径**（A2 落地后才确定）。下方按 spec §6.4 钉死的命令写。

- [ ] **Step 2：写脚本**

```ts
#!/usr/bin/env bun
// Runner 离线契约冒烟：mock-control-plane + autopilot runner（mode:runner）+ executor 全链路，
// 无 reqgenie/无 GitHub。dev/pr 远程用本地 bare 仓替身。跑通 clarify→spec→dev→pr 出 pr_created。
//   bun run runner-smoke
import { mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { MockControlPlane } from "./mock-control-plane";

const REPO = process.cwd();
const home = mkdtempSync(join(tmpdir(), `runner-smoke-${Date.now()}-`));
let cp: MockControlPlane | null = null;
let daemon: ReturnType<typeof Bun.spawn> | null = null;

function fail(msg: string, extra?: string): never {
  console.error(`  ✗ ${msg}`); if (extra) console.error(`    ${extra.slice(0, 500)}`);
  cleanup(); process.exit(1);
}
function ok(msg: string): void { console.log(`  ✓ ${msg}`); }
function cleanup(): void {
  try { daemon?.kill(); } catch { /* */ }
  void cp?.stop();
  try { if (existsSync(home)) rmSync(home, { recursive: true, force: true }); } catch { /* */ }
}
function cli(args: string[], stdin?: string): { stdout: string; stderr: string; code: number } {
  const r = Bun.spawnSync({
    cmd: ["bun", "run", join(REPO, "bin/autopilot.ts"), ...args],
    env: { ...process.env, AUTOPILOT_HOME: home },
    stdin: stdin ? new TextEncoder().encode(stdin) : undefined,
    stdout: "pipe", stderr: "pipe",
  });
  return { stdout: r.stdout.toString(), stderr: r.stderr.toString(), code: r.exitCode ?? -1 };
}
async function waitFor(pred: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) { if (pred()) return; await Bun.sleep(200); }
  fail(`等待超时：${label}`);
}

async function main(): Promise<void> {
  console.log(`runner-smoke 开始，HOME=${home}`);
  mkdirSync(join(home, "runtime"), { recursive: true });

  // 1. init
  const init = cli(["init"]);
  if (init.code !== 0) fail("autopilot init 失败", init.stderr);
  ok("init 完成");

  // 2. 起 mock control-plane
  cp = new MockControlPlane();
  await cp.start();
  cp.injectGitToken("ghs_faketoken"); // dev/pr 用 file:// 远程，token 走 noop 但链路要能取到
  ok(`mock control-plane 起在 ${cp.url}`);

  // 3. 写 runner config（mode:runner + control_plane_url）
  writeFileSync(join(home, "config.yaml"),
    `mode: runner\nrunner:\n  control_plane_url: ${cp.url}\n  name: smoke-runner\n  poll_wait: 1\n`, "utf-8");

  // 4. 注册（token 走 stdin）
  const regToken = cp.issueRegistrationToken();
  const reg = cli(["runner", "register", "--url", cp.url], regToken);
  if (reg.code !== 0) fail("runner register 失败", reg.stderr || reg.stdout);
  if (!existsSync(join(home, "runner", "credentials.json"))) fail("注册后未落 credentials.json");
  ok("runner register（凭证落盘）");

  // 5. 准备 dev/pr 用的 bare 远程（GitHub 替身）
  const repoBase = mkdtempSync(join(tmpdir(), "runner-smoke-repo-"));
  const bare = join(repoBase, "bare.git");
  const seed = join(repoBase, "seed");
  const git = (args: string[], cwd: string) => Bun.spawnSync(["git", ...args], { cwd });
  git(["init", "--bare", "-b", "main", bare], repoBase);
  git(["clone", bare, seed], repoBase);
  git(["config", "user.email", "t@t"], seed); git(["config", "user.name", "t"], seed);
  writeFileSync(join(seed, "README.md"), "# seed\n");
  git(["add", "-A"], seed); git(["commit", "-m", "seed"], seed); git(["push", "-u", "origin", "main"], seed);

  // 6. 起 mode:runner daemon（后台子进程）
  daemon = Bun.spawn(["bun", "run", join(REPO, "src/daemon/index.ts")], {
    cwd: REPO, env: { ...process.env, AUTOPILOT_HOME: home }, stdout: "ignore", stderr: "ignore",
  });

  // 7. 等 runner 上线（runner 心跳到 mock-cp）—— 简化为等 poller 起来：直接派 session 后看是否被 claim
  const sid = cp.dispatchSession({
    assignedRunner: "smoke-runner-id-placeholder", // 注：真实 runner_id 由注册返回；mock 下用 assign='any' 派给任意在线 runner
    repos: [{ id: "repo-1", owner: "acme", repo_name: "repo", repo_url: `file://${bare}`, default_branch: "main" }],
    stage: "clarify",
  });
  // mock-control-plane 的 dispatchSession 若按 assigned_runner 精确匹配，需用注册时返回的 id；
  // 为离线冒烟稳健，mock 下 pending 端点对 "any"/已注册 runner 一律可领（见 Step 注）。

  // 8. 驱动链路：clarify（runner 提问或推进）→ 我们答澄清 → spec gate → dev gate → pr
  //    runner 每 stage 回写事件并在 gate/clarify 处等待；这里按事件流出现的 gate_opened 自动批准。
  let lastSeq = 0;
  const drive = async () => {
    const evs = cp!.events(sid).filter((e) => e.seq > lastSeq);
    for (const e of evs) {
      lastSeq = Math.max(lastSeq, e.seq);
      if (e.event_type === "clarification_requested") cp!.injectUserMessage(sid, "按默认实现即可");
      if (e.event_type === "gate_opened") cp!.decideGate(sid, String(e.payload.gate_id), "approved");
    }
  };
  const start = Date.now();
  while (Date.now() - start < 120_000) {
    await drive();
    const s = cp.sessionStatus(sid);
    if (s && (s.status === "completed" || s.status === "failed")) break;
    await Bun.sleep(500);
  }

  // 9. 断言：链路出现 pr_created + session done
  const all = cp.events(sid);
  if (!all.some((e) => e.event_type === "stage_artifact" && e.payload.kind === "spec"))
    fail("缺 spec stage_artifact 事件", JSON.stringify(all.map((e) => e.event_type)));
  ok("spec 阶段产 stage_artifact");
  if (!all.some((e) => e.event_type === "pr_created"))
    fail("缺 pr_created 事件（pr 阶段未出 PR）", JSON.stringify(all.map((e) => e.event_type)));
  ok("pr 阶段产 pr_created");
  const final = cp.sessionStatus(sid);
  if (final?.status !== "completed") fail(`session 未 done（status=${final?.status}）`);
  if (!final.pr_url) fail("session.pr_url 未写");
  ok(`session done，pr_url=${final.pr_url}`);

  // 10. 验远程 bare 上确有交付分支（pr 阶段真 push 了）
  const branches = Bun.spawnSync(["git", "branch", "-a"], { cwd: bare }).stdout.toString();
  if (!branches.includes("reqgenie/")) fail("远程 bare 无 reqgenie/ 交付分支（pr 阶段未真 push）", branches);
  ok("远程交付分支已 push");

  try { rmSync(repoBase, { recursive: true, force: true }); } catch { /* */ }
  cleanup();
  console.log("\n✅ runner 离线契约冒烟全链路通（clarify→spec→dev→pr→pr_created→done）");
}

main().catch((e: unknown) => { console.error("runner-smoke 异常：", e); cleanup(); process.exit(1); });
```

> 注（Step 7/8 的 mock 寻址）：mock-control-plane 的 `/sessions/pending` 按 `assigned_runner === rid` 精确匹配（Task 2 实现）。runner-smoke 离线场景下，runner 注册返回的真实 id 在 daemon 进程内、脚本拿不到，故 dispatch 时无法精确指定。**实现 runner-smoke 时二选一**：(a) 给 mock-control-plane 加一个测试旗标 `claimAnyRunner=true`（pending 端点对任意已注册 runner 都可领），冒烟脚本启用它；(b) 让 mock-control-plane 在 runner 注册时把 runner_id 记下，dispatchSession 传 `assignedRunner: cp.lastRegisteredRunnerId()`。推荐 (a)，最小侵入。在 Task 2 的 mock 里补 `claimAnyRunner` 旗标（默认 false 保持精确匹配测试不变）并在本脚本 `cp.start()` 后 `cp.enableClaimAny()`。

- [ ] **Step 3：在 mock-control-plane 加 `claimAnyRunner` 旗标（支撑 Step 2 注的寻址）**

在 `scripts/runner/mock-control-plane.ts` 加字段与方法：
```ts
  #claimAny = false;
  enableClaimAny(): void { this.#claimAny = true; }
```
并把 pending 端点的 claimable 查找改为：
```ts
      const claimable = [...this.#sessions.values()].find(
        (s) => (this.#claimAny || s.assigned_runner === rid) && s.status === "created",
      );
```

- [ ] **Step 4：加 package.json script**

在 `package.json` 的 `scripts` 加：
```json
    "runner-smoke": "bun run scripts/runner/runner-smoke.ts",
```

- [ ] **Step 5：运行确认通过**

Run: `bun run runner-smoke`
Expected（前提 A1+A2 已落地）: 逐条 `✓` + `✅ runner 离线契约冒烟全链路通`。**若 dev/pr 阶段未真 push / 未出 pr_created，定位 A2 rounds.ts 的 dev/pr round 或 A1 submit-pr 缺口**，按对应计划修，不改断言。
Run（确保改了 mock 后 Task 2 测试不回归）: `bun test tests/runner-mock-control-plane.test.ts` → PASS。

- [ ] **Step 6：提交**

```bash
git add scripts/runner/runner-smoke.ts scripts/runner/mock-control-plane.ts package.json
git commit -m "test(runner): 离线契约冒烟 runner-smoke（mock-cp+mode:runner daemon+executor 跑通 clarify→pr_created，CI 可跑）"
```

---

## Task 7：全链路 live e2e 脚本 `runner-e2e-live.ts`（需真 reqgenie + 真 GitHub）

mock 不可替代的部分——真 gate 人审、真飞书澄清、真 vend token、真 PR merge——用半自动脚本 + 手册覆盖。脚本驱动真 reqgenie HTTP API，断言每阶段事件 + 最终真 PR url；gate 处可由 `RUNNER_E2E_AUTO_APPROVE=1` 调真后端 gate decision 自动批，否则暂停等人在前端点。

**Files:**
- Create: `scripts/runner/runner-e2e-live.ts`
- Modify: `package.json`（加 `runner-e2e-live` script）

- [ ] **Step 1：写脚本**

```ts
#!/usr/bin/env bun
// Runner 全链路 live e2e —— 【需真 reqgenie 后端 + 真 GitHub 私有仓 + 已注册在线 runner】。
// 不可在 CI 无人值守跑（gate 默认等人点）。验证 mock 覆盖不到的真实面：真 gate / 真飞书 / 真 vend token / 真 PR。
//
// 环境变量：
//   REQGENIE_URL        reqgenie 后端 (默认 http://127.0.0.1:3001)
//   REQGENIE_JWT        有该需求写权限的开发者 JWT（必填）
//   REQGENIE_REQ_ID     已存在的需求 id（必填，需绑定真 GitHub 私有仓）
//   REQGENIE_RUNNER_ID  目标在线 runner id（必填）
//   REQGENIE_REPO_ID    需求关联的仓库 uuid（必填）
//   RUNNER_E2E_AUTO_APPROVE  =1 时脚本调 gate decision 自动批（否则暂停等人在前端点）
//
//   bun run runner-e2e-live
const URL = process.env.REQGENIE_URL ?? "http://127.0.0.1:3001";
const JWT = must("REQGENIE_JWT");
const REQ = must("REQGENIE_REQ_ID");
const RUNNER = must("REQGENIE_RUNNER_ID");
const REPO = must("REQGENIE_REPO_ID");
const AUTO = process.env.RUNNER_E2E_AUTO_APPROVE === "1";

function must(k: string): string { const v = process.env[k]; if (!v) { console.error(`缺环境变量 ${k}`); process.exit(2); } return v; }
function fail(m: string, extra?: unknown): never { console.error(`  ✗ ${m}`); if (extra) console.error(extra); process.exit(1); }
function ok(m: string): void { console.log(`  ✓ ${m}`); }
const h = { authorization: `Bearer ${JWT}`, "content-type": "application/json" };
async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${URL}${path}`, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) fail(`${method} ${path} → ${r.status}`, await r.text());
  return (await r.json() as { data: T }).data;
}

interface Ev { seq: number; event_type: string; stage: string | null; payload: Record<string, unknown>; }
interface Sess { id: string; status: string; current_stage: string; pr_url: string | null; }

async function main(): Promise<void> {
  console.log(`runner live e2e：reqgenie=${URL} req=${REQ} runner=${RUNNER} auto=${AUTO}`);

  // 1. 建 session（autopilot_selfhosted + 目标 runner）
  const s = await api<Sess>("POST", `/api/requirements/${REQ}/dev-sessions`,
    { agent_backend: "autopilot_selfhosted", assigned_runner: RUNNER, repo_ids: [REPO] });
  if (s.status !== "created") fail(`新 session 应 created，得 ${s.status}`);
  ok(`session 建成 ${s.id}（status=created, stage=clarify）`);
  const sid = s.id;

  // 2. 驱动链路：轮询事件流，处理 clarify / gate，直到 done/failed
  let lastSeq = 0;
  const deadline = Date.now() + 30 * 60_000; // live e2e 给 30 分钟（含真 AI + 真 clone + 真 push）
  const seenStages = new Set<string>();
  while (Date.now() < deadline) {
    const evs = await api<Ev[]>("GET", `/api/dev-sessions/${sid}/events?after_seq=${lastSeq}`);
    for (const e of evs) {
      lastSeq = Math.max(lastSeq, e.seq);
      if (e.stage) seenStages.add(e.stage);
      if (e.event_type === "clarification_requested") {
        await api("POST", `/api/dev-sessions/${sid}/messages`, { message: "按默认方案实现，无额外约束" });
        ok("回答澄清（user_message）");
      }
      if (e.event_type === "gate_opened") {
        const gid = String(e.payload.gate_id);
        if (AUTO) {
          await api("POST", `/api/dev-sessions/${sid}/gates/${gid}/decision`, { decision: "approved" });
          ok(`自动批准 gate（stage=${e.stage}, gate=${gid}）`);
        } else {
          console.log(`  ⏸ gate 打开（stage=${e.stage}, gate=${gid}）—— 请在 reqgenie 前端点「通过」，脚本继续轮询…`);
        }
      }
      if (e.event_type === "pr_created") ok(`pr_created：${e.payload.pr_url}`);
      if (e.event_type === "limit_hit") fail("命中成本闸门 limit_hit（链路未正常推进）", e.payload);
    }
    const cur = await api<Sess>("GET", `/api/dev-sessions/${sid}`);
    if (cur.status === "completed") {
      // 3. 终态断言
      for (const st of ["clarify", "spec", "dev", "pr"]) if (!seenStages.has(st)) fail(`未经历 stage=${st}`);
      if (!cur.pr_url) fail("session 完成但无 pr_url");
      ok(`全链路完成，PR=${cur.pr_url}（请手动 review + merge 完成签字）`);
      console.log("\n✅ runner live e2e 全链路通（clarify→spec→dev→pr→PR）。merge 由人在 GitHub 完成。");
      return;
    }
    if (cur.status === "failed") fail("session failed", cur);
    await Bun.sleep(3000);
  }
  fail("live e2e 超时（30min 未达终态）");
}
main().catch((e: unknown) => { console.error("runner-e2e-live 异常：", e); process.exit(1); });
```

- [ ] **Step 2：加 package.json script**

在 `scripts` 加：
```json
    "runner-e2e-live": "bun run scripts/runner/runner-e2e-live.ts",
```

- [ ] **Step 3：语法/类型校验（不跑 live）**

Run: `bun run typecheck`
Expected: 无错（脚本不连真后端也要类型干净）。
Run（确认脚本在缺环境变量时优雅退出 2，不挂起）:
```bash
bun run scripts/runner/runner-e2e-live.ts; echo "exit=$?"
```
Expected: 打印 `缺环境变量 REQGENIE_JWT` + `exit=2`。

- [ ] **Step 4：（可选，有真环境时）跑 live e2e**

按 `docs/runner-integration-guide.md` 起好 PG/Redis/reqgenie 后端 + 注册 runner + 准备绑真私有仓的需求后：
```bash
REQGENIE_JWT=<dev-jwt> REQGENIE_REQ_ID=<req> REQGENIE_RUNNER_ID=<runner> REQGENIE_REPO_ID=<repo uuid> \
RUNNER_E2E_AUTO_APPROVE=1 bun run runner-e2e-live
```
Expected: 逐 stage `✓` + 真 PR url + `✅ runner live e2e 全链路通`。

- [ ] **Step 5：提交**

```bash
git add scripts/runner/runner-e2e-live.ts package.json
git commit -m "test(runner): 全链路 live e2e 脚本（需真 reqgenie+真 GitHub；驱动 clarify→spec→dev→pr→PR，gate 可自动/人工）"
```

---

## Task 8：失败路径 e2e（驳回 rework / runner 重启续作 / session 取消 409 / token 过期重取）

spec §11 端到端失败路径。可 mock 的三条（驳回增量 rework、runner 重启事件流续 + 本地重入安全、session 取消优雅退出）用 mock-control-plane 驱动；token 过期重取断言走 git-token 端点现取语义（mock 可验「push 前现取」调用，真过期需 live）。

**Files:**
- Create: `tests/runner-failure-paths.test.ts`

- [ ] **Step 1：核对 A2 poller/session-loop 的取消与重启续作入口**

Run:
```bash
cd /c/Users/larry/Desktop/workspace/autopilot && grep -nE 'cancel|409|session_cancelled|after_seq|reset|reused|checkout_existing|git-token|现取|gitToken' src/daemon/runner/poller.ts src/daemon/runner/session-loop.ts src/daemon/runner/rounds.ts | head -40
```
Expected: 看到取消检测（fetchSession 终态 / session_cancelled）、after_seq 续、git-token 取用点。**按真实 API 调整下方测试的注入方式**。

- [ ] **Step 2：写测试（驱动 session-loop + executor，断言失败路径行为）**

```ts
// tests/runner-failure-paths.test.ts
// 失败路径 e2e（可 mock 部分）：驳回增量 rework / session 取消优雅退出 / 重启事件流续。
import { test, expect } from "bun:test";
import { runSessionLoop, SignalQueue } from "../src/daemon/runner/session-loop";

// 复用 conformance 的 fakeBackend（带 current_stage 推进）
function fakeBackend(initialStage = "spec") {
  const events: Array<{ seq: number; event_type: string; payload: Record<string, unknown> }> = [];
  let seq = 0, gateN = 0;
  const state: { status: string; current_stage: string; spec_md?: string } = { status: "running", current_stage: initialStage };
  return {
    events, state,
    emit(t: string, p: Record<string, unknown> = {}) { events.push({ seq: ++seq, event_type: t, payload: p }); },
    async postEvent(ev: { event_type: string; payload?: Record<string, unknown> }) {
      const stored = { ...ev, seq: ++seq, payload: { ...(ev.payload ?? {}) } } as { seq: number; event_type: string; payload: Record<string, unknown> };
      if (ev.event_type === "gate_opened") stored.payload.gate_id = `gate-${++gateN}`;
      events.push(stored); return stored;
    },
    async fetchEvents(after: number) { return events.filter((e) => e.seq > after); },
    async fetchSession() { return { status: state.status, current_stage: state.current_stage, spec_md: state.spec_md }; },
  };
}
const gateRound = (v: string) => [
  { event_type: "stage_artifact", payload: { kind: "spec", content: v } },
  { event_type: "gate_opened", payload: { stage: "spec" } },
];

test("驳回 → 带评论增量重做 → 再批准（rework round 携带驳回评论）", async () => {
  const b = fakeBackend("spec"); const q = new SignalQueue(); const ctxs: string[] = [];
  const loop = runSessionLoop({ backend: b, queue: q, ctx: { roundFn: async (c: { accumulated: string }) => { ctxs.push(c.accumulated); return gateRound("doc"); }, requirement: "x", pollMs: 5 } });
  setTimeout(() => b.emit("gate_decided", { gate_id: "gate-1", decision: "rejected", comment: "缺回滚方案" }), 10);
  setTimeout(() => b.emit("gate_decided", { gate_id: "gate-2", decision: "approved" }), 40);
  const r = await loop;
  expect(r.reason).toBe("approved");
  expect(r.rounds).toBe(2);
  expect(ctxs[1]).toContain("缺回滚方案"); // 增量 rework 注入驳回评论（spec §4.5 dev rework 增量契约同源）
});

test("session 取消（session_cancelled 事件 + 状态 cancelled）→ 等待点优雅退出 terminal", async () => {
  const b = fakeBackend("spec"); const q = new SignalQueue();
  const loop = runSessionLoop({ backend: b, queue: q, ctx: { roundFn: async () => gateRound("doc"), requirement: "x", pollMs: 5 } });
  setTimeout(() => { b.emit("session_cancelled", {}); b.state.status = "cancelled"; }, 15);
  expect((await loop).reason).toBe("terminal");
});

test("重启续作：afterSeq 从中途接，已处理事件不重复并入（事件流续，spec §4.3）", async () => {
  const b = fakeBackend("spec"); const q = new SignalQueue();
  // 预置 3 条历史事件（模拟重启前已发生）：assistant + gate_opened + 驳回
  b.emit("assistant_message", { message: "v1" });
  await b.postEvent({ event_type: "gate_opened", payload: { stage: "spec" } }); // gate-1
  b.emit("gate_decided", { gate_id: "gate-1", decision: "rejected", comment: "上轮意见" });
  const startSeq = b.events[b.events.length - 1]!.seq;
  const ctxs: string[] = [];
  // 重启：afterSeq = startSeq（只拉新增），不应把「上轮意见」当本轮新评论重复并入历史已消费部分
  const loop = runSessionLoop({ backend: b, queue: q, ctx: { afterSeq: startSeq, roundFn: async (c: { accumulated: string }) => { ctxs.push(c.accumulated); return gateRound("v2"); }, requirement: "x", pollMs: 5 } });
  setTimeout(() => b.emit("gate_decided", { gate_id: "gate-2", decision: "approved" }), 30);
  const r = await loop;
  expect(r.reason).toBe("approved");
  // 第 1 回合 accumulated 不含已被 afterSeq 跳过的历史 user_message（重启后从 after_seq 续，不重复并入旧消息）
  expect(ctxs[0] ?? "").not.toContain("上轮意见");
});

test("token 现取语义：rounds 的 git 操作每次向 control-plane 现取 token（不缓存到 session）", () => {
  // 静态校验：rounds.ts 在 dev/pr round 内调 git-token 端点（spec §D6 push 前现取，防 1h 过期）
  const src = Bun.file("src/daemon/runner/rounds.ts");
  return src.text().then((s) => {
    expect(/git-token|fetchGitToken|gitToken/.test(s), "rounds.ts 须在 dev/pr round 取 git token（push 前现取，不复用 session 级缓存）").toBe(true);
  });
});
```

> 注：「dev 中间态重启 reset 基线」「rework 命中既有脏树零重 clone」属 executor + sandbox 真文件系统行为，A1/A2 已各有单测（A1 Task 已知边界标注 dev 重启 reset 归 A2）。本任务在 session-loop 层验事件流续作与不重复并入，文件系统级 reset 由 A2 的 rounds/sandbox 测试覆盖，C 不重复造（避免与 A2 测试重叠）。第 4 个断言是静态护栏，逼 rounds.ts 真现取 token。

- [ ] **Step 3：运行确认通过**

Run: `bun test tests/runner-failure-paths.test.ts`
Expected: PASS（4 用例；前提 A2 session-loop/rounds 已落地且 afterSeq 语义如参考实现）。

- [ ] **Step 4：提交**

```bash
git add tests/runner-failure-paths.test.ts
git commit -m "test(runner): 失败路径 e2e（驳回增量rework/session取消优雅退出/重启afterSeq续/token现取护栏）"
```

---

## Task 9：R1 验收清单勾稽 `runner-acceptance.ts`

spec §9 R1 逐条勾稽：机检项自动跑（测试/脚本是否绿、文件是否存在、契约断言），人工项打印待办清单。一条命令给出 R1 是否达标的红绿总账。

**Files:**
- Create: `scripts/runner/runner-acceptance.ts`
- Modify: `package.json`（加 `runner-acceptance` script）

- [ ] **Step 1：写脚本**

```ts
#!/usr/bin/env bun
// R1 验收勾稽（spec §9 R1）：机检项自动跑，人工项打印待办。一条命令出红绿总账。
//   bun run runner-acceptance
import { existsSync } from "fs";
import { join } from "path";

const REPO = process.cwd();
const REQGENIE = join(REPO, "../reqgenie");

interface Check { id: string; desc: string; kind: "auto" | "manual"; run?: () => boolean; note?: string; }

function fileExists(...p: string[]): boolean { return p.every((f) => existsSync(join(REPO, f))); }
function reqgenieFile(f: string): boolean { return existsSync(join(REQGENIE, f)); }
function bunTest(file: string): boolean {
  const r = Bun.spawnSync({ cmd: ["bun", "test", file], cwd: REPO, stdout: "pipe", stderr: "pipe" });
  return (r.exitCode ?? 1) === 0;
}
function cargoCompiles(test: string): boolean {
  const r = Bun.spawnSync({ cmd: ["cargo", "test", "--test", test, "--no-run"], cwd: join(REQGENIE, "backend"), stdout: "pipe", stderr: "pipe" });
  return (r.exitCode ?? 1) === 0;
}

const checks: Check[] = [
  // ── autopilot executor 核（A1）──
  { id: "A1-executor", desc: "executor 三块存在（git-ops/submit-pr/agent-runner/index）", kind: "auto",
    run: () => fileExists("src/core/executor/git-ops.ts", "src/core/executor/submit-pr.ts", "src/core/executor/agent-runner.ts", "src/core/executor/index.ts") },
  { id: "A1-token", desc: "ensureCodebase 支持注入 gitToken（pickCloneToken）", kind: "auto",
    run: () => bunTest("tests/executor-token-injection.test.ts") },
  { id: "A1-redline", desc: "executor 不耦合状态机/调度器/createTask", kind: "auto",
    run: () => bunTest("tests/executor-no-statemachine-import.test.ts") },
  // ── autopilot runner 协议客户端（A2）──
  { id: "A2-runner-mod", desc: "src/daemon/runner/ 四模块存在", kind: "auto",
    run: () => fileExists("src/daemon/runner/registration.ts", "src/daemon/runner/poller.ts", "src/daemon/runner/session-loop.ts", "src/daemon/runner/rounds.ts") },
  { id: "A2-conformance", desc: "session-loop 与 agent-worker 参考行为对齐（8 剧本）", kind: "auto",
    run: () => bunTest("tests/runner-session-loop-conformance.test.ts") },
  { id: "A2-contract", desc: "协议枚举契约（event_type/stage ⊆ 052；不自定 seq/gate_id）", kind: "auto",
    run: () => bunTest("tests/runner-protocol-contract.test.ts") },
  { id: "A2-failure", desc: "失败路径（驳回rework/取消/重启续/token现取）", kind: "auto",
    run: () => bunTest("tests/runner-failure-paths.test.ts") },
  // ── reqgenie 侧（B）──
  { id: "B-migrations", desc: "reqgenie 060/061/062 迁移存在", kind: "auto",
    run: () => reqgenieFile("backend/migrations/060_runners.sql") && reqgenieFile("backend/migrations/061_dev_sessions_runner.sql") && reqgenieFile("backend/migrations/062_runner_manage_perm.sql") },
  { id: "B-e2e-compiles", desc: "reqgenie runner_e2e 集成测试编译通过", kind: "auto",
    run: () => cargoCompiles("runner_e2e") },
  // ── 联调闭环（C）──
  { id: "C-smoke", desc: "离线契约冒烟 runner-smoke 全链路通", kind: "auto",
    run: () => { const r = Bun.spawnSync({ cmd: ["bun", "run", "scripts/runner/runner-smoke.ts"], cwd: REPO, stdout: "pipe", stderr: "pipe" }); return (r.exitCode ?? 1) === 0; } },
  { id: "C-guide", desc: "联调启动手册存在", kind: "auto", run: () => fileExists("docs/runner-integration-guide.md") },
  // ── 人工/需真环境项 ──
  { id: "B-真库e2e", desc: "reqgenie runner_e2e 在真 PG+Redis 通过", kind: "manual",
    note: "起 docker-compose.dev.yml 后：ORCH_PG=... ORCH_REDIS=... cargo test --test runner_e2e -- --ignored" },
  { id: "C-live", desc: "全链路 live e2e（真 reqgenie+真 GitHub 私有仓→真 PR）通过", kind: "manual",
    note: "见手册起全套 + bun run runner-e2e-live（RUNNER_E2E_AUTO_APPROVE=1）" },
  { id: "R1-飞书澄清", desc: "clarify 阶段飞书卡澄清答复回流（真飞书）", kind: "manual",
    note: "live e2e 中在飞书点澄清卡，确认 user_message 回流" },
  { id: "R1-merge签字", desc: "PR 在 GitHub 真 merge 完成签字", kind: "manual",
    note: "live e2e 产 PR 后人工 review + merge" },
  { id: "R1-成本闸门", desc: "成本闸门触顶产 limit_hit（round 超时/STAGE_MAX/SESSION_MAX）", kind: "manual",
    note: "live/真库环境压低 STAGE_MAX 触发，确认 limit_hit 事件 + session failed 不静默" },
];

let autoPass = 0, autoFail = 0;
console.log("════ Runner R1 验收勾稽（spec §9）════\n── 机检项 ──");
for (const c of checks.filter((c) => c.kind === "auto")) {
  process.stdout.write(`  [${c.id}] ${c.desc} … `);
  let pass = false;
  try { pass = c.run!(); } catch (e: unknown) { pass = false; console.log(`异常：${(e as Error).message}`); }
  if (pass) { console.log("✓"); autoPass++; } else { console.log("✗"); autoFail++; }
}
console.log("\n── 人工/真环境项（需手动确认）──");
for (const c of checks.filter((c) => c.kind === "manual")) console.log(`  [ ] [${c.id}] ${c.desc}\n        → ${c.note}`);

console.log(`\n════ 机检：${autoPass} 通过 / ${autoFail} 失败 ════`);
if (autoFail > 0) { console.log("R1 机检未全绿，逐项定位对应 A1/A2/B/C 缺口。"); process.exit(1); }
console.log("R1 机检全绿。人工项请按上方清单逐条确认后方可宣告 R1 达标。");
```

- [ ] **Step 2：加 package.json script**

在 `scripts` 加：
```json
    "runner-acceptance": "bun run scripts/runner/runner-acceptance.ts",
```

- [ ] **Step 3：运行（前提 A1+A2+B+C 前序任务已落地）**

Run: `bun run runner-acceptance`
Expected: 机检项逐条 `✓`（全绿则 exit 0），人工项打印待办清单。**任一机检 `✗` → 该 id 指向的实现计划有缺口，回对应计划修。**

- [ ] **Step 4：提交**

```bash
git add scripts/runner/runner-acceptance.ts package.json
git commit -m "test(runner): R1 验收勾稽脚本（机检 A1/A2/B/C 自动跑 + 人工/真环境项清单，spec §9）"
```

---

## Task 10：全量回归 + CI 接线

确保 C 新增的可 mock 测试进 CI 常跑（live/真库项标注为手动/可选 job），且不破既有 189 个测试。

**Files:**
- Modify: `.github/workflows/ci.yml`（加 runner 契约测试 + runner-smoke 到 CI；真库 job 标 manual/optional）
- 验证：autopilot 全量 `bun test` + `bun run typecheck`

- [ ] **Step 1：核对现有 CI 结构**

Run:
```bash
cd /c/Users/larry/Desktop/workspace/autopilot && cat .github/workflows/ci.yml
```
Expected: 看到既有 job（bun test / typecheck / smoke-test）。据其结构把 runner 契约测试并入。

- [ ] **Step 2：在 CI 加 runner 契约步骤（并入既有 test job 之后）**

在 `.github/workflows/ci.yml` 既有 test job 加步骤（按实际 job 名/缩进调整）：
```yaml
      - name: Runner 契约测试（mock，无需 reqgenie/GitHub）
        run: |
          bun test tests/runner-mock-control-plane.test.ts \
                   tests/runner-session-loop-conformance.test.ts \
                   tests/runner-protocol-contract.test.ts \
                   tests/runner-failure-paths.test.ts
      - name: Runner 离线契约冒烟
        run: bun run runner-smoke
```
> 注：runner-protocol-contract 测试需 reqgenie 052 迁移文件可达（`../reqgenie/backend/migrations/052_dev_sessions.sql`）。CI 单仓 checkout 时该路径不存在——测试 `enumsFromMigration()` 会抛「迁移不存在」。**CI 接线时二选一**：(a) CI 加 `actions/checkout` 第二步 checkout reqgenie 到 `../reqgenie`；(b) 把 052 的枚举集合在 autopilot 侧固化一份 fixture（`tests/fixtures/reqgenie-052-enums.json`）+ 一个「fixture 与真迁移一致」的本地校验（仅在 reqgenie 可达时跑）。推荐 (a) 保持单一真理来源；CI 不便多仓 checkout 时退 (b)。在 Step 2 落地时按 CI 能力定，并在 PR 注明选了哪个。

- [ ] **Step 3：全量回归**

Run:
```bash
bun run typecheck
bun test
```
Expected: typecheck 无错；全量测试 = 既有 189 通过集 + C 新增（runner-mock-control-plane / conformance / protocol-contract / failure-paths）全绿，无新增失败。
Run: `bun run runner-smoke` → `✅ ...全链路通`（前提 A1+A2 已落地）。

- [ ] **Step 4：提交**

```bash
git add .github/workflows/ci.yml
git commit -m "ci(runner): runner 契约测试 + 离线冒烟进 CI（mock，无需真 reqgenie/GitHub）"
```

---

## Self-Review（计划自检，已执行）

1. **Spec 覆盖**：
   - §7 端到端时序 → Task 6（runner-smoke 跑 注册→领活→clarify→spec→dev→pr→done）+ Task 7（live 全链路）+ Task 1（手册逐步对照时序）。
   - §11 测试要点 → reqgenie 侧（注册一次性/原子claim并发/拉模型回收/revoke 401/max_stage=pr/pr_created/单活跃session）= Task 5；autopilot 侧（session-loop 移植对齐/executor 脱状态机/dev 产 diff pr 才 push）= Task 3+6（A1 红线测试在 A1 计划，本计划 Task 9 勾稽其存在）；端到端（注册→下发→各 gate→merge / 驳回 rework / runner 重启续 + 重入安全 / session 取消 409）= Task 6/7/8。
   - §4 协议（seq 后端定 / gate_id 后端注入 / stage 枚举）→ Task 2（mock 实现该语义）+ Task 4（枚举契约 + 不自定 seq/gate_id 护栏）。
   - §9 R1 范围 → Task 9 逐条勾稽。
   - §4.5 沙箱契约（dev 产 diff / pr 才 push / 交付分支命名 / rework 增量）→ Task 6（验远程出 reqgenie/ 分支）+ Task 8（驳回 rework 注入评论）；文件系统级 reset 基线归 A2，C 不重复（已注明）。
   - §D6 token → Task 8（token 现取静态护栏）+ Task 6（mock injectGitToken）+ Task 7（真 vend token live）。
2. **占位扫描**：无 TBD/TODO/「适当处理」/「类似 TaskN」。三处「实现前核对」标注（Task 3 Step 1 session-loop 签名、Task 5 Step 1 B 路由名、Task 6 Step 1 runner CLI 形态、Task 8 Step 1 poller 入口、Task 10 Step 2 CI 多仓 checkout）均给出确切核对命令 + 二选一具体方案 —— 是对「A2/B 尚未落地、其精确符号名以代码为准」的诚实防御，非占位；所有断言值（reason/rounds/status/枚举/HTTP code）均确切写死。
3. **类型一致**：mock-control-plane 的 `EventRow`/`SessionState` 在 Task 2/6/8 一致；`MockControlPlane` 公开方法（`dispatchSession`/`decideGate`/`injectUserMessage`/`cancelSession`/`reapStaleRunner`/`injectGitToken`/`events`/`sessionStatus`/`enableClaimAny`）跨 Task 引用一致；conformance/failure-paths 的 `fakeBackend` 与参考 `sessionLoop.test.mjs` 逐字同构（含 seq 分配 + gate_id 注入）；reqgenie `runner_e2e.rs` 的 `setup_db`/`build_state`/`AppState` 装配字段与 `dev_session_http.rs` 完全对齐（已逐字段核对 common/mod.rs 与 dev_session_http.rs 的 AppState 构造）。
4. **决策记录**：
   - C 是验证层，不改 A1/A2/B 实现；断言红 = 实现缺口，回对应计划修，不放宽断言（贯穿各 Task Step）。
   - 三层防线分级：mock（CI 常跑）/ 真库（PG+Redis，可选 job）/ live（真 reqgenie+真 GitHub，人工/夜间）—— 明确标注每条 e2e 的环境需求。
   - session-loop 对齐用「同剧本喂两边断言一致」而非「读两边源码比对」，因行为对齐才是 spec §6.1 要的「对齐证明」。
   - 枚举契约从 reqgenie 052 迁移解析当 oracle（单一真理来源），逼出 `pr_created` 等 B 新增事件未登记的差异。
   - mock 寻址用 `claimAnyRunner` 旗标解 runner-smoke 拿不到进程内 runner_id 的问题（最小侵入，默认关、不破精确匹配测试）。

## 已知边界（交给其它计划/后续）
- **dev 中间态重启 reset 基线 + rework 命中脏树零重 clone**（文件系统级）：spec §4.5 标 R1 正确性，归 A2 的 rounds/sandbox 单测；C 在 session-loop 层验事件流续作（Task 8），不重复造文件系统测试。
- **真飞书澄清卡渲染/回流**：纯人工项（Task 9 manual 清单），无法 mock（依赖真飞书租户）。
- **成本闸门真触顶**（round 超时/STAGE_MAX/SESSION_MAX 实际墙钟）：Task 8 验 session-loop 的 maxRounds（mock 可控），真墙钟超时/STAGE_MAX 触发归 A2 实现 + Task 9 manual 项在真库环境压参数验。
- **reqgenie 前端 Runner 管理页 / gate 卡**：UI 层验收（spec §5.4），归 B 前端 + 人工 live 确认，不在 C 自动化范围。
- **多 runner / 多 session 并发**：R3 范围（spec §9），C 只验单 runner 单 session 自律（Task 6）。
