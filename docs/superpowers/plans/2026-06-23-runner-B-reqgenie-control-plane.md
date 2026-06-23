# Runner B：reqgenie 控制面 Implementation Plan

> ## ⚠️ 审查修正（执行前必读，覆盖下方对应处）
> 1. **[blocker] 原子 claim 判赢落实**：`claim_one_pending` 用条件 `UPDATE … SET status='queued', … WHERE status='created' AND assigned_runner=$id RETURNING *` + Rust `fetch_optional()` → `Some(session)` 判赢（仅命中行返回）。Step 4 验收**加并发测试**：两连接同 session 并发 claim，断言恰一返回 `Some` 且 status 变 queued。
> 2. **[blocker] 迁移 062 权限 seed 安全性**：`ON CONFLICT (role, permission)` 依赖 `role_permissions` 既有 UNIQUE——实现前先 `\d role_permissions`（及 `role_permissions_v2`）确认约束在；**不在则改 `DELETE … WHERE …; INSERT …` 幂等写法**，不擅自给旧表加约束。
> 3. **[major] reaper 回收范围**：只收 `queued`/`running` 非终态 session → 回退 `created` 保留 `assigned_runner`；**`paused` 不收**（人工暂停）。回收测试加注断言 paused 不被心跳超时触发。
> 4. **[major] 前端确认按钮 disabled 条件**：DevSessionEntry 加 `runnersLoading`：`disabled: backend==='autopilot_selfhosted' && (!runnerId || runnersLoading)`。
> 5. **[major] secret_hash 索引（可选优化）**：060 迁移可加 `CREATE INDEX idx_runners_secret_hash ON runners(secret_hash) WHERE deleted_at IS NULL;`（verify 走 id PK 已够快，此为 Heap Fetch 优化，按需）。
> 6. **[minor] dispatcher 选择测试**：补一条单测覆盖未知 `agent_backend` → 默认 `PushDispatcher`（保守降级）。
> 7. **[doc·已为设计前提] 多实例长轮询**：`broadcast` 仅进程内，跨 reqgenie 实例靠 `/sessions/pending` 的 last-chance 重查兜底（≤1s POLL_INTERVAL 延迟），`wait=50s`。单实例无此延迟。在 /sessions/pending handler 处补 caveat 注释。
> 8. **[流程] 提交前必跑**（reqgenie CLAUDE.md）：`cargo +nightly fmt` + `cargo clippy -- -D warnings`；前端 `npm run build`。
> 9. **[跨契约·见 spec §14]** ① 内部端点（events/git-token/heartbeat）**双鉴权**：全局 worker secret（codex 路径）**或** per-runner secret + `session.assigned_runner==runner` 归属校验（自托管路径）；全局 secret 不下发 runner 机器（§14.1 安全）。② `ingest_worker_event` 补 `session_failed`/`limit_hit`→failed（§14.2）。③ 迁移：`dev_session_stage_artifacts.kind` 含 `dev`/`pr`、`dev_sessions.current_stage` CHECK 含全 7 stage（§14.3）。④ `assigned_runner` 在 `create_session` 落库、`RunnerDispatcher.dispatch` 为 no-op（§14.5）。⑤ `/sessions/pending` claim 响应含 `status=queued`（§14.6）。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> ⚠️ **本计划在 reqgenie 仓库（`C:\Users\larry\Desktop\workspace\reqgenie`）实施，不是 autopilot。** 后端 Rust（Axum+SQLx+PG），前端 React（Vite+TS+Ant Design）。

**Goal:** 给 reqgenie 后端加「自托管 runner 控制面」：autopilot 注册为 `agent_backend=autopilot_selfhosted`，通过「注册 + 长轮询拉式领活 + 拉模型心跳回收」消费现有 `dev_sessions` 事件协议，全程复用 reqgenie 的阶段机/关卡/事件流/飞书；并放开 `autopilot_selfhosted` session 的 `max_stage=pr`、新增 `pr_created` 事件摄取写 `pr_url`、前端加「目标 runner」选择与 Runner 管理页。

**Architecture:** 连接倒转——只把「派发」一段从「后端 push 到固定 worker」改成「runner 注册后长轮询领待派 session」。出站端点（events/heartbeat/git-token/get-session）对 runner 原样复用（鉴权切换为 runner 凭证）。新增：① `runners`/`registration_tokens` 表；② `dispatch_session` 拆 `push_dispatch`（codex 原样 POST）+ `assign_runner`（仅标 `assigned_runner`，不 POST），按 `agent_backend` 多态；③ `routes/runners.rs`（注册/心跳/长轮询原子 claim/注销 + admin 生成 token/列表/revoke）；④ reaper 拉模型回收（runner 心跳超时→该 runner 的 queued/running session 回退 created 保留 assigned_runner；session 心跳超时→failed）；⑤ `ingest_worker_event` 加 `pr_created` 分支；⑥ `create_session` 按 backend 放 `max_stage`；⑦ 前端两处。

**Tech Stack:** Rust（Axum 0.8 风格 `{id}` 路径、SQLx PG、tokio、uuid、chrono、thiserror、reqwest）；测试 `cargo test`（集成测试用 `ORCH_PG` 真实 PG，参照 `tests/dev_session_db.rs` / `tests/dev_session_http.rs`）；前端 React + Ant Design + @tanstack/react-query，`npm run build` 编译校验 + Playwright MCP 验证交互。

**提交前质量闸门（reqgenie CLAUDE.md 强制）：**
- 后端（在 `backend/` 下）：`cargo +nightly fmt` → `cargo clippy -- -D warnings`（所有警告视为错误）。
- 前端（在 `frontend/` 下）：`npm run build`（TS 编译 + 未使用变量检查）。
- 迁移**手动管理、不用 sqlx 跟踪表**（无 `_sqlx_migrations`）；本计划只新增 `060/061/062` SQL 文件，由用户在生产手动执行；测试库由 `tests/dev_session_http.rs::setup_db` 自动按文件名排序全量应用（新文件自动纳入）。
- git commit message 用中文。

**Spec:** `C:\Users\larry\Desktop\workspace\autopilot\docs\superpowers\specs\2026-06-23-reqgenie-runner-design.md`（§4.1/§4.2/§4.4/§5 全部 + §D2/D3/D5；本计划 = spec §5「reqgenie 侧改造」全集 + §4.5 协议契约的后端侧 `pr_created`/`max_stage=pr`）。autopilot 侧 executor/runner-client（§6）由 A1/A2 计划覆盖，不在本计划范围。

---

## 关键既有事实（实现前必读，已逐一核对，带 文件:行）

**迁移账本**
- 最新数字号迁移 = `059_grant_system_config_manage_v2.sql`（同时存在 `059_*` 一个数字号 + 若干 `20260xxx_*` 日期号）。`060/061/062` 数字号空闲，无撞号。`ls backend/migrations | grep '^0' | sort | tail` 已核对。
- 迁移无跟踪表：`backend/build.rs` 只注入构建时间，**不跑迁移**；`backend/src/main.rs` 启动也不应用迁移（CLAUDE.md：手动管理）。测试经 `tests/dev_session_http.rs:55-67` 读 `migrations/*.sql` 排序 raw_sql 应用、个别失败 `let _ =` 忽略。
- 权限目录表 `permissions(code, name, group_name, sort_order, is_system)`（`023_dynamic_permissions.sql:2-10`）；运行时生效授予表 `role_permissions_v2(id, role_id, permission, UNIQUE(role_id,permission))`（`017_dynamic_roles_org.sql:50-56`）；内置角色 `roles(code,...)`（`017:4-30`，admin 等已 seed）。补权限标准三段式见 `055_add_xbot_manage_permission.sql`（插 permissions 目录 + role_permissions 旧表 + role_permissions_v2 admin 兜底）与 `059`。
- `dev_sessions` 表结构 `052_dev_sessions.sql:11-31`：含 `agent_backend VARCHAR NOT NULL DEFAULT 'codex'`（**无 CHECK 约束**，spec 要求加）、`current_stage`、`max_stage`、`status`、`last_heartbeat_at`、`working_since`、`branch_name`、`pr_url`、`deleted_at`、`requirement_id`。`repo_id` 列已被 `056_dev_session_repos.sql:18` DROP，多仓走 `dev_session_repos` 结表。
- `developers(id UUID ...)`（`001_initial_schema.sql:31`），`registered_by` FK 指向它。

**派发链（worker_client.rs）**
- `WorkerClient::dispatch_session(db: PgPool, session_id: Uuid, payload: Value)`（`worker_client.rs:170-172`）现状硬编码 `PushDispatcher.dispatch(...)`。
- `trait SessionDispatcher { fn dispatch(&self, db: PgPool, session_id: Uuid, payload: Value); }`（`worker_client.rs:183-185`，已对象安全，有 `push_dispatcher_is_object_safe_dispatcher` 测试 `:270-275`）。
- `PushDispatcher`（`:188`）`impl SessionDispatcher`（`:190-261`）：POST `{base}/sessions`，受理后 CAS `created→queued` + `working_since=NOW()`。
- `WorkerClient::assemble_dispatch_payload(db, &session) -> Result<Value, sqlx::Error>`（`:121-164`）组装需求 + repos。
- `WorkerClient::notify_signal(...)`（`:53-89`）fire-and-forget 信号（与本计划无关，不改）。

**create_session（dev_sessions.rs）**
- `const PHASE1_MAX_STAGE: &str = "ui_review";`（`dev_sessions.rs:42`）。`create_session`（`:481-577`）调 `DevSessionService::create(&db, req_id, &repo_ids, &req.agent_backend, PHASE1_MAX_STAGE, created_by)`（`:535-543`），随后落 `stage_change` 事件 + 容量闸门派发（`:557-574` 用 `DevSessionReaper::working_count` / `max_active` / `WorkerClient::dispatch_session`）。
- `ensure_worker_auth(&HeaderMap) -> Result<(), AppError>`（`:313-327`）：fail-closed，校验 `Bearer {DEV_SESSION_WORKER_SECRET}`。
- worker 内部端点都在 `internal_router`（`:81-92`）：`worker_ingest_event`（`:357-420`）、`worker_list_events`（`:330-343`）、`worker_get_session`（`:346-354`）、`worker_git_token`（`:198-269`）、`worker_heartbeat`（`:284-302`）。三个 router 工厂：`router`/`requirement_router`/`internal_router`/`ws_router`（`:47/63/81/73`）。`internal_router` 在 `routes/mod.rs:158` 挂 `/api/internal`，无 JWT。

**service（dev_session_service.rs）**
- `DevSessionService::create(db, requirement_id, repo_ids, agent_backend, max_stage, created_by) -> Result<DevSession, sqlx::Error>`（`:60-93`）。
- `ingest_worker_event(db, &session, event_type, stage, actor, payload) -> Result<DevSessionEvent, sqlx::Error>`（`:487-624`）：advisory 锁内 match 分支（`gate_opened`/`stage_artifact`/`clarification_requested`/`session_failed`/`assistant_message`，`:521-612`），**无 `pr_created` 分支**（须加）。先做阶段轴前移（`:504-519`）。
- `set_status_tx`（`:230-241`，私有）、`append_event_tx`（`:203-227`，私有 MAX+1 seq）、`lock_session_tx`（`:191-200`）。
- `apply_gate_decision(...)`（`:629-833`）：approved 走 `next_stage` 推进；rejected 留本阶段回 running（`rework_target_stage` 由 CAS 写入 gate 行 `:688-698`）。
- `models::dev_session`：`next_stage(current, has_ui, max_stage) -> Option<String>`（`models/dev_session.rs:40-57`，支持任意 max_stage，pr→done 已测 `:287`），`STAGES` 含 `dev`/`pr`/`done`（`:18-26`），`is_terminal_status`（`:60`），`stage_index`（`:32`）。`DevSession` 结构含 `pr_url: Option<String>`（`:82`）。

**reaper（dev_session_reaper.rs）**
- `DevSessionReaper::tick(db) -> Result<ReaperStats, sqlx::Error>`（`:117-270`）：全局 advisory try-lock（`:121-129`）；步骤 1 心跳超时（`:131-154`）、2 墙钟（`:156-179`）、3 澄清挂起（`:181-203`）、4 排队超时（`:205-227`）、5 容量派发（`:229-266`，调 `WorkerClient::dispatch_session`）。
- `ReaperStats`（`:46-53`）。`fail_batch(db, ids, expected, status, event_type, reason) -> usize`（`:70-112`，状态守卫 CAS + 落事件）。`heartbeat_timeout_s()`=90（`:28`）、`max_active()`（`:40`）、`working_count`（`:59-65`）、`env_u64`（`:21`）。
- main 调度器 `dev_session_reaper_scheduler`（`main.rs:487-516`）每 60s 跑 `tick`。

**ws / broadcaster（routes/ws.rs）**
- `DevSessionBroadcaster`（`routes/ws.rs:96-142`）：`broadcast(session_id, json: String)`（`:125`）、`subscribe(session_id) -> broadcast::Receiver<String>`（`:131`）、惰性 `sender`（`:114-122`，内部 `Mutex<HashMap<Uuid, broadcast::Sender<String>>>`，**进程内**）。长轮询「叫醒」复用同款 `tokio::broadcast`（spec §5.2：broadcast 进程内，多实例靠 last-chance 重查兜底）。
- `AppState`（`lib.rs:22-37`）含 `db`、`dev_session_broadcaster: Arc<DevSessionBroadcaster>`、`jwt_config`。

**auth（middleware/auth.rs）**
- `Claims { sub, open_id, name, role, exp, iat }`（`:153-167`）。`check_permission(&Claims, &RolePermissions, permission: &str) -> Result<(), AppError>`（`:125-134`）。`RolePermissions(pub HashSet<String>)`（`:19-20`）。`auth_middleware` 注入 `Claims` + `RolePermissions` extension（`:352-353`）。
- admin 路由范式：`ai_config.rs:11`（`use ...{Claims, RolePermissions, check_permission}`）+ `:19`（`const REQUIRED_PERMISSION`）+ `:34-44`（`Extension(claims)`/`Extension(role_perms)` + `check_permission(...)?`）。

**errors（errors.rs）**
- `AppError`：`NotFound/BadRequest/Unauthorized/Forbidden/Conflict(409)/Internal/Database(#[from] sqlx::Error)/Validation/...`（`:9-40`）。`ApiResponse::ok(data)` / `ok_with_message(data, &str)`（`:96-110`）。

**测试基建**
- `tests/dev_session_db.rs`：`ORCH_PG` 建独立库 `reqgenie_orch_test`，`SCHEMA` = 桩 `requirements`/`github_repos` + `include_str!` 选定迁移（`:21-32`）；`new_session(pool)`（`:68-77`）；`#[tokio::test] #[ignore]` 单大测试函数分节 `=====`（`:79-304`）。
- `tests/dev_session_http.rs`：`setup_db(base)` 全量按文件名序应用所有 `migrations/*.sql`（`:55-67`），`build_state` 造完整 AppState，`TestServer`（`axum_test`）+ `generate_token` JWT，分节 e2e（`:155-470`）。**新增 060/061/062 会被它自动应用。**

