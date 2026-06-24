# Runner 自助注册 + 归属管理 + Labels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 reqgenie runner 从「仅 admin 注册/管理」放开为「人人自助注册、各管各的、admin 管全部」，并给 runner 加 labels（展示 + 前端筛选，不做后端路由）。

**Architecture:** reqgenie 控制面（Rust+Axum+PG）拆自助/admin 两套端点 + 归属判定 helper + runners 加 `labels text[]`；前端 RunnerManager 自助/admin 双视图 + label 编辑、DevSessionEntry 下发下拉按 label 筛选；autopilot CLI `runner register --label` 把 labels 带进注册 payload。下发机制（assigned_runner 纯点名）零改。

**Tech Stack:** Rust (Axum/sqlx/PostgreSQL)、React + AntD + react-query (reqgenie)；Bun/TypeScript (autopilot)。

## Global Constraints

- **两仓双分支**：reqgenie 改在 `feat/reqgenie-self-hosted-runner-20260623-larry`（ReverseGame 团队仓，分支带 `-larry`）；autopilot 改在 `feat/reqgenie-runner-20260623`。
- **reqgenie 迁移手动管理、绝不在 K8s/生产跑**；迁移用日期格式文件名避撞号（本计划用 `20260624_runner_labels.sql`）。
- **reqgenie commit 闸门**：`cargo +nightly fmt` + `cargo clippy -- -D warnings` 干净；前端改动 `npm run build` 过。
- **reqgenie 角色按 `roles.code` 识别**（非 name）；权限常量 `runner_manage`。
- **commit message 用中文**；catch 用具体类型；TS strict。
- **下发链路（assigned_runner）零改**——既有 runner e2e/smoke 必须仍绿（回归基线）。
- **label 规范**：小写、仅 `[a-z0-9._-]`、单个 ≤32 字符、每 runner ≤16 个；越界返回校验错（400）。
- **本地测试基建**：reqgenie 集成测试需 `ORCH_PG`（无 db 名 base，测试自建库灌迁移）+ `ORCH_REDIS`，`#[ignore]` 门，跑加 `-- --ignored`。本会话已起隔离 PG `127.0.0.1:5433` + Redis `127.0.0.1:6379` 可用（也可另起）。

---

## File Structure

**reqgenie（后端）**
- `backend/migrations/20260624_runner_labels.sql`（新）— runners 加 labels 列。
- `backend/src/models/runner.rs`（改）— `Runner` 加 `labels: Vec<String>`；`RunnerRegisterRequest` 加 `labels`；新增 `RunnerUpdateRequest`。
- `backend/src/services/runner_service.rs`（改）— register 写 labels；`list_runners_by_owner`；`update_runner`；`labels` 校验 `validate_labels`。
- `backend/src/routes/runners.rs`（改）— 自助端点（registration-token/GET/PATCH/DELETE 按归属）+ admin 端点（/admin/runners GET/PATCH/DELETE）+ `can_manage_runner` helper。

**reqgenie（前端）**
- `frontend/src/types/index.ts`（改）— `Runner` 加 `labels?: string[]`。
- `frontend/src/api/runners.ts`（改）— `fetchRunners`（自助）、新增 `fetchAllRunners`（admin）、`updateRunner`（PATCH）、`createRegistrationToken` 路径改 `/runners/registration-token`。
- `frontend/src/pages/RunnerManager.tsx`（改）— labels 列 + 编辑 + 我的/全部视图（admin）。
- `frontend/src/components/DevSessionEntry.tsx`（改）— runner 下拉 label 筛选。

**autopilot**
- `src/daemon/runner/backend.ts`（改）— `HttpRunnerBackend.register` body 加 labels。
- `src/daemon/runner/registration.ts`（改）— `registerRunner` 接收并透传 labels。
- `src/cli/runner.ts`（改）— `register` 加可重复 `--label`。
- 测试：`tests/runner-registration-labels.test.ts`（新，autopilot bun:test）。

**依赖序**：T1→T2→T3（reqgenie 后端）；T4→T5、T6（reqgenie 前端，依赖 T3 端点）；T7→T8（autopilot，依赖 T2 的 payload 字段约定但可并行起草，落测以字段名对齐为准）。

---

## Task 1: 迁移 — runners 加 labels 列

**Files:**
- Create: `backend/migrations/20260624_runner_labels.sql`
- Test: 经 `backend/tests/runner_http.rs` 的 setup_db（灌迁移）间接验证

**Interfaces:**
- Produces: runners 表新增列 `labels text[] NOT NULL DEFAULT '{}'`。

- [ ] **Step 1: 写迁移文件**

```sql
-- 20260624_runner_labels.sql
-- runner 加 labels（展示 + 前端筛选；不做后端路由）。存量行默认空标签。
ALTER TABLE runners ADD COLUMN IF NOT EXISTS labels TEXT[] NOT NULL DEFAULT '{}';
```

- [ ] **Step 2: 灌进隔离库验证列存在**

Run:
```bash
docker exec -i runner-demo-pg psql -U reqgenie -d reqgenie -v ON_ERROR_STOP=1 < backend/migrations/20260624_runner_labels.sql
docker exec runner-demo-pg psql -U reqgenie -d reqgenie -tAc "SELECT data_type FROM information_schema.columns WHERE table_name='runners' AND column_name='labels'"
```
Expected: `ARRAY`（列已加）。

