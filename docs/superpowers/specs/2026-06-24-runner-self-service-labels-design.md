# Runner 自助注册 + 归属管理 + Labels 设计

> 在已落地的「autopilot 作 reqgenie 自托管 runner」（spec `2026-06-23-reqgenie-runner-design.md`）之上扩展：
> 把 runner 注册/管理从「仅 admin」放开为「人人自助、各管各的、admin 管全部」，并给 runner 加 labels（展示 + 筛选，不做后端路由）。
> 日期：2026-06-24 · 状态：设计待审

## 1. 背景与现状

已实现的 runner 系统（reqgenie 控制面 + autopilot 自托管执行器）当前：
- **runners 表**（reqgenie）：`id, name, secret_hash, status, machine_meta, registered_by, last_heartbeat_at, created_at, updated_at, deleted_at`。**无 labels 列**。
- **归属链已通**：`RunnerService::register` 把 `runner.registered_by` 设为注册令牌的 `created_by`（`runner_service.rs` register：读 `registration_tokens.created_by` → INSERT runner `registered_by=created_by`）。谁生成令牌，runner 就归谁。
- **权限现状（全部仅 admin）**：`runners.rs` 的 `create_token`（生成注册令牌）/ `list_runners` / `revoke_runner` 三个端点都 `check_permission(RUNNER_MANAGE)`，挂在 `/admin/runners/*`。普通用户无法注册/管理。
- **下发**：纯点名 `assigned_runner`（pick 具体 runner），claim 按 `assigned_runner` 匹配——**本设计不改**。

## 2. 目标（用户需求 4 条）

1. **人人自助注册** runner（不只是 admin）。
2. **各管各的**：用户管理（列出/撤销/改 label）自己注册的 runner。
3. **admin 管全部**：admin 可管理所有人的 runner。
4. **labels**：runner 加标签，用于**展示 + 在列表/下发选机器时筛选**。

## 3. 核心决策（已与用户对齐）

| 编号 | 决策 | 说明 |
|------|------|------|
| **D1 自助注册** | 任何登录用户都能生成注册令牌 | 去掉令牌生成的 `runner_manage` 限制；令牌 `created_by=claims.sub` → 注册出的 runner `registered_by=自己`（归属链已通，无需改 register 服务的归属逻辑）。 |
| **D2 归属管理** | 用户只能管自己注册的 runner | 自助端点按 `registered_by=claims.sub` 过滤/校验：列出只列自己的、撤销/改 label 仅限自己的。 |
| **D3 admin 管全部** | `runner_manage` = 管全部 | 有 `runner_manage` 的用户看到/撤销/改**所有** runner。归属判定：`runner 可被 U 操作 ⟺ registered_by==U 或 U 有 runner_manage`。 |
| **D4 labels = 展示+筛选** | 不做后端路由 | runners 加 `labels`；注册时自带 + 管理页可改（**两者都要**）；Web 列表展示 chips、下发选机器按 label **前端筛选**。**后端下发逻辑不变**（纯点名 assigned_runner）。 |
| **D5 下发不变** | assigned_runner 纯点名 | claim/协议/wire 全不动，零回归。label 只是帮人找对机器。 |

## 4. 数据模型

**迁移（reqgenie，日期格式 `20260624_*.sql`，避撞号）**：
```sql
ALTER TABLE runners ADD COLUMN labels TEXT[] NOT NULL DEFAULT '{}';
```
- `text[]`：标签是字符串列表，Postgres 原生数组，便于读写 + 将来若要筛选有 `&&`/`@>` 操作符。
- `NOT NULL DEFAULT '{}'`：存量 runner 默认空标签，无需回填。
- label 规范：小写、`[a-z0-9._-]`、单个 ≤32 字符、每 runner ≤16 个（服务层校验，越界 400）。

## 5. reqgenie 侧改造

### 5.1 路由拆分（runners.rs）—— 自助端点 + admin 端点并存
**自助端点（JWT，任何登录用户，按归属过滤）**：
| 方法 | 路径 | 行为 |
|------|------|------|
| `POST` | `/api/runners/registration-token` | 生成注册令牌（`created_by=claims.sub`）。**无 `runner_manage` 要求**。 |
| `GET` | `/api/runners` | 列出 `registered_by=claims.sub` 的 runner（仅自己的）。 |
| `PATCH` | `/api/runners/{id}` | 改自己 runner 的 `labels`（和 `name`）。归属校验：`registered_by==claims.sub` 否则 403/404。 |
| `DELETE` | `/api/runners/{id}` | 撤销自己的 runner（归属校验同上）。 |

**admin 端点（JWT + `runner_manage`，管全部）**：
| 方法 | 路径 | 行为 |
|------|------|------|
| `GET` | `/api/admin/runners` | 列出**所有** runner（含 registered_by 展示）。 |
| `PATCH` | `/api/admin/runners/{id}` | 改任意 runner 的 labels/name。 |
| `DELETE` | `/api/admin/runners/{id}` | 撤销任意 runner。 |