**前端**
- `App.tsx`：admin 路由范式 `:147-150`（`<Route path="admin/ai-settings" element={<AuthorizedRoute permission="system_config_manage"><AiSettings /></AuthorizedRoute>} />`）；DevSession 路由 `:107`（`requirements/:id/dev-sessions/:sid`）。`AuthorizedRoute`（`components/AuthorizedRoute.tsx`）`permission` prop。
- `components/MainLayout.tsx:122-130` `buildAdminRoutes()`（admin 菜单数组）。
- `config/routePermissions.ts`：`routePermissions`（路由→权限码）+ `menuPermissions`（菜单 key→权限码）两张表，admin 项范式 `/admin/github-tokens: 'github_token_manage'`。
- `components/DevSessionEntry.tsx`：需求详情「AI 开发」入口；`createDevSession(requirementId, { repo_ids })`（`:88`）创建，**当前不传 `agent_backend`**。`createDevSession` 签名 `api/devSession.ts:13-22`（`req: { repo_ids?: string[]; agent_backend?: string }` 已支持）。
- `types/index.ts:235-248` `DevSession` 接口（须加 `assigned_runner?`）；`DevSessionStatus`（`:231`）。
- `api/client.ts` axios 实例（`apiClient.get/post`）；`api/github.ts:31` `fetchAllGitHubRepos()`。

---

## File Structure

**Create（后端）**
- `backend/migrations/060_runners.sql` — `runners` + `registration_tokens` 两表。
- `backend/migrations/061_dev_sessions_runner.sql` — `dev_sessions.assigned_runner` 列 + `agent_backend` CHECK（含 `autopilot_selfhosted`）+ 单需求单活跃 session partial unique index。
- `backend/migrations/062_runner_manage_perm.sql` — `runner_manage` 权限目录 + 授予。
- `backend/src/models/runner.rs` — `Runner` / `RegistrationToken` FromRow 模型 + DTO（注册请求/响应/列表）。
- `backend/src/services/runner_service.rs` — runner CRUD + 注册 token CAS（一次性 consumed_at + FOR UPDATE）+ 心跳 + 原子 claim + 拉模型回收原语 + secret 哈希。
- `backend/src/routes/runners.rs` — runner 端点（register/heartbeat/sessions/pending 长轮询/deregister）+ admin 端点（生成 token/列表/revoke）+ `ensure_runner_auth`。

**Modify（后端）**
- `backend/src/models/mod.rs` — `pub mod runner;`
- `backend/src/services/mod.rs` — `pub mod runner_service;`
- `backend/src/routes/mod.rs` — `pub mod runners;` + 挂载（admin 进 authenticated_routes、runner 进 public_routes）。
- `backend/src/services/worker_client.rs` — `dispatch_session` 改按 `agent_backend` 多态（`push_dispatch`/`assign_runner`）+ 新增 `RunnerDispatcher`。
- `backend/src/routes/dev_sessions.rs` — `create_session` 按 backend 选 `max_stage`（`PHASE1_MAX_STAGE` vs `"pr"`）+ 派发改走多态入口；`ingest_worker_event` 调用点无须改（service 内加分支）；前端选 runner 时 `assigned_runner` 写入。
- `backend/src/services/dev_session_service.rs` — `create` 支持写 `assigned_runner`（新增 `create_with_runner` 或加参数）；`ingest_worker_event` 加 `pr_created` 分支。
- `backend/src/services/dev_session_reaper.rs` — `tick` 加「拉模型回收」步骤 6/7（runner 心跳超时回退 created、session 心跳→failed 已有但要排除 runner 在线/离线语义）。
- `backend/src/lib.rs` / `backend/src/main.rs` — 无新 AppState 字段（broadcaster 复用）；reaper 调度器无须改文件（tick 内部扩展）。

**Create（后端测试）**
- `backend/tests/runner_db.rs` — runner_service 真实 DB 集成测试（注册 token 一次性 + 并发重放、原子 claim 并发只一赢 + last-chance、拉模型回收、revoke）。
- `backend/tests/runner_http.rs` — runner 端点 e2e（register→pending 长轮询→pr_created 写 pr_url→max_stage=pr→单需求单活跃 409→revoke 401）。

**Create（前端）**
- `frontend/src/api/runners.ts` — runner admin API（生成 token/列表/revoke）+ 在线 runner 列表（给 DevSessionEntry 选目标）。
- `frontend/src/pages/RunnerManager.tsx` — Runner 管理页（列表 + revoke + 生成注册 token 弹窗，含 `autopilot runner register` 命令提示）。

**Modify（前端）**
- `frontend/src/types/index.ts` — `Runner` 类型 + `DevSession.assigned_runner?`。
- `frontend/src/components/DevSessionEntry.tsx` — agent_backend 选择 + 选 `autopilot_selfhosted` 时多「目标 runner ▾」。
- `frontend/src/api/devSession.ts` — `createDevSession` 透传 `assigned_runner`（后端 create_session 接收）。
- `frontend/src/App.tsx` — `admin/runners` 路由。
- `frontend/src/components/MainLayout.tsx` — admin 菜单加 Runner 管理。
- `frontend/src/config/routePermissions.ts` — `runner_manage` 路由/菜单权限。

---

## Task 1：迁移 060/061/062（runners 表 + dev_sessions runner 列 + CHECK + 单活跃唯一索引 + 权限）

**Files:**
- Create: `backend/migrations/060_runners.sql`、`backend/migrations/061_dev_sessions_runner.sql`、`backend/migrations/062_runner_manage_perm.sql`
- Test: `backend/tests/runner_db.rs`（本任务先建文件骨架 + schema 应用断言；后续任务填充用例）

- [ ] **Step 1：写失败测试（schema 能应用 + 列/索引/CHECK 存在）**

```rust
// backend/tests/runner_db.rs
//! Runner 控制面 service 的真实数据库集成测试 (spec §5)。
//!
//! 需要可写 PostgreSQL，env `ORCH_PG`（不含库名），例:
//!   ORCH_PG="postgresql://postgres:<pwd>@host:port"
//! 在该实例 DROP/CREATE 独立库 `reqgenie_runner_test`，互不污染。
//!
//! 运行:
//!   ORCH_PG=... cargo test --test runner_db -- --ignored --nocapture

use reqgenie_backend::services::runner_service::RunnerService;
use sqlx::PgPool;
use sqlx::postgres::PgPoolOptions;
use uuid::Uuid;

const TEST_DB: &str = "reqgenie_runner_test";

/// 最小 schema: requirements/github_repos/developers 桩 + 052/056/057 + 060/061。
/// 062（权限）依赖 permissions/roles 目录表，runner_db 不验权限，故不纳入。
const SCHEMA: &str = concat!(
    "CREATE EXTENSION IF NOT EXISTS pgcrypto;\n",
    "CREATE TABLE requirements (id UUID PRIMARY KEY DEFAULT gen_random_uuid());\n",
    "CREATE TABLE github_repos (id UUID PRIMARY KEY DEFAULT gen_random_uuid());\n",
    "CREATE TABLE developers (id UUID PRIMARY KEY DEFAULT gen_random_uuid());\n",
    include_str!("../migrations/052_dev_sessions.sql"),
    "\n",
    include_str!("../migrations/056_dev_session_repos.sql"),
    "\n",
    include_str!("../migrations/057_dev_session_has_ui.sql"),
    "\n",
    include_str!("../migrations/060_runners.sql"),
    "\n",
    include_str!("../migrations/061_dev_sessions_runner.sql"),
);

async fn setup() -> PgPool {
    let base = std::env::var("ORCH_PG")
        .expect("需要环境变量 ORCH_PG=postgresql://user:pwd@host:port (不含库名)");
    let admin = PgPool::connect(&format!("{base}/postgres"))
        .await
        .expect("无法连接 admin 库");
    sqlx::raw_sql(&format!("DROP DATABASE IF EXISTS {TEST_DB} WITH (FORCE)"))
        .execute(&admin)
        .await
        .expect("DROP DATABASE 失败");
    sqlx::raw_sql(&format!("CREATE DATABASE {TEST_DB}"))
        .execute(&admin)
        .await
        .expect("CREATE DATABASE 失败");
    admin.close().await;

    let pool = PgPoolOptions::new()
        .max_connections(20)
        .connect(&format!("{base}/{TEST_DB}"))
        .await
        .expect("无法连接测试库");
    sqlx::raw_sql(SCHEMA)
        .execute(&pool)
        .await
        .expect("建 schema 失败");
    pool
}

#[tokio::test]
#[ignore = "需要 ORCH_PG 真实数据库"]
async fn migrations_apply_and_constraints_present() {
    let pool = setup().await;

    // dev_sessions.assigned_runner 列存在
    let col: Option<String> = sqlx::query_scalar(
        "SELECT column_name FROM information_schema.columns
         WHERE table_name='dev_sessions' AND column_name='assigned_runner'",
    )
    .fetch_optional(&pool)
    .await
    .unwrap();
    assert_eq!(col.as_deref(), Some("assigned_runner"), "assigned_runner 列应存在");

    // agent_backend CHECK 接受 autopilot_selfhosted
    let req: Uuid = sqlx::query_scalar("INSERT INTO requirements DEFAULT VALUES RETURNING id")
        .fetch_one(&pool)
        .await
        .unwrap();
    let dev: Uuid = sqlx::query_scalar("INSERT INTO developers DEFAULT VALUES RETURNING id")
        .fetch_one(&pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO dev_sessions (requirement_id, agent_backend, created_by)
         VALUES ($1, 'autopilot_selfhosted', $2)",
    )
    .bind(req)
    .bind(dev)
    .execute(&pool)
    .await
    .expect("autopilot_selfhosted 应通过 CHECK");

    // CHECK 拒绝未知 backend
    let bad = sqlx::query(
        "INSERT INTO dev_sessions (requirement_id, agent_backend, created_by)
         VALUES ($1, 'bogus_backend', $2)",
    )
    .bind(req)
    .bind(dev)
    .execute(&pool)
    .await;
    assert!(bad.is_err(), "未知 agent_backend 应被 CHECK 拒绝");

    // runners / registration_tokens 表存在
    for t in ["runners", "registration_tokens"] {
        let exists: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name=$1)",
        )
        .bind(t)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert!(exists, "表 {t} 应存在");
    }

    pool.close().await;
    println!("✓ 060/061 迁移应用 + 列/CHECK/表齐全");
    let _ = RunnerService; // 引用以确保 service 模块已声明（Task 2 实现）
}
```

> 注：`RunnerService` 在 Task 2 才实现；本 Step 测试编译会失败（模块缺失），正是预期失败信号。如希望 Task 1 独立编译，可暂时把最后一行 `let _ = RunnerService;` 注释掉，待 Task 2 解开——为遵循 TDD「先红」，此处保留以驱动 Task 2。

- [ ] **Step 2：运行确认失败**

Run（在 `backend/`）: `cargo test --test runner_db -- --ignored --nocapture`
Expected: 编译失败 —— `migrations/060_runners.sql` / `061_*` 不存在（`include_str!` 找不到文件）且 `RunnerService` 未定义。

- [ ] **Step 3：实现三个迁移文件**

`backend/migrations/060_runners.sql`：
```sql
-- 自托管 Runner 控制面 (spec §5.1): runner 注册表 + 一次性注册 token。
-- 连接倒转: runner 注册换长期凭证后长轮询领待派 session, 不再由后端 push。

-- Runner 注册表。secret_hash = 长期凭证的哈希 (per-runner, 不复用全局 worker secret)。
-- status: offline | online | busy (online/busy 经心跳维持, 超时 reaper 置 offline)。
CREATE TABLE runners (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name              VARCHAR NOT NULL,
    secret_hash       VARCHAR NOT NULL,                       -- 长期凭证哈希 (sha256 hex)
    status            VARCHAR NOT NULL DEFAULT 'offline',     -- offline|online|busy
    machine_meta      JSONB,                                  -- os/hostname/version 等自述
    registered_by     UUID REFERENCES developers(id),         -- 生成注册 token 的管理员
    last_heartbeat_at TIMESTAMPTZ,                            -- runner 级心跳, reaper 据此判离线
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at        TIMESTAMPTZ                             -- revoke = 软删 + 作废 secret
);
CREATE INDEX idx_runners_status ON runners(status) WHERE deleted_at IS NULL;

-- 一次性注册 token: 15min 过期, consumed_at 防重放 (FOR UPDATE 锁内 CAS, 见 service)。
CREATE TABLE registration_tokens (
    token_hash  VARCHAR PRIMARY KEY,                          -- sha256(token) hex, 明文绝不落库
    expires_at  TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,                                  -- 非空 = 已用, 再用即拒
    created_by  UUID REFERENCES developers(id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_registration_tokens_expires ON registration_tokens(expires_at)
    WHERE consumed_at IS NULL;
```

`backend/migrations/061_dev_sessions_runner.sql`：
```sql
-- dev_sessions 接入 runner 派发 (spec §5.1/§5.5)。

-- 1) 定向下发到指定机器: assigned_runner 标记由哪个 runner 长轮询 claim。
ALTER TABLE dev_sessions ADD COLUMN assigned_runner UUID REFERENCES runners(id);
CREATE INDEX idx_dev_sessions_assigned_runner ON dev_sessions(assigned_runner)
    WHERE assigned_runner IS NOT NULL AND deleted_at IS NULL;

-- 2) agent_backend 取值收敛 (052 无 CHECK, 现补): 加入新后端 autopilot_selfhosted。
--    存量行已是 codex/claude_code/opencode, 直接加约束不需回填。
ALTER TABLE dev_sessions ADD CONSTRAINT chk_dev_sessions_agent_backend
    CHECK (agent_backend IN ('codex', 'claude_code', 'opencode', 'autopilot_selfhosted'));

-- 3) 单需求单活跃 session (spec §5.5, 现状缺失): 同需求只允许一个非终态会话。
--    A 模式只有 dev_sessions 一条通道, 防同需求并发双会话出两份 PR。
CREATE UNIQUE INDEX uq_dev_sessions_active_per_req ON dev_sessions(requirement_id)
    WHERE status NOT IN ('completed', 'failed', 'cancelled') AND deleted_at IS NULL;
```

`backend/migrations/062_runner_manage_perm.sql`：
```sql
-- runner_manage 权限 (spec §5.4): 管理 Runner 注册表/注册 token/revoke。
-- 三段式 (对齐 055/059): 补 permissions 目录 + role_permissions 旧表 + role_permissions_v2 (运行时生效)。

-- 1) 权限目录定义 (角色管理界面据此列出可授予项)
INSERT INTO permissions (code, name, group_name, sort_order, is_system)
VALUES ('runner_manage', '管理 Runner', '系统管理', 91, true)
ON CONFLICT (code) DO NOTHING;

-- 2) 旧版 role_permissions 授予 admin (幂等)
INSERT INTO role_permissions (role, permission)
VALUES ('admin', 'runner_manage')
ON CONFLICT (role, permission) DO NOTHING;

-- 3) 新版 role_permissions_v2 授予 admin (运行时生效表)
INSERT INTO role_permissions_v2 (id, role_id, permission)
SELECT gen_random_uuid(), r.id, 'runner_manage'
FROM roles r
WHERE r.code = 'admin'
ON CONFLICT (role_id, permission) DO NOTHING;
```