- [ ] **Step 3: Commit**

```bash
git add backend/migrations/20260624_runner_labels.sql
git commit -m "feat(runner): 迁移 runners 加 labels text[] 列"
```

---

## Task 2: 服务层 + 模型 — register 写 labels / 按归属列出 / 更新 / 校验

**Files:**
- Modify: `backend/src/models/runner.rs`
- Modify: `backend/src/services/runner_service.rs`
- Test: `backend/tests/runner_db.rs`（既有 runner 服务级测试，沿用其 setup_db/PgPool 夹具）

**Interfaces:**
- Consumes: 迁移后的 runners.labels 列。
- Produces:
  - `Runner.labels: Vec<String>`（FromRow）。
  - `RunnerRegisterRequest.labels: Vec<String>`（serde default 空）。
  - `RunnerUpdateRequest { name: Option<String>, labels: Option<Vec<String>> }`。
  - `RunnerService::register(db, token, name, machine_meta, labels: &[String]) -> Result<Option<RegisterResult>, _>`（签名加 labels）。
  - `RunnerService::list_runners_by_owner(db, owner_id: Uuid) -> Result<Vec<Runner>, sqlx::Error>`。
  - `RunnerService::update_runner(db, id: Uuid, name: Option<&str>, labels: Option<&[String]>) -> Result<Option<Runner>, sqlx::Error>`。
  - `runner_service::validate_labels(labels: &[String]) -> Result<Vec<String>, AppError>`（规范化 + 上限校验，pub）。

- [ ] **Step 1: 模型加字段**

`backend/src/models/runner.rs`：`Runner` 结构加字段（放 machine_meta 之后，与表列对应）：
```rust
    pub labels: Vec<String>,
```
`RunnerRegisterRequest` 加：
```rust
    #[serde(default)]
    pub labels: Vec<String>,
```
文件末尾追加更新请求体：
```rust
/// 改 runner（自助/admin 复用；字段省略=不动）。
#[derive(Debug, Deserialize)]
pub struct RunnerUpdateRequest {
    pub name: Option<String>,
    pub labels: Option<Vec<String>>,
}
```

- [ ] **Step 2: 写 labels 校验的失败测试**

`backend/tests/runner_db.rs` 末尾加（纯函数测试，无需 DB）：
```rust
#[test]
fn validate_labels_规范与上限() {
    use reqgenie_backend::services::runner_service::validate_labels;
    // 规范化：去空白、转小写
    assert_eq!(validate_labels(&["GPU".into(), " linux ".into()]).unwrap(), vec!["gpu", "linux"]);
    // 非法字符拒
    assert!(validate_labels(&["a b".into()]).is_err());
    // 单个超长拒（>32）
    assert!(validate_labels(&["x".repeat(33)]).is_err());
    // 数量超 16 拒
    let many: Vec<String> = (0..17).map(|i| format!("l{i}")).collect();
    assert!(validate_labels(&many).is_err());
    // 去重
    assert_eq!(validate_labels(&["gpu".into(), "gpu".into()]).unwrap(), vec!["gpu"]);
}
```

- [ ] **Step 3: 跑测试确认编译失败/未定义**

Run: `cd backend && cargo test --test runner_db validate_labels 2>&1 | tail -5`
Expected: 编译失败（`validate_labels` 未定义）。

- [ ] **Step 4: 实现 validate_labels + 服务方法**

`backend/src/services/runner_service.rs`（模块顶层加 pub 函数）：
```rust
/// label 规范化（trim + 小写）+ 校验（字符集/长度/数量），返回去重后的规范列表。
pub fn validate_labels(labels: &[String]) -> Result<Vec<String>, AppError> {
    const MAX_LABELS: usize = 16;
    const MAX_LEN: usize = 32;
    let mut out: Vec<String> = Vec::new();
    for raw in labels {
        let l = raw.trim().to_lowercase();
        if l.is_empty() {
            continue;
        }
        if l.len() > MAX_LEN {
            return Err(AppError::Validation(format!("label 过长（≤{MAX_LEN}）: {l}")));
        }
        if !l.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '_' | '-')) {
            return Err(AppError::Validation(format!("label 仅允许 [a-z0-9._-]: {l}")));
        }
        if !out.contains(&l) {
            out.push(l);
        }
    }
    if out.len() > MAX_LABELS {
        return Err(AppError::Validation(format!("label 数量过多（≤{MAX_LABELS}）")));
    }
    Ok(out)
}
```
在 `RunnerService::register` 的 INSERT 加 labels 列与绑定（签名加 `labels: &[String]`，先 `let labels = validate_labels(labels)?;`）：
```rust
            "INSERT INTO runners
               (name, secret_hash, status, machine_meta, registered_by, last_heartbeat_at, labels)
             VALUES ($1, $2, 'online', $3, $4, NOW(), $5)
             RETURNING *",
```
绑定追加 `.bind(&labels)`（在 created_by 之后）。
新增方法：
```rust
    /// 列出某用户注册的 runner（自助视图）。
    pub async fn list_runners_by_owner(db: &PgPool, owner_id: Uuid) -> Result<Vec<Runner>, sqlx::Error> {
        sqlx::query_as::<_, Runner>(
            "SELECT * FROM runners WHERE registered_by = $1 AND deleted_at IS NULL ORDER BY created_at DESC",
        )
        .bind(owner_id)
        .fetch_all(db)
        .await
    }

    /// 改 runner 的 name/labels（None 字段不动）。返回更新后的行（不存在/已删返回 None）。
    pub async fn update_runner(
        db: &PgPool,
        id: Uuid,
        name: Option<&str>,
        labels: Option<&[String]>,
    ) -> Result<Option<Runner>, sqlx::Error> {
        sqlx::query_as::<_, Runner>(
            "UPDATE runners
                SET name   = COALESCE($2, name),
                    labels = COALESCE($3, labels),
                    updated_at = NOW()
              WHERE id = $1 AND deleted_at IS NULL
              RETURNING *",
        )
        .bind(id)
        .bind(name)
        .bind(labels)
        .fetch_optional(db)
        .await
    }
```
> 注：`Runner` 既有 `list_runners`（admin 全部）与 `register`/`revoke` 调用点需同步改签名（register 调用方在 routes.rs Task 3 改）。`validate_labels` 也用于 update（Task 3 路由层调用）。