> 现有 `/admin/runners/registration-token` 保留（admin 也能生成）；自助 `/runners/registration-token` 新增。或统一为一个 `/runners/registration-token`（任何登录用户），admin 版退役——**采用后者**（一个端点，任何登录用户都能生成，最简）。
> 归属判定抽一个 helper：`fn can_manage_runner(runner.registered_by, claims) -> bool { registered_by == claims.sub || has_perm(claims, runner_manage) }`，自助/admin 端点复用。

### 5.2 服务层（runner_service.rs）
- `register`：INSERT runner 时**接收并写入 labels**（payload 带 labels；签名加 `labels: Vec<String>`，默认空）。归属逻辑（registered_by=created_by）不变。
- 新增 `list_runners_by_owner(owner_id)`（自助）+ 既有 `list_runners`（admin 全部）。
- 新增 `update_runner_labels(id, labels)` + 撤销/改名带归属校验（或归属校验在路由层，服务层提供按 id 操作）。
- labels 校验（规范/数量上限）在服务层，越界返回校验错。

### 5.3 前端（RunnerManager.tsx + DevSessionEntry.tsx）
- **RunnerManager**：
  - 普通用户：只「我的 Runner」列表（GET /api/runners）。
  - admin：多一个「全部」视图切换（GET /api/admin/runners），行展示 registered_by（注册人）。
  - 每行：label chips + 编辑（加/删 label，PATCH）+ 撤销。顶部「生成注册令牌」（任何人可点）。
  - label 编辑用 AntD `Select mode=tags` 或 chips 输入，符合既有 AntD 风格。
- **DevSessionEntry（下发选机器）**：runner 下拉展示 label + **按 label 前端筛选**（选机器仍是点名，筛选只帮找）。后端下发不变。

## 6. autopilot 侧改造

- **CLI**：`autopilot runner register --label gpu --label linux`（可多次）→ register payload 带 `labels: string[]`。`src/daemon/runner/registration.ts` + CLI 参数。
- **backend.ts**：`register` 静态方法的 body 加 `labels`（与 reqgenie `RunnerRegisterRequest{token,name,machine_meta,labels}` 对齐）。
- 注：autopilot 侧只「自带 labels 注册」；管理/改 label 在 reqgenie Web（控制面）。

## 7. 三端覆盖
- **Web（reqgenie，一等）**：自助/admin 双视图 + label 编辑 + 下发筛选——主战场，全做。
- **CLI（autopilot，一等）**：`runner register --label`——注册自带 labels。
- **TUI**：observer，不涉及。

## 8. 安全
- 自助令牌生成：任何登录用户可生成（令牌仍一次性、短时效、哈希存储、防重放——既有机制不变）；令牌 `created_by` 决定 runner 归属。
- 归属隔离：用户只能列/改/撤自己的 runner（`registered_by` 校验）；admin 经 `runner_manage` 越权管全部。防越权改/撤他人 runner（PATCH/DELETE 归属校验，非自己且非 admin → 403）。
- 共享池语义不变：下发仍纯点名；label 是展示/筛选，不改变「谁的活落到谁机器」（点名即明确，沿用既有 assigned_runner 安全模型）。
- labels 输入校验（规范化 + 数量上限）防注入/滥用。

## 9. 范围
**单一特性，一个 spec**（不需拆）。改动：reqgenie 迁移 + 路由拆分 + 服务层 + 前端两处；autopilot CLI + register payload。下发机制零改、协议零改（label 不上 wire 的 dispatch 路径）。

## 10. 测试要点
- reqgenie：归属过滤（自助列表只含自己的）；越权 PATCH/DELETE 他人 runner → 403；admin 端点列/改/撤全部；register 写入 labels；labels 校验（越界拒）；自助令牌生成无需 runner_manage。
- autopilot：`runner register --label` 解析多个 label 进 payload；backend.register body 含 labels 与 reqgenie 字段对齐。
- 前端：我的/全部视图切换（admin 才有全部）；label 编辑 PATCH；下发下拉 label 筛选。
- 回归：下发（assigned_runner）链路不变，既有 runner e2e/smoke 仍绿。

## 11. 已知权衡
- label 不做后端路由（D4/D5）：下发保持纯点名，label 仅辅助找机器——简单、零协议改、零下发回归；将来要真路由再在此之上加（spec 留口）。
- 共享池 + 纯点名：任何人可点名任何在线 runner 下发（活落到该机器）——沿用既有安全模型（点名即授权），归属只管「谁能改/撤这台 runner 的注册」，不限制谁能点名它下发。若将来要「只能点名自己的 runner」可再收紧。