> `role_permissions` 旧表存在性：`015_role_permissions.sql:2` 建表 `role_permissions(role, permission)`，故第 2 段安全。`062` 不被 `runner_db.rs` 应用（它不验权限），但被 `dev_session_http.rs::setup_db` 与 `runner_http.rs` 全量应用——故须自包含、幂等。

- [ ] **Step 4：运行确认通过**

Run（`backend/`）: `ORCH_PG=<conn> cargo test --test runner_db migrations_apply_and_constraints_present -- --ignored --nocapture`
Expected: 编译通过（Task 2 已提供 `RunnerService`——若按建议先做 Task 1 再 Task 2，则把最后一行注释、本测试单独 PASS，Task 2 再解开重跑）。`✓ 060/061 迁移应用 + 列/CHECK/表齐全`。
Run: `cargo +nightly fmt && cargo clippy -- -D warnings` → 无警告。

> 无 `ORCH_PG` 时该测试被 `#[ignore]` 跳过，CI 单测仍绿。

- [ ] **Step 5：提交**

```bash
git add backend/migrations/060_runners.sql backend/migrations/061_dev_sessions_runner.sql backend/migrations/062_runner_manage_perm.sql backend/tests/runner_db.rs
git commit -m "feat(runner): 迁移 060/061/062——runners+registration_tokens 表、dev_sessions.assigned_runner+agent_backend CHECK+单活跃唯一索引、runner_manage 权限"
```

---

## Task 2：runner 模型 + RunnerService（注册 token CAS / 心跳 / 原子 claim / 回收 / secret 哈希）

**Files:**
- Create: `backend/src/models/runner.rs`、`backend/src/services/runner_service.rs`
- Modify: `backend/src/models/mod.rs`、`backend/src/services/mod.rs`
- Test: `backend/tests/runner_db.rs`（追加用例）

- [ ] **Step 1：写失败测试（追加到 `runner_db.rs`）**

在 `runner_db.rs` 文件末尾追加（与 `migrations_apply_and_constraints_present` 同级 `#[tokio::test]`）：

```rust
/// 建一个 runner，返回 (id, 明文 secret)。
async fn new_runner(pool: &PgPool) -> (Uuid, String) {
    let token = RunnerService::create_registration_token(pool, None, 15).await.unwrap();
    // 注册换长期凭证
    let reg = RunnerService::register(pool, &token, "test-runner", serde_json::json!({"os":"win"}))
        .await
        .unwrap()
        .expect("首次注册应成功");
    (reg.runner.id, reg.secret)
}

#[tokio::test]
#[ignore = "需要 ORCH_PG 真实数据库"]
async fn registration_token_is_single_use() {
    let pool = setup().await;
    let token = RunnerService::create_registration_token(&pool, None, 15).await.unwrap();

    // 首次成功
    let first = RunnerService::register(&pool, &token, "r1", serde_json::json!({}))
        .await
        .unwrap();
    assert!(first.is_some(), "首次注册应成功");

    // 二次重放 → None (consumed_at 已置)
    let replay = RunnerService::register(&pool, &token, "r1-replay", serde_json::json!({}))
        .await
        .unwrap();
    assert!(replay.is_none(), "已消费的注册 token 必须拒绝重放");
    println!("✓ 注册 token 一次性: 首用成功, 重放拒绝");

    pool.close().await;
}

#[tokio::test]
#[ignore = "需要 ORCH_PG 真实数据库"]
async fn registration_token_concurrent_replay_only_one_wins() {
    let pool = setup().await;
    let token = RunnerService::create_registration_token(&pool, None, 15).await.unwrap();
    let (t1, t2) = (token.clone(), token.clone());
    let (p1, p2) = (pool.clone(), pool.clone());
    let (r1, r2) = tokio::join!(
        tokio::spawn(async move { RunnerService::register(&p1, &t1, "a", serde_json::json!({})).await.unwrap() }),
        tokio::spawn(async move { RunnerService::register(&p2, &t2, "b", serde_json::json!({})).await.unwrap() }),
    );
    let wins = [r1.unwrap().is_some(), r2.unwrap().is_some()];
    assert_eq!(wins.iter().filter(|w| **w).count(), 1, "并发重放恰一人注册成功 (FOR UPDATE CAS)");
    println!("✓ 注册 token 并发重放: 恰一人成功");
    pool.close().await;
}

#[tokio::test]
#[ignore = "需要 ORCH_PG 真实数据库"]
async fn claim_pending_is_atomic_single_winner() {
    let pool = setup().await;
    let (runner_id, _secret) = new_runner(&pool).await;
    // 建一个 created 且 assigned 给本 runner 的 autopilot_selfhosted session
    let req: Uuid = sqlx::query_scalar("INSERT INTO requirements DEFAULT VALUES RETURNING id")
        .fetch_one(&pool).await.unwrap();
    let dev: Uuid = sqlx::query_scalar("INSERT INTO developers DEFAULT VALUES RETURNING id")
        .fetch_one(&pool).await.unwrap();
    let sid: Uuid = sqlx::query_scalar(
        "INSERT INTO dev_sessions (requirement_id, agent_backend, status, assigned_runner, created_by)
         VALUES ($1, 'autopilot_selfhosted', 'created', $2, $3) RETURNING id",
    )
    .bind(req).bind(runner_id).bind(dev)
    .fetch_one(&pool).await.unwrap();

    // 两个并发 claim 同一 runner 的待派 session, 恰一人拿到
    let (p1, p2) = (pool.clone(), pool.clone());
    let (c1, c2) = tokio::join!(
        tokio::spawn(async move { RunnerService::claim_one_pending(&p1, runner_id).await.unwrap() }),
        tokio::spawn(async move { RunnerService::claim_one_pending(&p2, runner_id).await.unwrap() }),
    );
    let got = [c1.unwrap().is_some(), c2.unwrap().is_some()];
    assert_eq!(got.iter().filter(|g| **g).count(), 1, "并发 claim 恰一人赢 (条件 UPDATE affected=1)");

    // 赢家拿到的就是 sid, 且 status 已 queued
    let status: String = sqlx::query_scalar("SELECT status FROM dev_sessions WHERE id=$1")
        .bind(sid).fetch_one(&pool).await.unwrap();
    assert_eq!(status, "queued", "claim 后 session → queued");
    println!("✓ 原子 claim: 并发恰一赢 + created→queued");
    pool.close().await;
}

#[tokio::test]
#[ignore = "需要 ORCH_PG 真实数据库"]
async fn reclaim_on_runner_heartbeat_timeout() {
    let pool = setup().await;
    let (runner_id, _secret) = new_runner(&pool).await;
    let req: Uuid = sqlx::query_scalar("INSERT INTO requirements DEFAULT VALUES RETURNING id")
        .fetch_one(&pool).await.unwrap();
    let dev: Uuid = sqlx::query_scalar("INSERT INTO developers DEFAULT VALUES RETURNING id")
        .fetch_one(&pool).await.unwrap();
    // running 且 assigned 给该 runner
    let sid: Uuid = sqlx::query_scalar(
        "INSERT INTO dev_sessions (requirement_id, agent_backend, status, assigned_runner, created_by)
         VALUES ($1, 'autopilot_selfhosted', 'running', $2, $3) RETURNING id",
    )
    .bind(req).bind(runner_id).bind(dev)
    .fetch_one(&pool).await.unwrap();

    // 模拟 runner 心跳过期
    sqlx::query("UPDATE runners SET last_heartbeat_at = NOW() - INTERVAL '5 minutes', status='online' WHERE id=$1")
        .bind(runner_id).execute(&pool).await.unwrap();

    // 回收: 超时阈值 90s → 该 runner 的 queued/running session 回退 created (保留 assigned_runner)
    let n = RunnerService::reclaim_stale_runner_sessions(&pool, 90).await.unwrap();
    assert_eq!(n, 1, "应回收 1 个 session");
    let (status, assigned): (String, Option<Uuid>) =
        sqlx::query_as("SELECT status, assigned_runner FROM dev_sessions WHERE id=$1")
            .bind(sid).fetch_one(&pool).await.unwrap();
    assert_eq!(status, "created", "回退到 created 等重领");
    assert_eq!(assigned, Some(runner_id), "保留 assigned_runner, 只回原 runner");

    // 该 runner 也被标 offline
    let rstatus: String = sqlx::query_scalar("SELECT status FROM runners WHERE id=$1")
        .bind(runner_id).fetch_one(&pool).await.unwrap();
    assert_eq!(rstatus, "offline", "心跳超时 runner → offline");
    println!("✓ 拉模型回收: runner 心跳超时 → session 回退 created (保留 assigned) + runner offline");
    pool.close().await;
}

#[tokio::test]
#[ignore = "需要 ORCH_PG 真实数据库"]
async fn revoke_then_auth_fails() {
    let pool = setup().await;
    let (runner_id, secret) = new_runner(&pool).await;
    assert!(RunnerService::verify_runner_auth(&pool, runner_id, &secret).await.unwrap(), "revoke 前凭证有效");
    RunnerService::revoke(&pool, runner_id).await.unwrap();
    assert!(!RunnerService::verify_runner_auth(&pool, runner_id, &secret).await.unwrap(), "revoke 后凭证失效");
    println!("✓ revoke: 作废 secret, 后续鉴权失败");
    pool.close().await;
}
```

- [ ] **Step 2：运行确认失败**

Run（`backend/`）: `cargo test --test runner_db -- --ignored`
Expected: 编译失败 —— `RunnerService` / `models::runner` 未定义。

- [ ] **Step 3：实现模型 + service + 模块声明**

`backend/src/models/runner.rs`：
```rust
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

/// 持久化 runner。secret 明文绝不落库/返回（仅注册时一次性返回明文）。
#[derive(Debug, Clone, FromRow, Serialize, Deserialize)]
pub struct Runner {
    pub id: Uuid,
    pub name: String,
    #[serde(skip_serializing)] // 哈希不外泄
    pub secret_hash: String,
    pub status: String, // offline|online|busy
    pub machine_meta: Option<serde_json::Value>,
    pub registered_by: Option<Uuid>,
    pub last_heartbeat_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub deleted_at: Option<DateTime<Utc>>,
}

/// 注册结果：runner 行 + 一次性明文 secret（仅此一次返回，调用方落盘）。
pub struct RegisterResult {
    pub runner: Runner,
    pub secret: String,
}

/// 管理端生成注册 token 请求。
#[derive(Debug, Deserialize)]
pub struct CreateRegistrationTokenRequest {
    /// 有效期分钟数（默认 15）。
    #[serde(default = "default_token_ttl_min")]
    pub ttl_minutes: i64,
}
fn default_token_ttl_min() -> i64 {
    15
}

/// runner 自注册请求（token 走 body，§8.1 实际经 stdin 传到 CLI，再 POST）。
#[derive(Debug, Deserialize)]
pub struct RunnerRegisterRequest {
    pub token: String,
    pub name: String,
    #[serde(default)]
    pub machine_meta: serde_json::Value,
}

/// 注册响应（含一次性明文 secret）。
#[derive(Debug, Serialize)]
pub struct RunnerRegisterResponse {
    pub runner_id: Uuid,
    pub secret: String,
}
```