- [ ] **Step 5: 跑校验测试 + 全量编译**

Run: `cd backend && cargo test --test runner_db validate_labels 2>&1 | tail -5 && cargo build 2>&1 | tail -3`
Expected: validate_labels 测试 PASS；build 仅在 register 调用点未改签名处报错（Task 3 修）——若此时 routes 已引用旧签名，允许 build 暂红，Task 3 收口。为隔离，本步只断言 `cargo test --test runner_db validate_labels` 通过。

- [ ] **Step 6: Commit**

```bash
git add backend/src/models/runner.rs backend/src/services/runner_service.rs backend/tests/runner_db.rs
git commit -m "feat(runner): 服务层 register 写 labels + 按归属列出/更新 + label 校验"
```

---

## Task 3: 路由 — 自助端点（按归属）+ admin 端点（管全部）

**Files:**
- Modify: `backend/src/routes/runners.rs`
- Test: `backend/tests/runner_http.rs`

**Interfaces:**
- Consumes: T2 的 `list_runners_by_owner` / `update_runner` / `validate_labels` / `RunnerUpdateRequest`；既有 `list_runners`（全部）、`revoke`、`create_registration_token`、`register`。
- Produces 路由（挂载见 Step 4）：
  - `POST /runners/registration-token`（JWT，任何登录用户，created_by=claims.sub）
  - `GET /runners`（JWT，仅自己的）
  - `PATCH /runners/{id}`（JWT，归属校验，改 name/labels）
  - `DELETE /runners/{id}`（JWT，归属校验，revoke）
  - `GET /admin/runners`（JWT + runner_manage，全部）
  - `PATCH /admin/runners/{id}`（JWT + runner_manage，任意）
  - `DELETE /admin/runners/{id}`（JWT + runner_manage，任意）
  - helper `can_manage_runner(registered_by: Option<Uuid>, claims, role_perms) -> bool`

- [ ] **Step 1: 写归属/越权 HTTP 测试（失败）**

`backend/tests/runner_http.rs` 加（沿用文件内 dev_token/admin_token 模式与 seed_developer——若文件无 seed_developer，参照 runner_e2e.rs 的 seed_developer 落真实 developer 再发 token）：
```rust
#[tokio::test]
#[ignore]
async fn 自助注册与归属隔离() {
    let pool = setup_db().await;            // 文件内既有夹具
    let state = build_state(pool.clone()).await;
    let server = TestServer::new(routes_app(state)).unwrap();

    // 两个真实 developer（developer 角色，非 admin）
    let alice = seed_developer(&pool, "developer", "alice").await;
    let bob = seed_developer(&pool, "developer", "bob").await;
    let alice_tok = dev_token(alice);
    let bob_tok = dev_token(bob);

    // 自助生成令牌（无需 runner_manage）→ 200
    let t: Value = server.post("/api/runners/registration-token")
        .authorization_bearer(&alice_tok).json(&json!({"ttl_minutes":15})).await.json();
    let reg = t["data"]["token"].as_str().expect("注册令牌").to_string();

    // 用令牌注册 runner（带 labels）→ runner 归属 alice
    let r: Value = server.post("/api/runners/register")
        .json(&json!({"token": reg, "name":"alice-pc", "labels":["gpu","linux"]})).await.json();
    let rid = r["data"]["runner_id"].as_str().unwrap().to_string();

    // alice 列表含自己的，bob 列表不含
    let la: Value = server.get("/api/runners").authorization_bearer(&alice_tok).await.json();
    assert_eq!(la["data"].as_array().unwrap().len(), 1, "alice 应见自己的: {la}");
    let lb: Value = server.get("/api/runners").authorization_bearer(&bob_tok).await.json();
    assert_eq!(lb["data"].as_array().unwrap().len(), 0, "bob 不应见 alice 的: {lb}");

    // bob 改/删 alice 的 runner → 403/404
    let patch = server.patch(&format!("/api/runners/{rid}")).authorization_bearer(&bob_tok)
        .json(&json!({"labels":["x"]})).await;
    assert!(patch.status_code().is_client_error(), "bob 越权改应被拒");

    // alice 改自己的 labels → 200 且生效
    let pa: Value = server.patch(&format!("/api/runners/{rid}")).authorization_bearer(&alice_tok)
        .json(&json!({"labels":["windows"]})).await.json();
    assert_eq!(pa["data"]["labels"][0], "windows", "改 label 应生效: {pa}");
}

#[tokio::test]
#[ignore]
async fn admin_管全部() {
    let pool = setup_db().await;
    let state = build_state(pool.clone()).await;
    let server = TestServer::new(routes_app(state)).unwrap();
    let alice = seed_developer(&pool, "developer", "alice2").await;
    let admin = seed_developer(&pool, "admin", "admin2").await;
    let alice_tok = dev_token(alice);
    let admin_tok = dev_token(admin);

    // alice 注册一台
    let t: Value = server.post("/api/runners/registration-token").authorization_bearer(&alice_tok)
        .json(&json!({"ttl_minutes":15})).await.json();
    let reg = t["data"]["token"].as_str().unwrap().to_string();
    let r: Value = server.post("/api/runners/register")
        .json(&json!({"token": reg, "name":"a"})).await.json();
    let rid = r["data"]["runner_id"].as_str().unwrap().to_string();

    // admin /admin/runners 看到 alice 的
    let all: Value = server.get("/api/admin/runners").authorization_bearer(&admin_tok).await.json();
    assert!(all["data"].as_array().unwrap().iter().any(|x| x["id"]==rid), "admin 应见全部: {all}");
    // admin 删 alice 的 → 200
    let del = server.delete(&format!("/api/admin/runners/{rid}")).authorization_bearer(&admin_tok).await;
    assert!(del.status_code().is_success(), "admin 应能删任意 runner");
}
```
> 测试里的 `dev_token(id)`/`seed_developer(pool, role, name)`/`build_state`/`routes_app`/`setup_db` 用 runner_http.rs 既有同名夹具；若签名不同按文件实际调整（这是测试夹具适配，非逻辑改动）。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && ORCH_PG="postgresql://reqgenie:reqgenie@127.0.0.1:5433" ORCH_REDIS="redis://127.0.0.1:6379" cargo test --test runner_http 自助注册与归属隔离 -- --ignored --nocapture 2>&1 | tail -15`
Expected: FAIL（路由 404 或注册令牌端点要 runner_manage → 现状仅 admin）。

- [ ] **Step 3: 实现 helper + 自助/admin handler**

`backend/src/routes/runners.rs`：
归属判定 helper：
```rust
/// 某 runner 是否可被当前用户管理：本人注册的，或持 runner_manage（admin）。
fn can_manage_runner(registered_by: Option<Uuid>, claims: &Claims, role_perms: &RolePermissions) -> bool {
    if check_permission(claims, role_perms, RUNNER_MANAGE).is_ok() {
        return true;
    }
    match (registered_by, Uuid::parse_str(&claims.sub).ok()) {
        (Some(owner), Some(me)) => owner == me,
        _ => false,
    }
}
```
create_token 去掉 runner_manage 检查（改为任何登录用户；created_by 仍 claims.sub）：
```rust
async fn create_token(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Json(req): Json<CreateTokenRequest>,
) -> Result<Json<ApiResponse<TokenResponse>>, AppError> {
    let created_by = Uuid::parse_str(&claims.sub).ok();
    let token = RunnerService::create_registration_token(&state.db, created_by, req.ttl_minutes).await?;
    Ok(ApiResponse::ok(TokenResponse { token }))
}
```
自助列表（仅自己的）：
```rust
async fn list_my_runners(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
) -> Result<Json<ApiResponse<Vec<Runner>>>, AppError> {
    let me = Uuid::parse_str(&claims.sub).map_err(|_| AppError::Unauthorized)?;
    Ok(ApiResponse::ok(RunnerService::list_runners_by_owner(&state.db, me).await?))
}
```
自助改（归属校验）：
```rust
async fn update_my_runner(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Extension(role_perms): Extension<RolePermissions>,
    Path(id): Path<Uuid>,
    Json(req): Json<RunnerUpdateRequest>,
) -> Result<Json<ApiResponse<Runner>>, AppError> {
    let existing = RunnerService::get(&state.db, id).await?.ok_or(AppError::NotFound("runner 不存在".into()))?;
    if !can_manage_runner(existing.registered_by, &claims, &role_perms) {
        return Err(AppError::Forbidden("无权管理该 runner".into()));
    }
    let labels = match req.labels.as_ref() {
        Some(ls) => Some(crate::services::runner_service::validate_labels(ls)?),
        None => None,
    };
    let updated = RunnerService::update_runner(&state.db, id, req.name.as_deref(), labels.as_deref()).await?
        .ok_or(AppError::NotFound("runner 不存在".into()))?;
    Ok(ApiResponse::ok(updated))
}
```
自助删（归属校验）：
```rust
async fn revoke_my_runner(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Extension(role_perms): Extension<RolePermissions>,
    Path(id): Path<Uuid>,
) -> Result<Json<ApiResponse<()>>, AppError> {
    let existing = RunnerService::get(&state.db, id).await?.ok_or(AppError::NotFound("runner 不存在".into()))?;
    if !can_manage_runner(existing.registered_by, &claims, &role_perms) {
        return Err(AppError::Forbidden("无权管理该 runner".into()));
    }
    RunnerService::revoke(&state.db, id).await?;
    Ok(ApiResponse::ok(()))
}
```
admin 端（管全部，沿用 runner_manage）：
```rust
async fn admin_list_runners(
    State(state): State<AppState>, Extension(claims): Extension<Claims>, Extension(role_perms): Extension<RolePermissions>,
) -> Result<Json<ApiResponse<Vec<Runner>>>, AppError> {
    check_permission(&claims, &role_perms, RUNNER_MANAGE)?;
    Ok(ApiResponse::ok(RunnerService::list_runners(&state.db).await?))
}
async fn admin_update_runner(
    State(state): State<AppState>, Extension(claims): Extension<Claims>, Extension(role_perms): Extension<RolePermissions>,
    Path(id): Path<Uuid>, Json(req): Json<RunnerUpdateRequest>,
) -> Result<Json<ApiResponse<Runner>>, AppError> {
    check_permission(&claims, &role_perms, RUNNER_MANAGE)?;
    let labels = match req.labels.as_ref() { Some(ls) => Some(crate::services::runner_service::validate_labels(ls)?), None => None };
    let updated = RunnerService::update_runner(&state.db, id, req.name.as_deref(), labels.as_deref()).await?
        .ok_or(AppError::NotFound("runner 不存在".into()))?;
    Ok(ApiResponse::ok(updated))
}
async fn admin_revoke_runner(
    State(state): State<AppState>, Extension(claims): Extension<Claims>, Extension(role_perms): Extension<RolePermissions>,
    Path(id): Path<Uuid>,
) -> Result<Json<ApiResponse<()>>, AppError> {
    check_permission(&claims, &role_perms, RUNNER_MANAGE)?;
    RunnerService::revoke(&state.db, id).await?;
    Ok(ApiResponse::ok(()))
}
```
> 若 `RunnerService::get(db, id)` 不存在，加一个 `pub async fn get(db, id) -> Result<Option<Runner>, sqlx::Error>`（`SELECT * FROM runners WHERE id=$1`，含已删——归属判定需要读到行；或 `AND deleted_at IS NULL` 视语义，删已删返回 NotFound 也可接受）。register handler 调用同步改为传 `&req.labels`。

- [ ] **Step 4: 改路由挂载**

`admin_router`（实为 JWT 段，handler 自查权限）改为：
```rust
pub fn admin_router(state: AppState) -> Router {
    Router::new()
        // 自助（任何登录用户；handler 内按归属过滤/校验）
        .route("/runners/registration-token", post(create_token))
        .route("/runners", get(list_my_runners))
        .route("/runners/{id}", patch(update_my_runner).delete(revoke_my_runner))
        // admin（handler 内查 runner_manage）
        .route("/admin/runners", get(admin_list_runners))
        .route("/admin/runners/{id}", patch(admin_update_runner).delete(admin_revoke_runner))
        .with_state(state)
}
```
顶部 `use axum::routing::{delete, get, patch, post};`（补 patch）。删除旧 `/admin/runners/registration-token` 路由与（如无其他引用的）旧 `list_runners`/`revoke_runner` handler；保留 `RunnerService::list_runners`（admin 用）与 `revoke`（两端用）。

- [ ] **Step 5: 跑测试 + fmt + clippy**

Run:
```bash
cd backend && ORCH_PG="postgresql://reqgenie:reqgenie@127.0.0.1:5433" ORCH_REDIS="redis://127.0.0.1:6379" \
  cargo test --test runner_http -- --ignored 2>&1 | tail -15 && cargo +nightly fmt && cargo clippy -- -D warnings 2>&1 | tail -3