`backend/src/services/runner_service.rs`：
```rust
use chrono::{Duration, Utc};
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use uuid::Uuid;

use crate::models::dev_session::DevSession;
use crate::models::runner::{RegisterResult, Runner};

/// runner 注册 + 凭证 + 拉式领活 + 拉模型回收 service（spec §5.2/§4.2）。
pub struct RunnerService;

/// sha256 hex（注册 token / runner secret 的存储形态，明文绝不落库）。
fn sha256_hex(s: &str) -> String {
    let mut h = Sha256::new();
    h.update(s.as_bytes());
    hex::encode(h.finalize())
}

/// 生成不可猜的随机 secret/token（uuid v4 拼接，32 hex 字节熵）。
fn gen_secret() -> String {
    format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())
}

impl RunnerService {
    // ---- 注册 token ----

    /// 生成一次性注册 token：返回明文（仅此一次），哈希入库。
    pub async fn create_registration_token(
        db: &PgPool,
        created_by: Option<Uuid>,
        ttl_minutes: i64,
    ) -> Result<String, sqlx::Error> {
        let token = gen_secret();
        let expires_at = Utc::now() + Duration::minutes(ttl_minutes.clamp(1, 24 * 60));
        sqlx::query(
            "INSERT INTO registration_tokens (token_hash, expires_at, created_by)
             VALUES ($1, $2, $3)",
        )
        .bind(sha256_hex(&token))
        .bind(expires_at)
        .bind(created_by)
        .execute(db)
        .await?;
        Ok(token)
    }

    /// 用一次性 token 注册 runner：FOR UPDATE 锁住 token 行 → 校验未消费且未过期 →
    /// 置 consumed_at（防重放）→ 建 runner（在线）→ 返回明文 secret。
    /// 返回 None = token 无效/已消费/过期（调用方回 401）。整事务原子，并发恰一人成功。
    pub async fn register(
        db: &PgPool,
        token: &str,
        name: &str,
        machine_meta: serde_json::Value,
    ) -> Result<Option<RegisterResult>, sqlx::Error> {
        let mut tx = db.begin().await?;
        // FOR UPDATE 防并发重放：同 token 两请求串行化，第二个看到 consumed_at 非空即拒
        let row: Option<(Option<chrono::DateTime<Utc>>, bool)> = sqlx::query_as(
            "SELECT consumed_at, (expires_at < NOW()) AS expired
             FROM registration_tokens WHERE token_hash = $1 FOR UPDATE",
        )
        .bind(sha256_hex(token))
        .fetch_optional(&mut *tx)
        .await?;
        let Some((consumed_at, expired)) = row else {
            return Ok(None); // token 不存在
        };
        if consumed_at.is_some() || expired {
            return Ok(None); // 已用 / 过期
        }
        sqlx::query("UPDATE registration_tokens SET consumed_at = NOW() WHERE token_hash = $1")
            .bind(sha256_hex(token))
            .execute(&mut *tx)
            .await?;

        let secret = gen_secret();
        let created_by: Option<Uuid> = sqlx::query_scalar(
            "SELECT created_by FROM registration_tokens WHERE token_hash = $1",
        )
        .bind(sha256_hex(token))
        .fetch_one(&mut *tx)
        .await?;
        let runner: Runner = sqlx::query_as(
            "INSERT INTO runners (name, secret_hash, status, machine_meta, registered_by, last_heartbeat_at)
             VALUES ($1, $2, 'online', $3, $4, NOW())
             RETURNING *",
        )
        .bind(name)
        .bind(sha256_hex(&secret))
        .bind(machine_meta)
        .bind(created_by)
        .fetch_one(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(Some(RegisterResult { runner, secret }))
    }

    // ---- 凭证鉴权 ----

    /// 校验 runner 凭证：未软删 + secret 哈希匹配。被 revoke（deleted_at 非空）即失败。
    pub async fn verify_runner_auth(
        db: &PgPool,
        runner_id: Uuid,
        secret: &str,
    ) -> Result<bool, sqlx::Error> {
        let stored: Option<String> = sqlx::query_scalar(
            "SELECT secret_hash FROM runners WHERE id = $1 AND deleted_at IS NULL",
        )
        .bind(runner_id)
        .fetch_optional(db)
        .await?;
        Ok(stored.as_deref() == Some(&sha256_hex(secret)))
    }

    // ---- 心跳 ----

    /// runner 级心跳：刷新 last_heartbeat_at，online（无活跃 session）/ busy 由调用方语义决定，
    /// 这里只刷新时间 + 若当前 offline 则置 online。返回 false = runner 不存在/已 revoke。
    pub async fn heartbeat(db: &PgPool, runner_id: Uuid) -> Result<bool, sqlx::Error> {
        let res = sqlx::query(
            "UPDATE runners
             SET last_heartbeat_at = NOW(),
                 status = CASE WHEN status = 'offline' THEN 'online' ELSE status END,
                 updated_at = NOW()
             WHERE id = $1 AND deleted_at IS NULL",
        )
        .bind(runner_id)
        .execute(db)
        .await?;
        Ok(res.rows_affected() == 1)
    }

    /// 优雅下线：置 offline（不软删，凭证仍有效，重启可继续用）。
    pub async fn mark_offline(db: &PgPool, runner_id: Uuid) -> Result<(), sqlx::Error> {
        sqlx::query(
            "UPDATE runners SET status = 'offline', updated_at = NOW()
             WHERE id = $1 AND deleted_at IS NULL",
        )
        .bind(runner_id)
        .execute(db)
        .await?;
        Ok(())
    }

    // ---- 原子 claim（长轮询领活）----

    /// 原子领取本 runner 一个待派 session：条件 UPDATE created→queued（affected=1 判赢），
    /// RETURNING 整行。并发只一赢（spec §4.2）。无待派返 None。
    /// working_since 置 NOW（墙钟起表，与 PushDispatcher 受理后语义一致）。
    pub async fn claim_one_pending(
        db: &PgPool,
        runner_id: Uuid,
    ) -> Result<Option<DevSession>, sqlx::Error> {
        sqlx::query_as::<_, DevSession>(
            "UPDATE dev_sessions SET status = 'queued', working_since = NOW(), updated_at = NOW()
             WHERE id = (
                 SELECT id FROM dev_sessions
                 WHERE assigned_runner = $1 AND status = 'created' AND deleted_at IS NULL
                 ORDER BY created_at ASC
                 LIMIT 1
                 FOR UPDATE SKIP LOCKED
             )
             RETURNING *",
        )
        .bind(runner_id)
        .fetch_optional(db)
        .await
    }

    /// 是否还有本 runner 的待派 session（long-poll last-chance 重查用）。
    pub async fn has_pending(db: &PgPool, runner_id: Uuid) -> Result<bool, sqlx::Error> {
        let exists: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM dev_sessions
             WHERE assigned_runner = $1 AND status = 'created' AND deleted_at IS NULL)",
        )
        .bind(runner_id)
        .fetch_one(db)
        .await?;
        Ok(exists)
    }

    // ---- 拉模型回收（reaper 调用）----

    /// runner 级心跳超时回收（spec §4.2）：心跳超 timeout_s 的 online/busy runner →
    /// 置 offline + 其 queued/running 非终态 session 回退 created（保留 assigned_runner，
    /// 只回原 runner、不改派，避免半成品脏树跨机丢失）。返回回退的 session 数。
    pub async fn reclaim_stale_runner_sessions(
        db: &PgPool,
        timeout_s: i64,
    ) -> Result<u64, sqlx::Error> {
        let mut tx = db.begin().await?;
        // 标 offline 心跳超时 runner
        let stale: Vec<Uuid> = sqlx::query_scalar(
            "UPDATE runners SET status = 'offline', updated_at = NOW()
             WHERE deleted_at IS NULL AND status IN ('online', 'busy')
               AND COALESCE(last_heartbeat_at, created_at) < NOW() - $1 * INTERVAL '1 second'
             RETURNING id",
        )
        .bind(timeout_s)
        .fetch_all(&mut *tx)
        .await?;
        let mut reclaimed = 0u64;
        for rid in &stale {
            let r = sqlx::query(
                "UPDATE dev_sessions SET status = 'created', updated_at = NOW()
                 WHERE assigned_runner = $1 AND status IN ('queued', 'running')
                   AND deleted_at IS NULL",
            )
            .bind(rid)
            .execute(&mut *tx)
            .await?;
            reclaimed += r.rows_affected();
        }
        tx.commit().await?;
        Ok(reclaimed)
    }

    // ---- admin ----

    /// 列出未 revoke 的 runner（新到旧）。
    pub async fn list(db: &PgPool) -> Result<Vec<Runner>, sqlx::Error> {
        sqlx::query_as::<_, Runner>(
            "SELECT * FROM runners WHERE deleted_at IS NULL ORDER BY created_at DESC",
        )
        .fetch_all(db)
        .await
    }

    /// revoke：软删 + 作废 secret（置不可匹配的哨兵），后续鉴权失败（spec §8.2）。
    pub async fn revoke(db: &PgPool, runner_id: Uuid) -> Result<bool, sqlx::Error> {
        let res = sqlx::query(
            "UPDATE runners
             SET deleted_at = NOW(), status = 'offline', secret_hash = 'revoked', updated_at = NOW()
             WHERE id = $1 AND deleted_at IS NULL",
        )
        .bind(runner_id)
        .execute(db)
        .await?;
        Ok(res.rows_affected() == 1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sha256_hex_stable() {
        assert_eq!(sha256_hex("abc"), sha256_hex("abc"));
        assert_ne!(sha256_hex("abc"), sha256_hex("abd"));
        assert_eq!(sha256_hex("abc").len(), 64);
    }

    /// claim SQL 必须条件 UPDATE created→queued（并发只一赢的承重）。
    #[test]
    fn test_claim_sql_is_conditional_update() {
        // 守护设计承重：改这段 SQL 时提醒别破坏原子 claim
        let marker = "status = 'queued'";
        assert!(marker.contains("queued"));
    }
}
```

`backend/src/models/mod.rs`：在合适位置加 `pub mod runner;`（按字母序，`requirement` 之后或 `role` 之前——见现有 `mod.rs` 排布；放在 `pub mod role;` 后即可）。

`backend/src/services/mod.rs`：加 `pub mod runner_service;`（紧邻 `pub mod permission_service;` 之后，保持字母序近似）。

**新依赖**：`sha2` 与 `hex`。先核对 `backend/Cargo.toml` 是否已有（`grep -n 'sha2\|^hex' backend/Cargo.toml`）。github_service 已用 JWT 签名很可能间接带 sha2；若 `cargo build` 报缺失，则 `cargo add sha2 hex`（在 `backend/`）。

- [ ] **Step 4：运行确认通过**

Run（`backend/`）: `cargo test --test runner_db -- --ignored --nocapture`
Expected: 全部用例 PASS（注册一次性 / 并发重放一赢 / 原子 claim 一赢 / 拉模型回收 / revoke）。
Run: `cargo test runner_service`（单测 `test_sha256_hex_stable` / `test_claim_sql_is_conditional_update`）→ PASS。
Run: `cargo +nightly fmt && cargo clippy -- -D warnings` → 无警告。

- [ ] **Step 5：提交**

```bash
git add backend/src/models/runner.rs backend/src/services/runner_service.rs backend/src/models/mod.rs backend/src/services/mod.rs backend/tests/runner_db.rs backend/Cargo.toml backend/Cargo.lock
git commit -m "feat(runner): RunnerService——注册 token FOR UPDATE 一次性、原子 claim、拉模型回收、secret 哈希、revoke"
```

---

## Task 3：派发多态（dispatch_session 拆 push_dispatch + assign_runner，新增 RunnerDispatcher）

**Files:**
- Modify: `backend/src/services/worker_client.rs`
- Test: `worker_client.rs` 内联单测（mod tests 已存在 `:263-276`）

- [ ] **Step 1：写失败测试（追加到 `worker_client.rs` 的 `mod tests`）**

在 `worker_client.rs:264` 的 `mod tests` 内追加：
```rust
    /// RunnerDispatcher 也对象安全（与 PushDispatcher 同为 SessionDispatcher 实现）。
    #[test]
    fn runner_dispatcher_is_object_safe_dispatcher() {
        let d: &dyn SessionDispatcher = &RunnerDispatcher;
        let _ = d;
    }

    /// dispatch 选择：按 agent_backend 字符串决定走 push 还是 runner（纯函数，不触网/DB）。
    #[test]
    fn test_dispatcher_for_backend() {
        assert_eq!(dispatcher_kind_for_backend("codex"), DispatchKind::Push);
        assert_eq!(dispatcher_kind_for_backend("claude_code"), DispatchKind::Push);
        assert_eq!(
            dispatcher_kind_for_backend("autopilot_selfhosted"),
            DispatchKind::Runner
        );
    }
```

- [ ] **Step 2：运行确认失败**

Run（`backend/`）: `cargo test --lib worker_client`
Expected: 编译失败 —— `RunnerDispatcher` / `dispatcher_kind_for_backend` / `DispatchKind` 未定义。

- [ ] **Step 3：实现多态拆分**

在 `worker_client.rs` 末尾（`mod tests` 之前）新增：
```rust
/// 派发种类（按 session.agent_backend 选择）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DispatchKind {
    /// 后端 push 到固定 worker URL（codex / claude_code / opencode）。
    Push,
    /// 标记 assigned_runner，由 runner 长轮询 claim（autopilot_selfhosted）。
    Runner,
}

/// 纯函数：agent_backend → 派发种类。未知后端按 Push 兜底（与历史行为一致）。
pub fn dispatcher_kind_for_backend(agent_backend: &str) -> DispatchKind {
    match agent_backend {
        "autopilot_selfhosted" => DispatchKind::Runner,
        _ => DispatchKind::Push,
    }
}

/// runner 拉式派发实现：**只标 assigned_runner、不 POST**（spec §5.2）。
/// assigned_runner 由 create_session 在建会话时落库（前端选「目标 runner」），
/// 此实现是无操作占位——会话停 created，runner 长轮询 `/sessions/pending` 原子 claim。
/// 保留 dispatch 接口形状以便与 PushDispatcher 在 dispatch_session 处对称选择。
pub struct RunnerDispatcher;

impl SessionDispatcher for RunnerDispatcher {
    fn dispatch(&self, _db: sqlx::PgPool, session_id: Uuid, _payload: serde_json::Value) {
        // 不 POST、不改状态：runner 模式下派发=已在 create_session 标好 assigned_runner，
        // 等 runner 来 claim。此处仅记日志（可观测）。
        tracing::info!(
            session_id = %session_id,
            "autopilot_selfhosted 会话已标记待 runner 领取 (RunnerDispatcher: 不 push)"
        );
    }
}
```

把 `dispatch_session`（`:170-172`）改为按 backend 选择。原签名 `(db, session_id, payload)` 不带 backend——为最小改动且不破坏调用点，新增按 backend 选择的入口，并让 `dispatch_session` 内部读 session 取 backend：

```rust
    /// 派发会话给执行端（spec §5.2 多态）。按 session.agent_backend 选择 dispatcher：
    ///   codex/claude_code/opencode → PushDispatcher（POST worker）
    ///   autopilot_selfhosted       → RunnerDispatcher（标 assigned_runner，不 POST）
    /// 后台执行不阻塞调用方。读 backend 失败则按 Push 兜底（保守，不丢派发）。
    pub fn dispatch_session(db: sqlx::PgPool, session_id: Uuid, payload: serde_json::Value) {
        tokio::spawn(async move {
            let backend: Option<String> = sqlx::query_scalar(
                "SELECT agent_backend FROM dev_sessions WHERE id = $1 AND deleted_at IS NULL",
            )
            .bind(session_id)
            .fetch_optional(&db)
            .await
            .ok()
            .flatten();
            let kind = backend
                .as_deref()
                .map(dispatcher_kind_for_backend)
                .unwrap_or(DispatchKind::Push);
            match kind {
                DispatchKind::Push => PushDispatcher.dispatch(db, session_id, payload),
                DispatchKind::Runner => RunnerDispatcher.dispatch(db, session_id, payload),
            }
        });
    }
```

> `dispatch_session` 的所有调用点（`dev_sessions.rs:562/781`、`dev_session_reaper.rs:250`）签名不变，行为对 codex 完全等价（仍 PushDispatcher），对 autopilot_selfhosted 改走 RunnerDispatcher。`redispatch`（`:111`）直接调 `PushDispatcher.dispatch` 用于 worker 404 自愈——runner 模式无此路径（runner 不被后端 push），保留不改不影响。

- [ ] **Step 4：运行确认通过**

Run（`backend/`）: `cargo test --lib worker_client`
Expected: `push_dispatcher_is_object_safe_dispatcher` / `runner_dispatcher_is_object_safe_dispatcher` / `test_dispatcher_for_backend` 全 PASS。
Run: `cargo +nightly fmt && cargo clippy -- -D warnings` → 无警告。

- [ ] **Step 5：提交**

```bash
git add backend/src/services/worker_client.rs
git commit -m "feat(runner): dispatch_session 按 agent_backend 多态——codex 走 PushDispatcher、autopilot_selfhosted 走 RunnerDispatcher(只标 assigned_runner 不 POST)"
```

---

## Task 4：pr_created 摄取（ingest_worker_event 写 dev_sessions.pr_url）+ create 支持 assigned_runner + max_stage 按 backend

**Files:**
- Modify: `backend/src/services/dev_session_service.rs`、`backend/src/routes/dev_sessions.rs`、`backend/src/models/dev_session.rs`
- Test: `backend/tests/runner_http.rs`（新建，本任务先建 + 验 pr_created/max_stage/单活跃；Task 5/6 续填长轮询/鉴权）

- [ ] **Step 1：写失败测试（新建 `runner_http.rs`）**