```
Expected: 新两测 PASS；既有 runner_http/runner_e2e 仍 PASS（回归）；fmt/clippy 净。

- [ ] **Step 6: Commit**

```bash
git add backend/src/routes/runners.rs backend/tests/runner_http.rs backend/src/services/runner_service.rs
git commit -m "feat(runner): 拆自助/admin 端点——人人自注册+各管各的(归属校验)+admin管全部"
```

---

## Task 4: 前端 api 客户端 + Runner 类型（labels / admin / PATCH）

**Files:**
- Modify: `frontend/src/types/index.ts:240-249`
- Modify: `frontend/src/api/runners.ts`

**Interfaces:**
- Consumes: T3 端点。
- Produces：`fetchRunners()`（GET /runners 自己的）、`fetchAllRunners()`（GET /admin/runners）、`updateRunner(id, {name?, labels?})`（PATCH /runners/{id}）、`updateRunnerAsAdmin(id, body)`（PATCH /admin/runners/{id}）、`createRegistrationToken`（路径 `/runners/registration-token`）、`Runner.labels?: string[]`。

- [ ] **Step 1: 类型加 labels**

`frontend/src/types/index.ts` 的 `Runner` 接口 `machine_meta` 行后加：
```ts
  labels?: string[]
```

- [ ] **Step 2: 改/加 api 方法**

`frontend/src/api/runners.ts` 全量改为：
```ts
import apiClient from './client'
import type { ApiResponse, Runner } from '../types'

/** 列出「我注册的」runner（任何登录用户） */
export async function fetchRunners() {
  const { data } = await apiClient.get<ApiResponse<Runner[]>>('/runners')
  return data.data!
}

/** 列出全部 runner（admin，runner_manage） */
export async function fetchAllRunners() {
  const { data } = await apiClient.get<ApiResponse<Runner[]>>('/admin/runners')
  return data.data!
}

/** 生成一次性注册 token（任何登录用户），返回明文 token（仅此一次展示） */
export async function createRegistrationToken(ttlMinutes = 15) {
  const { data } = await apiClient.post<ApiResponse<{ token: string }>>(
    '/runners/registration-token',
    { ttl_minutes: ttlMinutes },
  )
  return data.data!.token
}

/** 改自己 runner 的 name/labels */
export async function updateRunner(id: string, body: { name?: string; labels?: string[] }) {
  const { data } = await apiClient.patch<ApiResponse<Runner>>(`/runners/${id}`, body)
  return data.data!
}

/** admin 改任意 runner */
export async function updateRunnerAsAdmin(id: string, body: { name?: string; labels?: string[] }) {
  const { data } = await apiClient.patch<ApiResponse<Runner>>(`/admin/runners/${id}`, body)
  return data.data!
}

/** revoke 自己的 runner */
export async function revokeRunner(id: string) {
  const { data } = await apiClient.delete<ApiResponse<null>>(`/runners/${id}`)
  return data.data
}

/** admin revoke 任意 runner */
export async function revokeRunnerAsAdmin(id: string) {
  const { data } = await apiClient.delete<ApiResponse<null>>(`/admin/runners/${id}`)
  return data.data
}
```

- [ ] **Step 3: 类型检查**

Run: `cd frontend && npx tsc -b --noEmit 2>&1 | tail -5`
Expected: 无错误（RunnerManager 仍引用旧符号则在 T5 改；如本步因 RunnerManager 未更新报错，允许在 T5 收口，本步只断言 api/types 本身无语法错——可临时 `npm run build` 跳过或先做 T5）。

- [ ] **Step 4: Commit**

```bash
git add frontend/src/types/index.ts frontend/src/api/runners.ts
git commit -m "feat(runner): 前端 api 加 labels/admin 全量/PATCH，注册令牌路径改自助"
```

---

## Task 5: 前端 RunnerManager — labels 列 + 编辑 + 我的/全部视图

**Files:**
- Modify: `frontend/src/pages/RunnerManager.tsx`
- 读取当前用户角色：复用 `localStorage.getItem('reqgenie_user_info')` 的 `role_codes`（main.tsx/Login 存）判断是否 admin。

**Interfaces:**
- Consumes: T4 api（fetchRunners/fetchAllRunners/updateRunner/updateRunnerAsAdmin/createRegistrationToken/revokeRunner/revokeRunnerAsAdmin）、`Runner.labels`。

- [ ] **Step 1: 加 admin 判定 + 视图切换 state**

`RunnerManager.tsx` 顶部 import 改：
```ts
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Button, Card, Table, Tag, Modal, Popconfirm, Typography, message, Segmented, Select } from 'antd'
import { PlusOutlined, CopyOutlined } from '@ant-design/icons'
import {
  fetchRunners, fetchAllRunners, createRegistrationToken,
  revokeRunner, revokeRunnerAsAdmin, updateRunner, updateRunnerAsAdmin,
} from '../api/runners'
import type { Runner } from '../types'

function isAdmin(): boolean {
  try {
    const u = JSON.parse(localStorage.getItem('reqgenie_user_info') ?? '{}')
    return Array.isArray(u.role_codes) && u.role_codes.includes('admin')
  } catch {
    return false
  }
}
```

- [ ] **Step 2: 组件内按视图取数 + labels 编辑 mutation**

`export default function RunnerManager()` 体内 `const [token,...]` 后加：
```ts
  const admin = isAdmin()
  const [scope, setScope] = useState<'mine' | 'all'>('mine')
  const viewingAll = admin && scope === 'all'

  const { data: runners, isLoading } = useQuery({
    queryKey: ['runners', viewingAll ? 'all' : 'mine'],
    queryFn: () => (viewingAll ? fetchAllRunners() : fetchRunners()),
    refetchInterval: 10000,
  })

  const labelMut = useMutation({
    mutationFn: ({ id, labels }: { id: string; labels: string[] }) =>
      viewingAll ? updateRunnerAsAdmin(id, { labels }) : updateRunner(id, { labels }),
    onSuccess: () => { message.success('已更新 label'); qc.invalidateQueries({ queryKey: ['runners'] }) },
    onError: () => message.error('更新 label 失败'),
  })
```
并把 revokeMut 的 mutationFn 改为按视图选 admin/自助：
```ts
  const revokeMut = useMutation({
    mutationFn: (id: string) => (viewingAll ? revokeRunnerAsAdmin(id) : revokeRunner(id)),
    onSuccess: () => { message.success('已 revoke'); qc.invalidateQueries({ queryKey: ['runners'] }) },
    onError: () => message.error('revoke 失败'),
  })
```

- [ ] **Step 3: Card 加视图切换 + 表格加 labels 列**

Card 的 `extra` 改为同时含视图切换（仅 admin）与生成按钮：
```tsx
      extra={
        <div style={{ display: 'flex', gap: 8 }}>
          {admin && (
            <Segmented
              value={scope}
              onChange={(v) => setScope(v as 'mine' | 'all')}
              options={[{ label: '我的', value: 'mine' }, { label: '全部', value: 'all' }]}
            />
          )}
          <Button type="primary" icon={<PlusOutlined />} loading={genMut.isPending} onClick={() => genMut.mutate()}>
            生成注册 Token
          </Button>
        </div>
      }