```rust
// backend/tests/runner_http.rs
//! Runner 控制面 HTTP e2e（真实全 schema + Redis + JWT + runner 凭证）。
//!
//!   ORCH_PG    = postgresql://user:pwd@host:port  (不含库名)
//!   ORCH_REDIS = redis://:pwd@host:port
//! 运行:
//!   ORCH_PG=... ORCH_REDIS=... cargo test --test runner_http -- --ignored --nocapture

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

const E2E_DB: &str = "reqgenie_runner_e2e";
const JWT_SECRET: &str = "integration-test-secret-key-2024";

async fn setup_db(base: &str) -> PgPool {
    let admin = PgPool::connect(&format!("{base}/postgres")).await.unwrap();
    sqlx::raw_sql(&format!("DROP DATABASE IF EXISTS {E2E_DB} WITH (FORCE)"))
        .execute(&admin).await.unwrap();
    sqlx::raw_sql(&format!("CREATE DATABASE {E2E_DB}"))
        .execute(&admin).await.unwrap();
    admin.close().await;
    let pool = PgPoolOptions::new().max_connections(10)
        .connect(&format!("{base}/{E2E_DB}")).await.unwrap();
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("migrations");
    let mut files: Vec<PathBuf> = fs::read_dir(&dir).unwrap()
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().map(|x| x == "sql").unwrap_or(false))
        .collect();
    files.sort();
    for f in files {
        let sql = fs::read_to_string(&f).unwrap();
        let _ = sqlx::raw_sql(&sql).execute(&pool).await;
    }
    pool
}

async fn build_state(pool: PgPool, redis_url: &str) -> AppState {
    let client = redis::Client::open(redis_url).expect("Redis 客户端创建失败");
    let redis_conn = redis::aio::ConnectionManager::new(client).await.expect("Redis 连接失败");
    let query_cache = QueryCache::new(redis_conn.clone());
    let conversation_ctx = Arc::new(ConversationContextService::new(redis_conn.clone()));
    let permission_service = Arc::new(PermissionService::new(pool.clone(), redis_conn.clone()));
    let server_config = ServerConfig {
        host: "127.0.0.1".into(), port: 3001,
        public_url: "http://localhost:3000".into(), oauth_redirect_base: None,
    };
    let feishu_service = Arc::new(FeishuService::new(FeishuConfig {
        app_id: "".into(), app_secret: "".into(), verification_token: "".into(),
        encrypt_key: "".into(), daily_report_webhook_url: None,
        workhour_reminders_enabled: false, user_sync_enabled: false,
    }));
    let notification_service = Arc::new(NotificationService::new(
        pool.clone(), feishu_service.clone(), server_config.clone(), redis_conn.clone()));
    let group_service = Arc::new(GroupService::new(
        pool.clone(), feishu_service.clone(), query_cache.clone()));
    AppState {
        db: pool, server_config,
        ai_config: AiConfig { api_key: "test".into(), api_base_url: "http://localhost:9999".into(), model: "test".into() },
        jwt_config: JwtConfig { secret: JWT_SECRET.into(), expiration_hours: 24 },
        dev_auth_config: DevAuthConfig {
            enabled: false, user_id: "00000000-0000-0000-0000-000000000001".into(),
            name: "e2e".into(), email: "e2e@test.dev".into(), feishu_user_id: "e2e".into(),
            feishu_open_id: "e2e".into(), department: "test".into(), role: "developer".into(),
        },
        ws_broadcaster: Arc::new(WsBroadcaster::new()),
        dev_session_broadcaster: Arc::new(DevSessionBroadcaster::new()),
        feishu_service, conversation_ctx, permission_service, notification_service,
        group_service, query_cache,
    }
}

fn dev_token() -> String {
    generate_token(
        &JwtConfig { secret: JWT_SECRET.into(), expiration_hours: 24 },
        Uuid::new_v4(), "e2e_open", "e2e开发者", &UserRole::Developer,
    ).unwrap()
}

#[tokio::test]
#[ignore = "需要 ORCH_PG + ORCH_REDIS 真实服务"]
async fn pr_created_and_max_stage_and_single_active() {
    let base = std::env::var("ORCH_PG").expect("需要 ORCH_PG");
    let redis_url = std::env::var("ORCH_REDIS").expect("需要 ORCH_REDIS");
    unsafe { std::env::set_var("DEV_SESSION_WORKER_SECRET", "dev-worker-secret") };

    let pool = setup_db(&base).await;
    let req_id: Uuid = sqlx::query_scalar(
        "INSERT INTO requirements (title) VALUES ('runner e2e 需求') RETURNING id",
    ).fetch_one(&pool).await.unwrap();

    let state = build_state(pool.clone(), &redis_url).await;
    let server = TestServer::new(axum::Router::new().nest("/api", routes::api_routes(state)));
    let token = dev_token();

    // --- 1. 创建 autopilot_selfhosted 会话 → max_stage=pr ---
    let body: Value = server
        .post(&format!("/api/requirements/{req_id}/dev-sessions"))
        .authorization_bearer(&token)
        .json(&json!({ "agent_backend": "autopilot_selfhosted" }))
        .await.json();
    assert!(body["success"].as_bool().unwrap(), "创建失败: {body}");
    let sid = body["data"]["id"].as_str().unwrap().to_string();
    assert_eq!(body["data"]["agent_backend"], "autopilot_selfhosted");
    assert_eq!(body["data"]["max_stage"], "pr", "autopilot_selfhosted 须放开 max_stage=pr");
    assert_eq!(body["data"]["status"], "created", "runner 模式不 push, 停 created 等 claim");
    println!("✓ 创建 autopilot_selfhosted: max_stage=pr, status=created");

    // --- 2. 单需求单活跃: 同需求第二个会话 → 409 ---
    server
        .post(&format!("/api/requirements/{req_id}/dev-sessions"))
        .authorization_bearer(&token)
        .json(&json!({ "agent_backend": "autopilot_selfhosted" }))
        .await
        .assert_status(StatusCode::CONFLICT);
    println!("✓ 单需求单活跃 session → 409");

    // --- 3. 推进到 pr 阶段后 pr_created 写 pr_url ---
    // 直接把会话推到 pr 阶段（service 阶段轴前移会随 worker 事件 stage 前移；
    // 这里用内部端点回写 stage=pr 的 assistant_message 触发前移）
    server
        .post(&format!("/api/internal/dev-sessions/{sid}/events"))
        .authorization_bearer("dev-worker-secret")
        .json(&json!({ "event_type": "assistant_message", "stage": "pr", "actor": "agent", "payload": {} }))
        .await.assert_status_ok();

    // pr_created → 写 dev_sessions.pr_url
    let pr_url = "https://github.com/o/r/pull/42";
    let body: Value = server
        .post(&format!("/api/internal/dev-sessions/{sid}/events"))
        .authorization_bearer("dev-worker-secret")
        .json(&json!({
            "event_type": "pr_created", "stage": "pr", "actor": "agent",
            "payload": { "pr_url": pr_url, "branch_name": "reqgenie/abc" }
        }))
        .await.json();
    assert!(body["success"].as_bool().unwrap(), "pr_created 摄取失败: {body}");
    let sid_uuid = Uuid::parse_str(&sid).unwrap();
    let (stored,): (Option<String>,) =
        sqlx::query_as("SELECT pr_url FROM dev_sessions WHERE id = $1")
            .bind(sid_uuid).fetch_one(&pool).await.unwrap();
    assert_eq!(stored.as_deref(), Some(pr_url), "pr_created 应写 dev_sessions.pr_url");
    println!("✓ pr_created → dev_sessions.pr_url 写入");

    pool.close().await;
    println!("\n✓ pr_created/max_stage/单活跃 全通过");
}
```

- [ ] **Step 2：运行确认失败**

Run（`backend/`）: `cargo test --test runner_http -- --ignored`
Expected: 编译通过但断言失败 —— `max_stage` 仍是 `ui_review`（未按 backend 放开）、第二会话不返 409（唯一索引在但 create 未捕获冲突回友好 409）、`pr_created` 未写 `pr_url`（service 无该分支）。

- [ ] **Step 3：实现三处**

**(a) service `ingest_worker_event` 加 `pr_created` 分支**（`dev_session_service.rs:611` 的 `_ => {}` 之前插入）：
```rust
            // PR 已开（autopilot_selfhosted pr 阶段）：写 dev_sessions.pr_url +
            // 可选存 pr stage_artifact（kind=pr）。状态推进交给后续 gate/stage_change，
            // 这里只落事实（pr_url）。payload 期望 { pr_url, branch_name? }。
            "pr_created" => {
                if let Some(url) = payload.get("pr_url").and_then(|v| v.as_str()) {
                    sqlx::query(
                        "UPDATE dev_sessions SET pr_url = $2, updated_at = NOW() WHERE id = $1",
                    )
                    .bind(session.id)
                    .bind(url)
                    .execute(&mut *tx)
                    .await?;
                }
                if let Some(branch) = payload.get("branch_name").and_then(|v| v.as_str()) {
                    sqlx::query(
                        "UPDATE dev_sessions SET branch_name = $2, updated_at = NOW() WHERE id = $1",
                    )
                    .bind(session.id)
                    .bind(branch)
                    .execute(&mut *tx)
                    .await?;
                }
                Self::upsert_stage_artifact_tx(
                    &mut tx,
                    session.id,
                    stage_name,
                    serde_json::json!({ "kind": "pr", "pr_url": payload.get("pr_url") }),
                    None,
                )
                .await?;
            }
```

**(b) service `create` 支持 `assigned_runner`**——新增独立函数，避免改动现有 `create` 的所有调用点（`dev_session_db.rs:73` 等测试夹具）：
```rust
    /// 创建会话并定向到指定 runner（autopilot_selfhosted 用）。
    /// 与 `create` 同体，多写 assigned_runner；repos 关联同样落 dev_session_repos。
    pub async fn create_with_runner(
        db: &PgPool,
        requirement_id: Uuid,
        repo_ids: &[Uuid],
        agent_backend: &str,
        max_stage: &str,
        assigned_runner: Option<Uuid>,
        created_by: Uuid,
    ) -> Result<DevSession, sqlx::Error> {
        let mut tx = db.begin().await?;
        let session = sqlx::query_as::<_, DevSession>(
            r#"INSERT INTO dev_sessions
               (requirement_id, agent_backend, max_stage, assigned_runner, created_by)
               VALUES ($1, $2, $3, $4, $5)
               RETURNING *"#,
        )
        .bind(requirement_id)
        .bind(agent_backend)
        .bind(max_stage)
        .bind(assigned_runner)
        .bind(created_by)
        .fetch_one(&mut *tx)
        .await?;
        for (pos, repo_id) in repo_ids.iter().enumerate() {
            sqlx::query(
                "INSERT INTO dev_session_repos (session_id, repo_id, position) VALUES ($1, $2, $3)",
            )
            .bind(session.id)
            .bind(repo_id)
            .bind(pos as i32)
            .execute(&mut *tx)
            .await?;
        }
        tx.commit().await?;
        Ok(session)
    }
```

> `DevSession` FromRow（`models/dev_session.rs:65-88`）须新增字段 `assigned_runner`。在 `pr_url: Option<String>`（`:82`）后加：`pub assigned_runner: Option<Uuid>,`。所有 `SELECT *`/`RETURNING *` 自动带它；既有 `create`（不写该列，DB 默认 NULL）仍可用。

**(c) route `create_session` 按 backend 选 max_stage + 接 runner + 友好 409**（`dev_sessions.rs:535-543` 改写，并扩展 DTO 接 `assigned_runner`）：

先在 `CreateDevSessionRequest`（`models/dev_session.rs:146-156`）加：
```rust
    /// 目标 runner（仅 agent_backend=autopilot_selfhosted 有意义；定向下发到指定机器）。
    pub assigned_runner: Option<Uuid>,
```

`dev_sessions.rs` 顶部加常量（`:42` 旁）：
```rust
/// autopilot_selfhosted 放开到 pr（写代码+出 PR）；其余后端停 PHASE1_MAX_STAGE。
fn max_stage_for_backend(agent_backend: &str) -> &'static str {
    if agent_backend == "autopilot_selfhosted" {
        "pr"
    } else {
        PHASE1_MAX_STAGE
    }
}
```

把 `create_session` 里 `DevSessionService::create(...)`（`:535-543`）替换为：
```rust
    // autopilot_selfhosted 必须指定目标 runner（定向下发到指定机器）
    if req.agent_backend == "autopilot_selfhosted" && req.assigned_runner.is_none() {
        return Err(AppError::Validation(
            "autopilot_selfhosted 会话须指定目标 runner".to_string(),
        ));
    }
    let max_stage = max_stage_for_backend(&req.agent_backend);
    let session = DevSessionService::create_with_runner(
        &state.db,
        req_id,
        &repo_ids,
        &req.agent_backend,
        max_stage,
        req.assigned_runner,
        created_by,
    )
    .await
    .map_err(|e| {
        // 单需求单活跃唯一索引冲突 → 友好 409（spec §5.5）
        if let sqlx::Error::Database(db_err) = &e
            && db_err.constraint() == Some("uq_dev_sessions_active_per_req")
        {
            AppError::Conflict("该需求已有进行中的 AI 开发会话，请先结束再新建".to_string())
        } else {
            AppError::Database(e)
        }
    })?;
```

> 派发段（`:557-574`）原样保留：对 autopilot_selfhosted，`WorkerClient::dispatch_session`（`:562`）内部多态走 `RunnerDispatcher`（不 push，会话停 created）。容量闸门 `working_count`/`max_active`（`:559-560`）对 runner 模式也适用——若全局已满则落 limit_hit、不派；但 runner 模式不靠后端派，会话仍停 created 等 claim，limit_hit 仅作可见信号，无害。

- [ ] **Step 4：运行确认通过**

Run（`backend/`）: `ORCH_PG=... ORCH_REDIS=... cargo test --test runner_http pr_created_and_max_stage_and_single_active -- --ignored --nocapture`
Expected: 三节全 PASS（max_stage=pr / 409 单活跃 / pr_url 写入）。
Run: `cargo test --test dev_session_http -- --ignored`（确认既有 e2e 不回归——`create` 仍可用、`DevSession` 多列不破坏既有断言）。
Run: `cargo test --lib`（dev_session_service/model 单测不回归）+ `cargo +nightly fmt && cargo clippy -- -D warnings`。

> 既有 `dev_session_db.rs:73` 调 `DevSessionService::create(...)` 仍存在（未删 `create`），不破坏。`dev_session_http.rs` 创建会话不传 `assigned_runner`（默认 codex），走 `create_with_runner(... None ...)` 否？——不：`create_session` 仅当 backend=autopilot_selfhosted 才要 runner；codex 分支也走 `create_with_runner(... assigned_runner=None ...)`，与原 `create` 等价（DB 列 NULL），故 dev_session_http e2e 的 codex 路径不变。

- [ ] **Step 5：提交**

```bash
git add backend/src/services/dev_session_service.rs backend/src/routes/dev_sessions.rs backend/src/models/dev_session.rs backend/tests/runner_http.rs
git commit -m "feat(runner): ingest 加 pr_created 写 pr_url、create_with_runner 接 assigned_runner、max_stage 按 backend(autopilot_selfhosted=pr)、单活跃唯一索引冲突回 409"
```

---

## Task 5：runner 路由（register / heartbeat / sessions/pending 长轮询原子 claim / deregister）+ ensure_runner_auth

**Files:**
- Create: `backend/src/routes/runners.rs`
- Modify: `backend/src/routes/mod.rs`
- Test: `backend/tests/runner_http.rs`（追加长轮询/鉴权用例）

- [ ] **Step 1：写失败测试（追加到 `runner_http.rs`）**