```
columns 在「状态」后加 labels 列（可编辑 tags）：
```tsx
          {
            title: '标签',
            dataIndex: 'labels',
            render: (labels: string[] | undefined, r) => (
              <Select
                mode="tags"
                size="small"
                style={{ minWidth: 180 }}
                value={labels ?? []}
                placeholder="加标签"
                tokenSeparators={[',', ' ']}
                onChange={(vals) => labelMut.mutate({ id: r.id, labels: vals as string[] })}
              />
            ),
          },
```
admin「全部」视图下加「注册人」列（在操作前）：
```tsx
          ...(viewingAll
            ? [{ title: '注册人', dataIndex: 'registered_by', render: (v?: string | null) => v ?? '—' }]
            : []),
```

- [ ] **Step 4: 构建验证**

Run: `cd frontend && npm run build 2>&1 | tail -8`
Expected: build 成功（tsc + vite 无错）。

- [ ] **Step 5: 手动冒烟（可选，本会话 demo 栈在跑）**

浏览器 `http://localhost:3000/admin/runners`：普通登录只见「我的」+ 可加 label；admin 见「我的/全部」切换、全部视图有注册人列、可改任意 label。

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/RunnerManager.tsx
git commit -m "feat(runner): RunnerManager 加 labels 编辑 + admin 我的/全部视图"
```

---

## Task 6: 前端 DevSessionEntry — 下发选机器按 label 筛选

**Files:**
- Modify: `frontend/src/components/DevSessionEntry.tsx`

**Interfaces:**
- Consumes: `fetchRunners`（既有 import，line 8）、`Runner.labels`。下发仍传 `assigned_runner`（不改）。

- [ ] **Step 1: 加 label 筛选 state + 计算可选 label 集**

在组件内（runner 列表已由 fetchRunners 取得处）加：
```ts
  const [labelFilter, setLabelFilter] = useState<string[]>([])
  const allLabels = Array.from(
    new Set((runners ?? []).flatMap((r) => r.labels ?? [])),
  ).sort()
  const filteredRunners = (runners ?? []).filter(
    (r) => labelFilter.length === 0 || labelFilter.every((l) => (r.labels ?? []).includes(l)),
  )
```
> `runners` 变量名/取数 hook 按文件实际（line 8 `fetchRunners` 已 import；若尚无 useQuery 取 runner，加 `const { data: runners } = useQuery({ queryKey:['runners','dispatch'], queryFn: fetchRunners })`）。

- [ ] **Step 2: 渲染 label 筛选器 + runner 下拉用 filteredRunners**

在「目标 runner」Select 上方加筛选器，并把 runner Select 的 options 源改为 `filteredRunners`，每项展示 label：
```tsx
  {allLabels.length > 0 && (
    <Select
      mode="multiple"
      allowClear
      size="small"
      style={{ width: '100%', marginBottom: 8 }}
      placeholder="按标签筛选 runner"
      value={labelFilter}
      onChange={setLabelFilter}
      options={allLabels.map((l) => ({ label: l, value: l }))}
    />
  )}
```
runner 下拉 options（点名不变，仅展示 label 辅助）：
```tsx
  options={filteredRunners.map((r) => ({
    value: r.id,
    label: `${r.name}${r.labels?.length ? ` [${r.labels.join(', ')}]` : ''}${r.status === 'online' ? '' : '（离线）'}`,
    disabled: r.status !== 'online',
  }))}
```

- [ ] **Step 3: 构建验证**

Run: `cd frontend && npm run build 2>&1 | tail -8`
Expected: build 成功。

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/DevSessionEntry.tsx
git commit -m "feat(runner): 下发选机器支持按 label 筛选 + 下拉展示 label（点名不变）"
```

---

## Task 7: autopilot — register payload 带 labels

**Files:**
- Modify: `src/daemon/runner/backend.ts`
- Modify: `src/daemon/runner/registration.ts`
- Test: `tests/runner-registration-labels.test.ts`（新）

**Interfaces:**
- Consumes: reqgenie `RunnerRegisterRequest{token,name,machine_meta,labels}`（T2）。
- Produces: `HttpRunnerBackend.register(url, {token,name,machine_meta,labels})` body 含 `labels: string[]`；`registerRunner({url,name,labels?,readToken})` 透传 labels。

- [ ] **Step 1: 写 register body 含 labels 的失败测试**

`tests/runner-registration-labels.test.ts`：
```ts
import { test, expect } from "bun:test";
import { HttpRunnerBackend } from "../src/daemon/runner/backend";

test("register body 携带 labels", async () => {
  let captured: any = null;
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: any) => {
    captured = JSON.parse(init.body);
    return new Response(JSON.stringify({ data: { runner_id: "r1", secret: "s1" } }), { status: 200 });
  }) as any;
  try {
    await HttpRunnerBackend.register("http://cp.test", {
      token: "tok", name: "pc", machine_meta: {}, labels: ["gpu", "linux"],
    });
  } finally {
    globalThis.fetch = origFetch;
  }
  expect(captured.labels).toEqual(["gpu", "linux"]);
  expect(captured.name).toBe("pc");
});
```
> `HttpRunnerBackend.register` 的实参形态按文件实际（之前实现为静态方法发 body `{token,name,machine_meta}`）；测试以「body 含 labels」为断言，必要时按真实签名调整调用形态。

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/runner-registration-labels.test.ts 2>&1 | tail -8`
Expected: FAIL（captured.labels 为 undefined）。

- [ ] **Step 3: backend.ts register body 加 labels**

`src/daemon/runner/backend.ts` 的 `register` 静态方法：入参类型加 `labels?: string[]`，构造 body 时加 `labels: input.labels ?? []`（字段名 `labels`，与 reqgenie serde 对齐）。

- [ ] **Step 4: registration.ts 透传 labels**

`src/daemon/runner/registration.ts` 的 `RegisterInput` 加 `labels?: string[]`；`registerRunner` 调 `HttpRunnerBackend.register(url, { token, name, machine_meta, labels: input.labels })`。

- [ ] **Step 5: 跑测试 + 类型检查**

Run: `bun test tests/runner-registration-labels.test.ts 2>&1 | tail -6 && bun run typecheck 2>&1 | tail -3`
Expected: PASS；typecheck 净。

- [ ] **Step 6: Commit**

```bash
git add src/daemon/runner/backend.ts src/daemon/runner/registration.ts tests/runner-registration-labels.test.ts
git commit -m "feat(runner): register payload 带 labels（与 reqgenie RunnerRegisterRequest 对齐）"
```

---

## Task 8: autopilot CLI — runner register --label

**Files:**
- Modify: `src/cli/runner.ts:36-44`
- Test: `tests/runner-registration-labels.test.ts`（追加 CLI 解析断言，或在 register 命令 action 中抽一个可测的 label 收集函数）

**Interfaces:**
- Consumes: `registerRunner({url,name,labels,readToken})`（T7）。
- Produces: CLI `register` 支持可重复 `--label <label>`，收集为 `string[]` 传入 registerRunner。

- [ ] **Step 1: 写 label 收集的失败测试**

`tests/runner-registration-labels.test.ts` 追加（测可重复 collect 收集器——把收集函数 export 出来测纯逻辑）：
```ts
import { collectLabel } from "../src/cli/runner";

test("collectLabel 累积可重复 --label", () => {
  let acc: string[] = [];
  acc = collectLabel("gpu", acc);
  acc = collectLabel("linux", acc);
  expect(acc).toEqual(["gpu", "linux"]);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/runner-registration-labels.test.ts 2>&1 | tail -6`
Expected: FAIL（collectLabel 未导出）。

- [ ] **Step 3: CLI 加 --label option**

`src/cli/runner.ts`：导出收集器 + 在 register 命令加 option：
```ts
export function collectLabel(value: string, previous: string[]): string[] {
  return [...previous, value];
}
```
register 命令链（line 36-42 区域）加：
```ts
    .option("--label <label>", "runner 标签（可重复，如 --label gpu --label linux）", collectLabel, [])
```
action 里把 `opts.label`（数组）传入：
```ts
        const creds = await registerRunner({ url: opts.url, name: opts.name, labels: opts.label, readToken: readTokenFromStdin });
```

- [ ] **Step 4: 跑测试 + typecheck**

Run: `bun test tests/runner-registration-labels.test.ts 2>&1 | tail -6 && bun run typecheck 2>&1 | tail -3`
Expected: PASS；typecheck 净。

- [ ] **Step 5: 全量回归（autopilot）**

Run: `bun test 2>&1 | tail -8`
Expected: 全绿（含既有 runner-smoke 等，下发链路未动）。

- [ ] **Step 6: Commit**

```bash
git add src/cli/runner.ts tests/runner-registration-labels.test.ts
git commit -m "feat(runner): CLI runner register 加可重复 --label"
```

---

## Self-Review

**Spec coverage（spec §2 四目标 + §5/§6）**：
- 人人自助注册 → T3（create_token 去 runner_manage）✓
- 各管各的 → T2（list_runners_by_owner）+ T3（归属校验 can_manage_runner）+ T5（我的视图）✓
- admin 管全部 → T3（/admin/runners）+ T5（全部视图）✓
- labels：列 T1 / 服务 T2 / 校验 T2 / 注册自带 T7+T8 / 管理页可改 T5 / 下发筛选 T6 ✓
- 下发不变 → 全程未碰 assigned_runner/claim；T8 Step5 全量回归守 ✓

**Placeholder scan**：无 TBD/TODO；每个代码步给了完整代码。少数「按文件实际夹具/签名调整」是测试夹具适配说明（runner_http.rs 既有 dev_token/seed_developer、DevSessionEntry 既有 runner 取数 hook），非逻辑占位。

**Type consistency**：`validate_labels`（T2 定义，T3 调用）、`list_runners_by_owner`/`update_runner`/`RunnerUpdateRequest`（T2→T3）、`Runner.labels`（T1 列→T2 Rust 字段→T4 TS 字段→T5/T6 用）、api 方法名（T4 定义→T5/T6 用）、`registerRunner` labels 入参（T7→T8）、`collectLabel`（T8 定义+测）一致。

**回归基线**：reqgenie `cargo test --test runner_e2e/runner_http -- --ignored` + autopilot `bun test`（runner-smoke）每仓收口处跑。