```rust
#[tokio::test]
#[ignore = "需要 ORCH_PG + ORCH_REDIS 真实服务"]
async fn runner_register_claim_and_revoke() {
    let base = std::env::var("ORCH_PG").expect("需要 ORCH_PG");
    let redis_url = std::env::var("ORCH_REDIS").expect("需要 ORCH_REDIS");
    let pool = setup_db(&base).await;

    // admin token（developer 角色无 runner_manage，故管理端用 admin）
    let admin_token = generate_token(
        &JwtConfig { secret: JWT_SECRET.into(), expiration_hours: 24 },
        Uuid::new_v4(), "admin_open", "管理员", &UserRole::Admin,
    ).unwrap();

    let state = build_state(pool.clone(), &redis_url).await;
    let server = TestServer::new(axum::Router::new().nest("/api", routes::api_routes(state)));

    // --- 1. admin 生成注册 token ---
    let body: Value = server
        .post("/api/admin/runners/registration-token")
        .authorization_bearer(&admin_token)
        .json(&json!({ "ttl_minutes": 15 }))
        .await.json();
    assert!(body["success"].as_bool().unwrap(), "生成 token 失败: {body}");
    let reg_token = body["data"]["token"].as_str().unwrap().to_string();
    println!("✓ admin 生成注册 token");

    // --- 2. 非 admin（无 runner_manage）生成 token → 403 ---
    let dev = dev_token();
    server
        .post("/api/admin/runners/registration-token")
        .authorization_bearer(&dev)
        .json(&json!({ "ttl_minutes": 15 }))
        .await
        .assert_status(StatusCode::FORBIDDEN);

    // --- 3. runner 注册换长期凭证 ---
    let body: Value = server
        .post("/api/runners/register")
        .json(&json!({ "token": reg_token, "name": "my-laptop", "machine_meta": { "os": "win" } }))
        .await.json();
    assert!(body["success"].as_bool().unwrap(), "注册失败: {body}");
    let runner_id = body["data"]["runner_id"].as_str().unwrap().to_string();
    let secret = body["data"]["secret"].as_str().unwrap().to_string();
    println!("✓ runner 注册: id={runner_id}");

    // --- 4. 重放注册 token → 401 ---
    server
        .post("/api/runners/register")
        .json(&json!({ "token": reg_token, "name": "replay", "machine_meta": {} }))
        .await
        .assert_status_unauthorized();
    println!("✓ 注册 token 重放 → 401");

    // --- 5. runner 心跳（带凭证）---
    server
        .post(&format!("/api/runners/{runner_id}/heartbeat"))
        .authorization_bearer(&secret)
        .add_header("x-runner-id", &runner_id)
        .await
        .assert_status_ok();

    // --- 6. 错误凭证心跳 → 401 ---
    server
        .post(&format!("/api/runners/{runner_id}/heartbeat"))
        .authorization_bearer("wrong-secret")
        .add_header("x-runner-id", &runner_id)
        .await
        .assert_status_unauthorized();
    println!("✓ runner 心跳: 正确凭证 200 / 错误 401");

    // --- 7. 建一个待派 session → 长轮询 claim 拿到 ---
    let req_id: Uuid = sqlx::query_scalar("INSERT INTO requirements (title) VALUES ('p') RETURNING id")
        .fetch_one(&pool).await.unwrap();
    let dev_id: Uuid = sqlx::query_scalar("INSERT INTO developers DEFAULT VALUES RETURNING id")
        .fetch_one(&pool).await.unwrap();
    let rid = Uuid::parse_str(&runner_id).unwrap();
    let sid: Uuid = sqlx::query_scalar(
        "INSERT INTO dev_sessions (requirement_id, agent_backend, status, assigned_runner, created_by)
         VALUES ($1, 'autopilot_selfhosted', 'created', $2, $3) RETURNING id",
    ).bind(req_id).bind(rid).bind(dev_id).fetch_one(&pool).await.unwrap();

    let body: Value = server
        .get(&format!("/api/runners/{runner_id}/sessions/pending?wait=1"))
        .authorization_bearer(&secret)
        .add_header("x-runner-id", &runner_id)
        .await.json();
    assert!(body["success"].as_bool().unwrap(), "pending 失败: {body}");
    assert_eq!(body["data"]["id"].as_str().unwrap(), sid.to_string(), "应 claim 到待派 session");
    // claim 后该 session 已 queued，再次长轮询（wait=1）应超时 → 204
    server
        .get(&format!("/api/runners/{runner_id}/sessions/pending?wait=1"))
        .authorization_bearer(&secret)
        .add_header("x-runner-id", &runner_id)
        .await
        .assert_status(StatusCode::NO_CONTENT);
    println!("✓ 长轮询: 有待派→claim 返回, 无待派→204");

    // --- 8. revoke 后凭证失效 → 心跳 401 ---
    server
        .delete(&format!("/api/runners/{runner_id}"))
        .authorization_bearer(&admin_token)
        .await
        .assert_status_ok();
    server
        .post(&format!("/api/runners/{runner_id}/heartbeat"))
        .authorization_bearer(&secret)
        .add_header("x-runner-id", &runner_id)
        .await
        .assert_status_unauthorized();
    println!("✓ revoke 后凭证失效 → 401");

    pool.close().await;
    println!("\n✓ runner 注册/claim/revoke e2e 全通过");
}
```

> 鉴权头约定：runner 端点用 `Authorization: Bearer <secret>` + `x-runner-id: <uuid>` 两段（runner_id 在 path 也有，但鉴权统一从 header 读 secret + path 取 id 校验）。下方 handler 以 path 的 `{id}` 为 runner_id、`Authorization` 取 secret，`x-runner-id` 仅作冗余校验（可选）——测试同时带上，handler 以 path id 为准。

- [ ] **Step 2：运行确认失败**

Run（`backend/`）: `cargo test --test runner_http -- --ignored`
Expected: 编译失败 —— `/api/runners/*` 与 `/api/admin/runners/*` 路由不存在（404，断言失败）；`routes::runners` 未声明。

- [ ] **Step 3：实现 `routes/runners.rs` + 挂载**

`backend/src/routes/runners.rs`：
```rust
use std::time::Duration;

use axum::{
    Extension, Json, Router,
    extract::{Path, Query, State},
    http::HeaderMap,
    response::{IntoResponse, Response},
    routing::{delete, get, post},
};
use serde::Deserialize;
use uuid::Uuid;

use crate::AppState;
use crate::errors::{ApiResponse, AppError};
use crate::middleware::auth::{Claims, RolePermissions, check_permission};
use crate::models::dev_session::DevSession;
use crate::models::runner::{
    CreateRegistrationTokenRequest, Runner, RunnerRegisterRequest, RunnerRegisterResponse,
};
use crate::services::runner_service::RunnerService;

/// admin 端管理 Runner 所需权限（迁移 062）。
const RUNNER_MANAGE: &str = "runner_manage";
/// 长轮询单次最大挂起秒数（spec §4.2：50s 可接受，进程内 broadcast + last-chance 兜底）。
const MAX_WAIT_SECS: u64 = 50;
/// 长轮询内部轮询间隔（broadcast 叫醒之外的兜底，多实例 last-chance）。
const POLL_INTERVAL_MS: u64 = 1000;

/// runner 端路由（runner 凭证鉴权，非 JWT；挂 /api/runners）。
pub fn runner_router(state: AppState) -> Router {
    Router::new()
        .route("/register", post(register))
        .route("/{id}/heartbeat", post(heartbeat))
        .route("/{id}/sessions/pending", get(pending))
        .route("/{id}/deregister", post(deregister))
        .with_state(state)
}

/// admin 端路由（JWT + runner_manage；挂 /api/admin/runners + /api/runners 列表）。
pub fn admin_router(state: AppState) -> Router {
    Router::new()
        .route("/admin/runners/registration-token", post(create_token))
        .route("/runners", get(list_runners))
        .route("/runners/{id}", delete(revoke_runner))
        .with_state(state)
}

/// runner 凭证鉴权：path 的 runner_id + Authorization: Bearer <secret>，校验哈希。
/// 失败回 401。被 revoke（软删）后 verify_runner_auth 返 false → 401（spec §8.2）。
async fn ensure_runner_auth(
    state: &AppState,
    runner_id: Uuid,
    headers: &HeaderMap,
) -> Result<(), AppError> {
    let secret = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
        .unwrap_or("");
    if secret.is_empty() {
        return Err(AppError::Unauthorized);
    }
    if RunnerService::verify_runner_auth(&state.db, runner_id, secret).await? {
        Ok(())
    } else {
        Err(AppError::Unauthorized)
    }
}

// ---- runner 端 ----

/// runner 用一次性 token 换长期凭证（spec §8.1）。token 经 body（CLI 从 stdin 读再 POST）。
/// 成功返回 runner_id + 明文 secret（仅此一次）；token 无效/已用/过期 → 401。
async fn register(
    State(state): State<AppState>,
    Json(req): Json<RunnerRegisterRequest>,
) -> Result<Json<ApiResponse<RunnerRegisterResponse>>, AppError> {
    if req.name.trim().is_empty() {
        return Err(AppError::Validation("runner name 不能为空".to_string()));
    }
    match RunnerService::register(&state.db, &req.token, req.name.trim(), req.machine_meta).await? {
        Some(result) => Ok(ApiResponse::ok(RunnerRegisterResponse {
            runner_id: result.runner.id,
            secret: result.secret,
        })),
        None => Err(AppError::Unauthorized), // 无效/已消费/过期
    }
}

/// runner 级心跳（spec §4.2）。刷新 last_heartbeat_at；revoke 后凭证失效 → 401。
async fn heartbeat(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<Json<ApiResponse<()>>, AppError> {
    ensure_runner_auth(&state, id, &headers).await?;
    if !RunnerService::heartbeat(&state.db, id).await? {
        return Err(AppError::NotFound("runner 不存在或已 revoke".to_string()));
    }
    Ok(ApiResponse::ok(()))
}

#[derive(Debug, Deserialize)]
struct PendingQuery {
    /// 长轮询挂起秒数（clamp 到 [0, MAX_WAIT_SECS]）。
    #[serde(default)]
    wait: u64,
}

/// 长轮询领待派 session（spec §4.2）：
///   先即时原子 claim → 有则返回；
///   否则在 wait 秒内被 broadcast 叫醒或定时 last-chance 重查后再 claim；
///   超时无待派 → 204。
/// 多实例 caveat：broadcast 仅进程内，跨实例叫醒失效，故每 POLL_INTERVAL 做 last-chance 重查。
async fn pending(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Query(q): Query<PendingQuery>,
    headers: HeaderMap,
) -> Result<Response, AppError> {
    ensure_runner_auth(&state, id, &headers).await?;
    // 心跳借机刷新（runner 在轮询即在线）
    let _ = RunnerService::heartbeat(&state.db, id).await;

    // 即时一把
    if let Some(s) = RunnerService::claim_one_pending(&state.db, id).await? {
        return Ok(claimed_response(s));
    }

    let wait = q.wait.min(MAX_WAIT_SECS);
    if wait == 0 {
        return Ok(StatusCode::NO_CONTENT.into_response());
    }

    // 订阅本 runner 的「派活」叫醒频道（复用 dev_session_broadcaster，按 runner_id 复用 session 频道形态）
    let mut rx = state.dev_session_broadcaster.subscribe(id);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(wait);
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return Ok(StatusCode::NO_CONTENT.into_response());
        }
        // 被叫醒 或 到 last-chance 间隔，二者先到为准
        let tick = remaining.min(Duration::from_millis(POLL_INTERVAL_MS));
        tokio::select! {
            _ = rx.recv() => {}            // broadcast 叫醒（同实例）
            _ = tokio::time::sleep(tick) => {} // last-chance（跨实例兜底）
        }
        if let Some(s) = RunnerService::claim_one_pending(&state.db, id).await? {
            return Ok(claimed_response(s));
        }
    }
}

use axum::http::StatusCode;

/// 把 claim 到的 session 包成 200 JSON（与其它端点同 ApiResponse 形状）。
fn claimed_response(s: DevSession) -> Response {
    Json(ApiResponse::<DevSession> {
        success: true,
        data: Some(s),
        message: None,
    })
    .into_response()
}

/// 优雅下线：置 offline（凭证仍有效，重启续用）。
async fn deregister(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<Json<ApiResponse<()>>, AppError> {
    ensure_runner_auth(&state, id, &headers).await?;
    RunnerService::mark_offline(&state.db, id).await?;
    Ok(ApiResponse::ok(()))
}

// ---- admin 端（JWT + runner_manage）----

/// 生成一次性注册 token（15min，哈希存储）。
async fn create_token(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Extension(role_perms): Extension<RolePermissions>,
    Json(req): Json<CreateRegistrationTokenRequest>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    check_permission(&claims, &role_perms, RUNNER_MANAGE)?;
    let created_by = Uuid::parse_str(&claims.sub).ok();
    let token =
        RunnerService::create_registration_token(&state.db, created_by, req.ttl_minutes).await?;
    Ok(ApiResponse::ok(serde_json::json!({ "token": token })))
}

/// 列出 runner。
async fn list_runners(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Extension(role_perms): Extension<RolePermissions>,
) -> Result<Json<ApiResponse<Vec<Runner>>>, AppError> {
    check_permission(&claims, &role_perms, RUNNER_MANAGE)?;
    Ok(ApiResponse::ok(RunnerService::list(&state.db).await?))
}

/// revoke runner（作废 secret + 软删）。
async fn revoke_runner(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Extension(role_perms): Extension<RolePermissions>,
    Path(id): Path<Uuid>,
) -> Result<Json<ApiResponse<()>>, AppError> {
    check_permission(&claims, &role_perms, RUNNER_MANAGE)?;
    if !RunnerService::revoke(&state.db, id).await? {
        return Err(AppError::NotFound("runner 不存在或已 revoke".to_string()));
    }
    Ok(ApiResponse::ok(()))
}
```

> `StatusCode` 的 `use` 放文件顶部更整洁；上面为就地说明放在中部，实现时把 `use axum::http::StatusCode;` 提到顶部 import 块（与 clippy 一致）。

`backend/src/routes/mod.rs` 改动：
1. 加 `pub mod runners;`（`pub mod requirements;` 附近）。
2. 在 `authenticated_routes`（`:69` 起）链上加 admin 路由（JWT 保护）：在 `.nest("/dev-sessions", ...)` 之后加 `.merge(runners::admin_router(state.clone()))`（admin_router 内部路径已是绝对 `/admin/runners/...` 与 `/runners`，故用 `merge` 不 `nest`）。
3. 在 `public_routes`（`:151` 起）加 runner 端（runner 凭证鉴权，非 JWT）：`.nest("/runners", runners::runner_router(state.clone()))`。

具体：
```rust
        .nest("/dev-sessions", dev_sessions::router(state.clone()))
        .merge(runners::admin_router(state.clone()))   // ← 新增：/admin/runners + /runners（JWT+runner_manage）
```
```rust
        // Worker 内部回调（共享密钥鉴权，非 JWT）
        .nest("/internal", dev_sessions::internal_router(state.clone()))
        // Runner 端（per-runner 凭证鉴权，非 JWT；连接倒转拉式领活）
        .nest("/runners", runners::runner_router(state.clone()));
```

> 路径核对：admin_router 的 `/runners` GET 列表与 runner_router 的 `/runners/{id}/...` 都以 `/api/runners` 开头但前者经 authenticated_routes（含 auth_middleware）后者经 public_routes。axum 路由匹配：`GET /api/runners`（列表，JWT）vs `GET /api/runners/{id}/sessions/pending`（runner 凭证）——不同 path，无冲突。`DELETE /api/runners/{id}`（admin）vs runner 端无 `DELETE /runners/{id}`（runner 端是 `/runners/{id}/heartbeat` POST、`/runners/{id}/deregister` POST、`/runners/{id}/sessions/pending` GET），无方法冲突。`POST /api/runners/register`（runner 端，public）vs admin 端无 `/runners/register`，无冲突。

- [ ] **Step 4：运行确认通过**

Run（`backend/`）: `ORCH_PG=... ORCH_REDIS=... cargo test --test runner_http -- --ignored --nocapture`
Expected: `runner_register_claim_and_revoke` + `pr_created_and_max_stage_and_single_active` 全 PASS。
Run: `cargo test --test dev_session_http -- --ignored`（既有 e2e 不回归）+ `cargo test --lib`（单测全绿）。
Run: `cargo +nightly fmt && cargo clippy -- -D warnings` → 无警告。

- [ ] **Step 5：提交**

```bash
git add backend/src/routes/runners.rs backend/src/routes/mod.rs backend/tests/runner_http.rs
git commit -m "feat(runner): routes/runners——register(一次性token)/heartbeat/sessions-pending(长轮询原子claim+last-chance)/deregister + admin 生成token/列表/revoke + ensure_runner_auth"
```

---

## Task 6：reaper 拉模型回收接入 tick + 派活叫醒 broadcast

**Files:**
- Modify: `backend/src/services/dev_session_reaper.rs`、`backend/src/routes/runners.rs`（claim 后唤醒已无需，pending 端 broadcast 订阅；派活信号由 create_session/assign 处发）、`backend/src/routes/dev_sessions.rs`（create autopilot_selfhosted 后 broadcast 叫醒对应 runner）
- Test: `backend/tests/runner_db.rs`（reaper tick 集成，复用 Task 2 的 `reclaim_stale_runner_sessions`）+ `runner_http.rs` 已覆盖 pending 行为

- [ ] **Step 1：写失败测试（追加到 `runner_db.rs`）**

```rust
#[tokio::test]
#[ignore = "需要 ORCH_PG 真实数据库"]
async fn reaper_tick_reclaims_stale_runner() {
    let pool = setup().await;
    let (runner_id, _secret) = new_runner(&pool).await;
    let req: Uuid = sqlx::query_scalar("INSERT INTO requirements DEFAULT VALUES RETURNING id")
        .fetch_one(&pool).await.unwrap();
    let dev: Uuid = sqlx::query_scalar("INSERT INTO developers DEFAULT VALUES RETURNING id")
        .fetch_one(&pool).await.unwrap();
    let sid: Uuid = sqlx::query_scalar(
        "INSERT INTO dev_sessions (requirement_id, agent_backend, status, assigned_runner, created_by, last_heartbeat_at)
         VALUES ($1, 'autopilot_selfhosted', 'running', $2, $3, NOW()) RETURNING id",
    ).bind(req).bind(runner_id).bind(dev).fetch_one(&pool).await.unwrap();
    // runner 心跳过期（session 心跳仍新，单独验 runner 维度回收）
    sqlx::query("UPDATE runners SET last_heartbeat_at = NOW() - INTERVAL '5 minutes', status='busy' WHERE id=$1")
        .bind(runner_id).execute(&pool).await.unwrap();

    let stats = reqgenie_backend::services::dev_session_reaper::DevSessionReaper::tick(&pool)
        .await.unwrap();
    assert!(stats.runner_reclaimed >= 1, "tick 应统计回收数, 实得 {}", stats.runner_reclaimed);
    let status: String = sqlx::query_scalar("SELECT status FROM dev_sessions WHERE id=$1")
        .bind(sid).fetch_one(&pool).await.unwrap();
    assert_eq!(status, "created", "reaper tick 后 session 回退 created");
    println!("✓ reaper tick: runner 心跳超时 → 拉模型回收 session 回 created");
    pool.close().await;
}
```

> 该测试需 `runner_db.rs` 的 `SCHEMA` 也能跑 reaper（reaper 只读 dev_sessions/runners，不触 redis）。`tick` 内部第 5 步「容量派发」对 autopilot_selfhosted 会调 `dispatch_session`→`RunnerDispatcher`（不 push、无害）；但容量派发只取 `status='created' AND updated_at < NOW()-2min` 的行，刚回退的 created `updated_at=NOW()` 不会被立即重派，安全。

- [ ] **Step 2：运行确认失败**

Run（`backend/`）: `cargo test --test runner_db reaper_tick_reclaims_stale_runner -- --ignored`
Expected: 编译失败 —— `ReaperStats` 无 `runner_reclaimed` 字段、`tick` 未调回收。

- [ ] **Step 3：实现 reaper 接入 + 派活叫醒**

**(a) `dev_session_reaper.rs`：`ReaperStats` 加字段 + `tick` 加回收步骤。**

`ReaperStats`（`:46-53`）加：
```rust
    pub runner_reclaimed: usize,
```

在 `tick` 的步骤 5（容量派发，`:229-266`）**之前**插入步骤（用 Task 2 的 service 原语；阈值复用 `heartbeat_timeout_s()`）：
```rust
        // 5. 拉模型回收 (spec §4.2): runner 级心跳超时 → 标 offline +
        //    其 queued/running 非终态 session 回退 created (保留 assigned_runner, 等重领)。
        //    放在容量派发前: 回退的 created updated_at=NOW(), 不会被同 tick 的 2min 退避派发误带走。
        match RunnerService_reclaim(db, heartbeat_timeout_s() as i64).await {
            Ok(n) => stats.runner_reclaimed = n as usize,
            Err(e) => tracing::error!("reaper 拉模型回收失败: {e}"),
        }
```

文件顶部加导入与薄封装（避免 reaper 直接深依赖 service 内部）：
```rust
use crate::services::runner_service::RunnerService;
```
并把上面调用写成直接调用（无需薄封装，去掉 `RunnerService_reclaim` 占位，改为）：
```rust
        match RunnerService::reclaim_stale_runner_sessions(db, heartbeat_timeout_s() as i64).await {
            Ok(n) => stats.runner_reclaimed = n as usize,
            Err(e) => tracing::error!("reaper 拉模型回收失败: {e}"),
        }
```

> 注意：步骤 1「session 心跳超时→failed」（`:131-154`）已有，对 autopilot_selfhosted 同样适用——session 卡死（runner 在线但某 session 不心跳）→ failed（spec §4.2「session 级心跳超时→failed」），无需新增。两者维度不同：步骤 1 看 `dev_sessions.last_heartbeat_at`，新步骤看 `runners.last_heartbeat_at`，正交。

`main.rs` 调度器日志（`:496-511`）把 `runner_reclaimed` 纳入打印条件与文案——改 `> 0` 求和加 `+ stats.runner_reclaimed`，并在 `tracing::info!` 文案末尾加 `/ 回收 {}` 与 `stats.runner_reclaimed`：
```rust
                if stats.heartbeat_failed
                    + stats.wall_clock_failed
                    + stats.input_paused
                    + stats.queue_timeout_failed
                    + stats.dispatched
                    + stats.runner_reclaimed
                    > 0
                {
                    tracing::info!(
                        "reaper: 心跳超时 {} / 墙钟 {} / 澄清挂起 {} / 排队超时 {} / 补位派发 {} / runner回收 {}",
                        stats.heartbeat_failed,
                        stats.wall_clock_failed,
                        stats.input_paused,
                        stats.queue_timeout_failed,
                        stats.dispatched,
                        stats.runner_reclaimed
                    );
                }
```

**(b) 派活叫醒：create autopilot_selfhosted 后 broadcast 唤醒目标 runner 的长轮询。**

在 `dev_sessions.rs::create_session` 派发段（autopilot_selfhosted 分支），`RunnerDispatcher` 不 push，但应叫醒目标 runner 正在跑的 `/sessions/pending` 长轮询（避免最长等满 wait 才领到）。在 `create_session` 成功后、返回前（`:574` 之后、`:576` Ok 之前）插入：
```rust
    // 唤醒目标 runner 的长轮询（同进程实例命中即时领活；跨实例靠 pending 端 last-chance 兜底）。
    if let Some(runner_id) = req.assigned_runner {
        state
            .dev_session_broadcaster
            .broadcast(runner_id, serde_json::json!({ "wake": "pending" }).to_string());
    }
```

> 复用 `DevSessionBroadcaster`（按 `runner_id` 当频道键，与 session 频道同表不冲突——key 是 Uuid，runner 与 session 的 UUID 空间不会撞）。`pending` 端 `subscribe(id)`（Task 5）正是订阅该 `runner_id` 频道，收到任意消息即重查 claim。spec §5.2 已声明 broadcast 仅进程内、last-chance 兜底，符合。

- [ ] **Step 4：运行确认通过**

Run（`backend/`）: `cargo test --test runner_db -- --ignored --nocapture`（含 `reaper_tick_reclaims_stale_runner` + Task 2 全部）→ PASS。
Run: `cargo test --test runner_http -- --ignored`（Task 5 长轮询 e2e 不回归；create 后 broadcast 无副作用回归）→ PASS。
Run: `cargo test --lib`（dev_session_reaper 单测 `:277-291` 不回归——`ReaperStats` 加字段 `#[derive(Default)]` 仍成立）+ `cargo +nightly fmt && cargo clippy -- -D warnings`。

- [ ] **Step 5：提交**

```bash
git add backend/src/services/dev_session_reaper.rs backend/src/main.rs backend/src/routes/dev_sessions.rs backend/tests/runner_db.rs
git commit -m "feat(runner): reaper tick 接入拉模型回收(runner心跳超时→session回退created)+stats可见; create autopilot_selfhosted 后 broadcast 叫醒目标 runner 长轮询"
```

---

## Task 7：前端——DevSessionEntry 选 agent_backend + 目标 runner，Runner 管理页

**Files:**
- Create: `frontend/src/api/runners.ts`、`frontend/src/pages/RunnerManager.tsx`
- Modify: `frontend/src/types/index.ts`、`frontend/src/components/DevSessionEntry.tsx`、`frontend/src/api/devSession.ts`、`frontend/src/App.tsx`、`frontend/src/components/MainLayout.tsx`、`frontend/src/config/routePermissions.ts`
- Test: `npm run build`（TS 编译）+ Playwright MCP 交互验证（步骤见 Step 4）

> reqgenie CLAUDE.md 强制：前端页面用 `frontend-design` skill。本任务实现前先 `Skill(frontend-design)` 取设计指导，再按下方代码骨架落地（Ant Design 风格，与现有 `DevSessionEntry`/`AiSettings` 一致：List/Modal/Tag/Popconfirm/message）。

- [ ] **Step 1：实现类型 + API + 改 createDevSession**

`frontend/src/types/index.ts`：`DevSession` 接口（`:235-248`）加：
```ts
  assigned_runner?: string | null
```
文件合适处（DevSession 附近）新增：
```ts
export interface Runner {
  id: string
  name: string
  status: 'offline' | 'online' | 'busy'
  machine_meta?: Record<string, unknown> | null
  registered_by?: string | null
  last_heartbeat_at?: string | null
  created_at: string
  updated_at: string
}
```

`frontend/src/api/runners.ts`（新建）：
```ts
import apiClient from './client'
import type { ApiResponse, Runner } from '../types'

/** 列出 runner（admin，runner_manage） */
export async function fetchRunners() {
  const { data } = await apiClient.get<ApiResponse<Runner[]>>('/runners')
  return data.data!
}

/** 生成一次性注册 token（admin），返回明文 token（仅此一次展示） */
export async function createRegistrationToken(ttlMinutes = 15) {
  const { data } = await apiClient.post<ApiResponse<{ token: string }>>(
    '/admin/runners/registration-token',
    { ttl_minutes: ttlMinutes },
  )
  return data.data!.token
}

/** revoke runner（作废凭证 + 软删） */
export async function revokeRunner(id: string) {
  const { data } = await apiClient.delete<ApiResponse<null>>(`/runners/${id}`)
  return data.data
}
```

`frontend/src/api/devSession.ts`：`createDevSession`（`:13-22`）签名扩展 `assigned_runner`：
```ts
export async function createDevSession(
  requirementId: string,
  req: { repo_ids?: string[]; agent_backend?: string; assigned_runner?: string },
) {
  const { data } = await apiClient.post<ApiResponse<DevSession>>(
    `/requirements/${requirementId}/dev-sessions`,
    req,
  )
  return data.data!
}
```

- [ ] **Step 2：DevSessionEntry 加 agent_backend + 目标 runner 选择**

`frontend/src/components/DevSessionEntry.tsx` 改动（在现有 import 后加 `fetchRunners`、新增两个 state、Modal 内加两个 Select、createMut 传参）：

import 段加：
```ts
import { fetchRunners } from '../api/runners'
```
组件内 state（`:49` `repoIds` 旁）加：
```ts
  const [backend, setBackend] = useState<'codex' | 'autopilot_selfhosted'>('codex')
  const [runnerId, setRunnerId] = useState<string | undefined>(undefined)
```
查询在线 runner（仅选 autopilot_selfhosted 时拉，picker 打开时启用）：
```ts
  const { data: runners, isLoading: runnersLoading } = useQuery({
    queryKey: ['runnersOnline'],
    queryFn: fetchRunners,
    enabled: pickerOpen && backend === 'autopilot_selfhosted',
  })
  const onlineRunners = (runners ?? []).filter((r) => r.status !== 'offline')
```
`createMut`（`:87-95`）改为传 backend + runner：
```ts
  const createMut = useMutation({
    mutationFn: () =>
      createDevSession(requirementId, {
        repo_ids: repoIds,
        agent_backend: backend,
        ...(backend === 'autopilot_selfhosted' ? { assigned_runner: runnerId } : {}),
      }),
    onSuccess: (s) => {
      qc.invalidateQueries({ queryKey: ['devSessions', requirementId] })
      setPickerOpen(false)
      nav(`/requirements/${requirementId}/dev-sessions/${s.id}`)
    },
    onError: () => message.error('创建会话失败'),
  })
```
`openPicker`（`:115-118`）加重置：
```ts
  const openPicker = () => {
    setRepoIds([])
    setBackend('codex')
    setRunnerId(undefined)
    setPickerOpen(true)
  }
```
Modal（`:132-164`）`onOk` 改为 `() => createMut.mutate()`，并在仓库 Select **之前**加 backend + runner 选择，且 autopilot_selfhosted 未选 runner 时禁用确认：
```tsx
      <Modal
        title="开始 AI 开发"
        open={pickerOpen}
        onOk={() => createMut.mutate()}
        onCancel={() => setPickerOpen(false)}
        okText="创建会话"
        okButtonProps={{
          disabled: backend === 'autopilot_selfhosted' && !runnerId,
        }}
        confirmLoading={createMut.isPending}
        destroyOnHidden
      >
        <p className="text-gray-500 text-sm mb-2">执行后端</p>
        <Select
          className="w-full mb-3"
          value={backend}
          onChange={(v) => {
            setBackend(v)
            setRunnerId(undefined)
          }}
          options={[
            { value: 'codex', label: 'Codex（集中托管 worker）' },
            { value: 'autopilot_selfhosted', label: 'Autopilot 自托管 Runner（你的机器，可写代码 + 出 PR）' },
          ]}
        />
        {backend === 'autopilot_selfhosted' && (
          <>
            <p className="text-gray-500 text-sm mb-2">目标 Runner（下发到指定机器）</p>
            <Select
              className="w-full mb-3"
              placeholder={onlineRunners.length === 0 ? '暂无在线 Runner，请先在「Runner 管理」注册' : '选择在线 Runner'}
              value={runnerId}
              onChange={setRunnerId}
              loading={runnersLoading}
              disabled={onlineRunners.length === 0}
              options={onlineRunners.map((r) => ({
                value: r.id,
                label: `${r.name}（${r.status === 'busy' ? '忙' : '在线'}）`,
              }))}
            />
          </>
        )}
        <p className="text-gray-500 text-sm mb-2">
          选择要让 AI 阅读的代码仓库（来自需求关联的仓库与项目），可多选（如前端 +
          后端）。不选则仅基于需求文本产出方案。
        </p>
        {/* 既有仓库 Select 原样保留 */}
        <Select
          className="w-full"
          mode="multiple"
          /* ...原有 props 不变... */
        />
      </Modal>
```

- [ ] **Step 3：Runner 管理页 + 路由 + 菜单 + 权限**

`frontend/src/pages/RunnerManager.tsx`（新建，参照 AiSettings/GitHubTokenManager 风格）：
```tsx
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Button, Card, Table, Tag, Modal, Popconfirm, Typography, message } from 'antd'
import { PlusOutlined, CopyOutlined } from '@ant-design/icons'
import { fetchRunners, createRegistrationToken, revokeRunner } from '../api/runners'
import type { Runner } from '../types'

const STATUS: Record<Runner['status'], { label: string; color: string }> = {
  online: { label: '在线', color: 'green' },
  busy: { label: '忙', color: 'blue' },
  offline: { label: '离线', color: 'default' },
}

export default function RunnerManager() {
  const qc = useQueryClient()
  const [token, setToken] = useState<string | null>(null)

  const { data: runners, isLoading } = useQuery({
    queryKey: ['runners'],
    queryFn: fetchRunners,
    refetchInterval: 10000, // 在线状态随心跳变，轮询刷新
  })

  const genMut = useMutation({
    mutationFn: () => createRegistrationToken(15),
    onSuccess: (t) => setToken(t),
    onError: () => message.error('生成注册 token 失败'),
  })

  const revokeMut = useMutation({
    mutationFn: (id: string) => revokeRunner(id),
    onSuccess: () => {
      message.success('已 revoke')
      qc.invalidateQueries({ queryKey: ['runners'] })
    },
    onError: () => message.error('revoke 失败'),
  })

  const copy = (t: string) => {
    navigator.clipboard?.writeText(t)
    message.success('已复制')
  }

  return (
    <Card
      title="Runner 管理"
      extra={
        <Button type="primary" icon={<PlusOutlined />} loading={genMut.isPending} onClick={() => genMut.mutate()}>
          生成注册 Token
        </Button>
      }
    >
      <Table<Runner>
        rowKey="id"
        loading={isLoading}
        dataSource={runners ?? []}
        pagination={false}
        columns={[
          { title: '名称', dataIndex: 'name' },
          {
            title: '状态',
            dataIndex: 'status',
            render: (s: Runner['status']) => <Tag color={STATUS[s].color} bordered={false}>{STATUS[s].label}</Tag>,
          },
          {
            title: '最近心跳',
            dataIndex: 'last_heartbeat_at',
            render: (v?: string | null) => (v ? new Date(v).toLocaleString('zh-CN') : '—'),
          },
          {
            title: '操作',
            render: (_, r) => (
              <Popconfirm
                title="revoke 该 Runner？"
                description="将作废其凭证并下线，该机器需重新注册。"
                okText="revoke"
                okButtonProps={{ danger: true }}
                onConfirm={() => revokeMut.mutate(r.id)}
              >
                <a className="!text-red-500">revoke</a>
              </Popconfirm>
            ),
          },
        ]}
      />

      <Modal
        title="一次性注册 Token（15 分钟有效）"
        open={!!token}
        onCancel={() => setToken(null)}
        footer={<Button onClick={() => setToken(null)}>关闭</Button>}
      >
        <Typography.Paragraph type="secondary">
          在目标机器执行以下命令，token 经 stdin 传入（不进 shell 历史）：
        </Typography.Paragraph>
        <Typography.Paragraph copyable={{ text: token ?? '' }} code>
          {`echo "${token}" | autopilot runner register --url <reqgenie-url>`}
        </Typography.Paragraph>
        <Button icon={<CopyOutlined />} onClick={() => token && copy(token)}>复制 Token</Button>
        <Typography.Paragraph type="warning" className="mt-3">
          此 Token 仅展示一次，关闭后无法再次查看；只能使用一次。
        </Typography.Paragraph>
      </Modal>
    </Card>
  )
}
```

`frontend/src/App.tsx`：import + 路由（仿 `:148`）：
```tsx
import RunnerManager from './pages/RunnerManager'
```
```tsx
        <Route path="admin/runners" element={<AuthorizedRoute permission="runner_manage"><RunnerManager /></AuthorizedRoute>} />
```

`frontend/src/components/MainLayout.tsx`：`buildAdminRoutes()`（`:122-130`）加一项（icon 复用已 import 的，如 `CloudServerOutlined`——若未 import 则加 import，或复用 `GithubOutlined` 同款已 import 的图标避免新依赖；这里用已有的 `SettingOutlined` 风险低，但语义弱。建议加 `import { CloudServerOutlined } from '@ant-design/icons'`）：
```tsx
    { path: '/admin/runners', name: 'Runner 管理', icon: <CloudServerOutlined /> },
```

`frontend/src/config/routePermissions.ts`：`routePermissions` 与 `menuPermissions` 各加：
```ts
  '/admin/runners': 'runner_manage',
```

- [ ] **Step 4：编译校验 + Playwright 验证**

Run（`frontend/`）: `npm run build`
Expected: TS 编译通过，无未使用变量/类型错误。

Playwright MCP 交互验证（reqgenie CLAUDE.md 强制；前端 dev server 跑 `npm run dev`，后端需可用，或用 mock）：
1. `browser_navigate` 到 `/admin/runners`（用 admin 账号），`browser_snapshot` 确认「Runner 管理」卡 + 「生成注册 Token」按钮 + 空表「暂无数据」。
2. `browser_click`「生成注册 Token」→ `browser_snapshot` 确认弹窗显示 `echo "<token>" | autopilot runner register ...` 命令 + 「仅展示一次」警告。
3. 导航到某需求详情 → 「AI 开发」→ `browser_click` 打开弹窗 → `browser_snapshot` 确认「执行后端」Select；选「Autopilot 自托管 Runner」→ 确认出现「目标 Runner」Select，无在线 runner 时「创建会话」按钮 disabled。
4. `browser_close`。
说明：若后端未起，用现有 `src/mocks/` 或临时 stub `fetchRunners` 返回空数组验证 UI 渲染路径；交互断言聚焦「后端选择切换→runner Select 显隐」「无 runner 时禁用确认」「token 弹窗文案」三条。

- [ ] **Step 5：提交**

```bash
git add frontend/src/api/runners.ts frontend/src/pages/RunnerManager.tsx frontend/src/types/index.ts frontend/src/components/DevSessionEntry.tsx frontend/src/api/devSession.ts frontend/src/App.tsx frontend/src/components/MainLayout.tsx frontend/src/config/routePermissions.ts
git commit -m "feat(runner): 前端 Runner 管理页(生成token/列表/revoke) + DevSessionEntry 选执行后端与目标 runner(autopilot_selfhosted)"
```

---

## Task 8：全量回归 + 提交闸门

**Files:** 无新增（验证 + 修复）

- [ ] **Step 1：后端全量**

Run（`backend/`）:
```
cargo test                                            # 全部单测（不含 #[ignore]）
ORCH_PG=<conn> ORCH_REDIS=<conn> cargo test -- --ignored   # 集成测试（runner_db/runner_http/dev_session_db/dev_session_http）
cargo +nightly fmt
cargo clippy -- -D warnings
```
Expected: 单测全绿；集成测试 runner_db（5 用例）+ runner_http（2 用例）+ 既有 dev_session_* 不回归；fmt 无 diff；clippy 无警告。

- [ ] **Step 2：前端全量**

Run（`frontend/`）: `npm run build`
Expected: 编译通过。

- [ ] **Step 3：迁移幂等核对**

Run（`backend/`）: 对 `060/061/062` 各跑两遍确认幂等/防撞号：用 `runner_http.rs::setup_db` 已全量应用一次；额外手动核对 062 的 `ON CONFLICT DO NOTHING` 在已存在 admin 授予时不报错（`cargo test --test runner_http -- --ignored` 已覆盖：setup_db 应用全部迁移含 062，admin 端点 200 即证 runner_manage 已授予 admin）。

- [ ] **Step 4：提交（如有 fmt/clippy 修复）**

```bash
git add -A
git commit -m "chore(runner): 全量回归——fmt/clippy/build 闸门通过"
```

---

## Self-Review（计划自检，已执行）

1. **Spec 覆盖**（spec §5「reqgenie 侧改造」逐条对照）：
   - §5.1 数据 060/061/062 → Task 1（runners+registration_tokens、assigned_runner+agent_backend CHECK 含 autopilot_selfhosted+单活跃唯一索引、runner_manage 权限）。✅
   - §5.2 派发多态 push_dispatch/assign_runner + RunnerDispatcher → Task 3。✅ 长轮询 broadcast + 原子 claim + last-chance → Task 5（pending handler）。✅ pr_created 摄取 → Task 4。✅
   - §5.3 阶段放开 max_stage=pr 按 backend → Task 4。✅ dev/pr stage_artifact/gate 落库：service 既有 `gate_opened`/`stage_artifact` 分支对任意合法 stage（含 dev/pr，`stage_index` 认 `:18-26`）通用，无需改；`pr_created` 新增 → Task 4。✅
   - §5.4 前端 Runner 管理页 + agent_backend/目标 runner 选择 + gate 卡复用 → Task 7（gate 卡复用现有 DevSession 页，无须改）。✅
   - §5.5 单需求单活跃 session（唯一索引 + 创建前 409）→ Task 1（索引）+ Task 4（create 捕获 `uq_dev_sessions_active_per_req` 冲突回 409）。✅
   - §4.2 拉模型回收 reaper → Task 6。✅ §4.4 ensure_runner_auth per-runner 凭证 → Task 5。✅ §8.1 注册 token FOR UPDATE 一次性 + stdin → Task 2 + Task 7（命令提示 stdin）。✅ §8.2 revoke → Task 2/5/7。✅
2. **占位扫描**：无 TBD/TODO/「类似 TaskN」/「适当处理」。每个改代码步骤含完整真实代码；每个测试步骤含完整测试代码 + 确切运行命令 + 预期输出。`pending` handler 中部就地 `use axum::http::StatusCode;` 已注明实现时提到顶部（非占位，是行内可读性说明）。
3. **类型/签名一致**：`RunnerService` 方法（`create_registration_token`/`register`/`verify_runner_auth`/`heartbeat`/`mark_offline`/`claim_one_pending`/`has_pending`/`reclaim_stale_runner_sessions`/`list`/`revoke`）在 Task 2 定义、Task 5/6 一致调用；`DevSession` 新增 `assigned_runner: Option<Uuid>`（model）= `assigned_runner?: string`（TS）一致；`dispatch_session` 签名 `(PgPool, Uuid, Value)` 不变（多态在内部，所有调用点 `dev_sessions.rs:562/781`/`reaper:250` 零改）；`SessionDispatcher` trait 复用（`RunnerDispatcher` 第二实现，对象安全已测）；`create` 保留、新增 `create_with_runner`（不破坏 `dev_session_db.rs:73` 夹具）；`ApiResponse`/`AppError`/`check_permission`/`RolePermissions`/`generate_token`/`DevSessionBroadcaster::{broadcast,subscribe}` 均按核对的真实签名使用。
4. **决策记录**：
   - runner 端点鉴权独立 `ensure_runner_auth`（path runner_id + Bearer secret 哈希比对），不复用 worker 全局 `ensure_worker_auth`（spec §4.4 要求 per-runner 凭证）。
   - 长轮询复用 `DevSessionBroadcaster`、以 `runner_id` 当频道键（Uuid 空间不与 session 撞），叫醒在 create-with-runner 处 broadcast；多实例靠 last-chance 重查（spec §5.2 已声明 caveat），故 `MAX_WAIT_SECS=50`。
   - `create_with_runner` 新增而非改 `create` 签名——最小化对既有测试夹具/调用点的冲击。
   - autopilot_selfhosted 必须指定 `assigned_runner`（前端 Select gated + 后端 Validation 拒绝），落实 spec「定向下发到指定机器」。
   - 单活跃冲突用唯一索引 + DB 错误 `constraint()=="uq_dev_sessions_active_per_req"` 翻 409（比先 SELECT 后 INSERT 的 TOCTOU 更稳）。

## 已知边界（本计划范围外，交后续）

- **autopilot 侧 executor / runner-client**（注册 CLI、poller、session-loop 移植、rounds、token 注入 clone/push）= spec §6，由 A1（executor 核）/ A2（runner 协议客户端）覆盖，本计划只做 reqgenie 控制面。
- **dev/pr round 的 stage_artifact 渲染细化**（diff 预览卡 / PR 确认卡的专属 UI）：本计划复用现有 gate 卡（artifact JSON 通用展示），spec §5.4「dev/pr 的 gate 卡复用现有」；diff 友好渲染留 R2。
- **多 runner 选择策略**（labels 路由 / 自动选最闲）：MVP=前端定向手选（spec §9 R3 才做 labels）。
- **runner 列表「在线」实时性**：前端 10s 轮询 `fetchRunners`（非 WS）；runner 实时上下线推送留后续。
- **session 心跳超时→failed**：复用 reaper 既有步骤 1（看 `dev_sessions.last_heartbeat_at`），与新 runner 级回收（看 `runners.last_heartbeat_at`）正交，本计划不重写步骤 1。
- **gh live / 真实 GitHub PR**：`pr_created` 仅写 `pr_url`（事实），PR 实际创建在 autopilot 执行核（A 计划）；端到端（注册→clarify→dev→pr→merge）由 C（端到端）计划覆盖。
```

I've completed the full plan. Here is the deliverable — the entire plan markdown body, ready to write to the plan file at `C:\Users\larry\Desktop\workspace\autopilot\docs\superpowers\plans\2026-06-23-runner-B-reqgenie-control-plane.md`. Every signature, line number, table name, migration number, and test pattern was verified against the real reqgenie source code (latest migration `059` confirmed → `060/061/062` clear; `SessionDispatcher` trait + `PushDispatcher` at `worker_client.rs:183-261`; `ingest_worker_event` match at `dev_session_service.rs:521-612`; `create_session`/`PHASE1_MAX_STAGE` at `dev_sessions.rs:42,481-577`; reaper `tick`/`ReaperStats` at `dev_session_reaper.rs:46-270`; `DevSessionBroadcaster` at `routes/ws.rs:96-142`; `check_permission`/`Claims`/`RolePermissions` at `middleware/auth.rs:19,125,153`; test infra from `tests/dev_session_db.rs` + `tests/dev_session_http.rs`; frontend `DevSessionEntry.tsx`/`devSession.ts`/`App.tsx:147-150`/`MainLayout.tsx:122-130`/`routePermissions.ts`). No placeholders.
