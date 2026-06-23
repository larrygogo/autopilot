# ReqGenie Runner 本地联调手册（A 模式）

> 把 reqgenie（大脑）与 autopilot（自托管 runner）在本机接通，跑通 clarify→spec→dev→pr 全链路。
> 对应设计：`docs/superpowers/specs/2026-06-23-reqgenie-runner-design.md`（§7 端到端时序、§14 跨契约修正、§15 A2↔B DTO 契约）。

A 模式 = reqgenie 是大脑（编排 + gate + 飞书澄清），autopilot 作**自托管 runner** 执行每个 stage 的一轮 agent，回写事件给 reqgenie。连接倒转（**runner 拉式领活**）：runner 注册换长期凭证 → 长轮询 `GET /api/runners/{id}/sessions/pending` 原子 claim → 领到 session 后按 stage 跑 round、回写事件。reqgenie 推进状态机。

---

## 0. 端口与连接串约定（与两仓测试一致）

| 服务 | 地址 | 来源 |
|------|------|------|
| PostgreSQL | `postgresql://reqgenie:reqgenie@127.0.0.1:5433/reqgenie` | reqgenie `docker-compose.dev.yml`（`5433:5432`） |
| Redis | `redis://127.0.0.1:6379` | 同上（`6379:6379`） |
| reqgenie 后端 | `http://127.0.0.1:3001` | reqgenie `.env.example` `BACKEND_PORT=3001` |
| autopilot daemon | `http://127.0.0.1:6180` | autopilot 默认 |

> 端口若与本机冲突，以 `reqgenie/docker-compose.dev.yml`（PG/Redis）与 `reqgenie/.env.example`（`BACKEND_PORT`）的真值为准，本手册命令同步替换即可。

---

## 1. 起 PG + Redis（reqgenie 仓）

```bash
cd C:/Users/larry/Desktop/workspace/reqgenie
docker compose -f docker-compose.dev.yml up -d
# 等就绪
docker exec reqgenie-postgres pg_isready -U reqgenie    # 期望 "accepting connections"
docker exec reqgenie-redis redis-cli ping               # 期望 PONG
```

迁移：`docker-compose.dev.yml` 已把 `./backend/migrations` 挂到 PG 的 initdb 目录（`/docker-entrypoint-initdb.d`），**首次** `up`（数据卷为空）时按文件名排序自动应用全部迁移（含 052 dev_sessions + B 的 runner 迁移 060/061/062）。

> ⚠️ initdb 脚本**只在数据卷首次初始化时**执行。若库已存在、新增了迁移，挂载不会自动补跑——需重置数据卷：
> ```bash
> docker compose -f docker-compose.dev.yml down -v   # -v 删数据卷
> docker compose -f docker-compose.dev.yml up -d
> ```

---

## 2. 起 reqgenie 后端（真后端，本地）

后端用 `config` crate 读环境变量，前缀 `REQGENIE`、分隔符 `__`（`backend/src/config.rs`：`Environment::with_prefix("REQGENIE").separator("__")`）。本地开发连接串见 `.env.example` 的「本地开发配置」段：

```bash
cd C:/Users/larry/Desktop/workspace/reqgenie/backend
export REQGENIE__DATABASE__URL=postgresql://reqgenie:reqgenie@127.0.0.1:5433/reqgenie
export REQGENIE__REDIS__URL=redis://127.0.0.1:6379
export REQGENIE__JWT__SECRET=integration-test-secret-key-2024   # 与 dev_session_http.rs 一致，方便复用测试签的 JWT
export REQGENIE__AI__API_KEY=<你的 claude key>                  # clarify/spec round 真跑 AI 才需要

# session 内部端点的「集中 codex worker」鉴权密钥。
# ⚠️ A 模式 runner 不用它——runner 走 per-runner secret + x-runner-id（见下 §4/§5 与 spec §14.1）。
# 后端仍需配置它（worker_secret_matches fail-closed：未配则集中 worker 路径恒不匹配）。
export DEV_SESSION_WORKER_SECRET=dev-worker-secret

# 私有仓 vend git-token 才需要（§D6）。GitHub App 需同时配 ID + 私钥（github_service.rs 两者缺一即报错）。
export GITHUB_APP_ID=<你的 App ID>
export GITHUB_APP_PRIVATE_KEY=<App 私钥 PEM>

cargo run --release
# 期望日志：listening on 127.0.0.1:3001
```

健康检查（注意：health 在**顶层** `/health`，不在 `/api` 下——`backend/src/main.rs`：`.route("/health", ...)` 与 `.nest("/api", ...)` 平级）：

```bash
curl -s http://127.0.0.1:3001/health
```

---

## 3. 注册 runner（先注册，再起 daemon）

> ⚠️ **顺序很重要**：必须**先注册**换得凭证，再以 `mode:runner` 起 daemon。`initRunnerMode()`（`src/daemon/runner/index.ts`）在启动时若读不到凭证就**不启 poller**（仅起 HTTP/WS）。且 `autopilot runner register` 在已有凭证时拒绝覆盖（需先 `autopilot runner remove`）。

### 3.1 reqgenie 侧生成一次性注册 token

需要 `runner_manage` 权限的管理员 JWT（或在 reqgenie 前端「Runner 管理」页点「生成注册 token」）。token 默认 15min、一次性、哈希存储（`backend/src/routes/runners.rs` `create_token`，挂在 `authenticated_routes` → 完整路径 `/api/admin/runners/registration-token`）：

```bash
curl -s -X POST http://127.0.0.1:3001/api/admin/runners/registration-token \
  -H "Authorization: Bearer <admin-jwt>" \
  -H "Content-Type: application/json" \
  -d '{"ttl_minutes":15}' | jq -r .data.token
# 响应形状：{ "success": true, "data": { "token": "<一次性token>" } }
```

### 3.2 机器侧注册（token 走 stdin，不进 shell history，§8.1）

```bash
cd C:/Users/larry/Desktop/workspace/autopilot
printf '<注册token>' | autopilot runner register --url http://127.0.0.1:3001 --name dev-laptop
# 期望：注册成功：runner_id=<uuid>
# 凭证写入 AUTOPILOT_HOME/runner/credentials.json（0600 + ACL 收紧），control_plane_url/name 落 config.yaml runner 段
```

> register 请求体 `{ token, name, machine_meta? }`，响应 `{ "data": { "runner_id": "<uuid>", "secret": "<明文，仅此一次>" } }`（`backend/src/routes/runners.rs` `register` → `RunnerRegisterResponse`）。明文 secret 只在注册时返回一次，autopilot 落盘到 credentials.json，后续不可再取。

---

## 4. 起 autopilot daemon（runner 模式）

`AUTOPILOT_HOME/config.yaml` 加顶层 `mode` + `runner` 段（字段名对照 `src/core/config.ts` `RunnerConfig`）：

```yaml
mode: runner
runner:
  control_plane_url: http://127.0.0.1:3001   # register 已写入，此处可省（凭证里也有）
  name: dev-laptop
  poll_wait_seconds: 50      # /sessions/pending 长轮询挂起秒（默认 50）
  heartbeat_seconds: 30      # runner 级心跳间隔秒（默认 30）
```

```bash
cd C:/Users/larry/Desktop/workspace/autopilot
bun run build:web                                # web-dist 是 gitignore 产物，pull 后须重建
autopilot daemon start                           # 后台；或 autopilot daemon run（前台）
# 等价便捷入口：autopilot runner start（前台，要求 config.yaml 已 mode:runner + 已注册）
# 期望日志：autopilot runner daemon v<ver> started on http://127.0.0.1:6180
```

> `mode:runner` daemon **不起** scheduler / clarifier / task-bridge / fix-revision-runner / pr-poller / done-cleanup（`src/daemon/index.ts`：runner 分支只起 HTTP/WS + runner poller）——需求/阶段状态全由 reqgenie 事件协议驱动。

确认运行：

```bash
autopilot runner status
# 期望：状态：运行中 / runner_id：<uuid> / 控制平面：http://127.0.0.1:3001
```

reqgenie 侧确认（admin JWT + runner_manage，`GET /api/runners`，列表不含已 revoke）：

```bash
curl -s http://127.0.0.1:3001/api/runners -H "Authorization: Bearer <admin-jwt>" | jq '.data[] | {id, name, status}'
# 期望：能看到该 runner（runner 轮询 /sessions/pending 时借机刷新心跳 → online）
```

---

## 5. 下发一个 session 到本 runner

reqgenie 前端「需求详情 → AI 开发」选 `agent_backend = autopilot_selfhosted` + 目标 runner = `dev-laptop`，建 dev_session。或 API（`POST /api/requirements/{req_id}/dev-sessions`，`backend/src/routes/dev_sessions.rs` `create_session`）：

```bash
curl -s -X POST http://127.0.0.1:3001/api/requirements/<req_id>/dev-sessions \
  -H "Authorization: Bearer <dev-jwt>" \
  -H "Content-Type: application/json" \
  -d '{"agent_backend":"autopilot_selfhosted","assigned_runner":"<runner_id>","repo_ids":["<repo uuid>"]}'
# 期望：data.status=created, data.current_stage=clarify, data.agent_backend=autopilot_selfhosted
```

> `autopilot_selfhosted` **必须**指定 `assigned_runner`（定向下发到指定机器，spec §14.5；缺则 400「autopilot_selfhosted 会话须指定目标 runner」）。`repo_ids` 须属于本需求关联项目下的仓库或匹配需求 repo_urls 的已接入仓库（否则 403 越权）。该后端 `max_stage` 放开到 `pr`（写代码 + 出 PR），其余后端停在 PHASE1_MAX_STAGE。

---

## 6. 观察全链路

链路：runner 长轮询 → claim → 逐 stage 一轮 → 出 PR → done。

1. **claim**：runner `GET /api/runners/{id}/sessions/pending?wait=50` 原子 claim → session `created→queued`，runner 接管后 `→running`。claim 命中响应（**专用 DTO，非裸 ORM**，spec §15.1）：
   ```jsonc
   { "session_id": "<uuid>", "current_stage": "clarify", "status": "queued" }
   ```
   无待派 → `204 No Content`。

2. **每 stage 一轮**：clarify（飞书/web 答澄清）→ spec（gate 等人审）→ dev（diff gate）→ pr（出 PR）→ `done`。runner 每轮先 `GET /api/internal/dev-sessions/{id}` 拉会话状态（**含 repos[]**，spec §15.2）：
   ```jsonc
   {
     "id": "<uuid>", "status": "running", "current_stage": "dev",
     "repos": [
       { "repo_id": "<uuid>", "alias": "<子目录别名>", "remote_url": "https://github.com/o/r.git",
         "default_branch": "main", "primary": true }
     ]
   }
   ```
   （runner 用 `repo_id` 取 git-token、`alias` 定 clone 子目录、`remote_url` clone、`primary` 决定 submitPR 主仓。repos 集合在 dev/pr 间冻结。）

3. **pr**：runner 出 PR 后回写 `pr_created` 事件 → 后端摄取写 `dev_sessions.pr_url`、推进到 `done`。

4. **看事件流**（JWT 路由）：
   ```bash
   curl -s "http://127.0.0.1:3001/api/dev-sessions/<sid>/events?after_seq=0" -H "Authorization: Bearer <dev-jwt>" | jq '.data[] | {seq, event_type, stage}'
   ```
   `seq` 由后端 advisory 锁内分配（runner 永不自定）；`gate_opened` 的 `gate_id` 由后端注入（runner 回写不带）。

5. **gate 裁决**：reqgenie 前端 gate 卡点「通过/驳回」，或 API：
   ```bash
   curl -s -X POST http://127.0.0.1:3001/api/dev-sessions/<sid>/gates/<gid>/decision \
     -H "Authorization: Bearer <dev-jwt>" -H "Content-Type: application/json" \
     -d '{"decision":"approved"}'
   # 驳回须带评论：-d '{"decision":"rejected","comment":"漏了错误处理"}'（缺 comment → 400）
   ```
   驳回评论经 `gate_decided` 事件 `payload.comment` 回流给 runner，下一轮并入上下文重做（spec §14.4）。

---

## 7. 鉴权速查（A 模式三类密钥，勿混）

| 端点 | 鉴权 | 谁持有 |
|------|------|--------|
| `/api/admin/runners/*`（生成 token / 列表 / revoke） | JWT + `runner_manage` 权限 | reqgenie 管理员 |
| `/api/runners/{id}/{register,heartbeat,sessions/pending,deregister}` | per-runner secret（register 例外：用一次性注册 token） | runner（credentials.json） |
| `/api/internal/dev-sessions/{id}/{events,git-token,heartbeat}` | **per-runner secret + 头 `x-runner-id: <runner_id>` + 会话归属校验**（`session.assigned_runner == 该 runner`） | runner（credentials.json） |
| `/api/dev-sessions/{id}/*`（get/events/gates/decision/cancel） | JWT | reqgenie 前端 / 开发者 |

> 🔒 **安全红线（spec §14.1）**：全局 `DEV_SESSION_WORKER_SECRET` 是「集中 codex worker」路径用的，**绝不下发到 runner 机器**（任一机器失陷即泄露全局密钥）。autopilot runner 只持有自己的 per-runner secret，且只能访问指派给自己的会话。session 内部端点双鉴权（`backend/src/routes/dev_sessions.rs` `ensure_internal_session_auth`）：接受全局 worker secret（codex 路径）**或** per-runner secret + `x-runner-id` + 归属校验（runner 路径），取其一即放行。

---

## 8. 收尾

```bash
autopilot runner stop                             # 复用 daemon 优雅停机：abort 当前 loop → 释放 runner.lock → deregister
docker compose -f docker-compose.dev.yml down     # 留 -v 才删数据卷
# 彻底注销本机 runner 身份（控制平面 revoke 需在 reqgenie 后台「Runner 管理」操作）：
autopilot runner remove
```

---

## 故障对照

| 现象 | 排查 |
|------|------|
| runner register 401 | 注册 token 过期（默认 15min）/ 已被消费（一次性）/ 错 → 重新生成；确认 `--url` 指向 reqgenie 而非 autopilot daemon |
| register 报「本机已注册 runner」 | 已有 credentials.json，先 `autopilot runner remove`（先 `runner stop`）再重注册 |
| daemon 起了但不领活 | ① config.yaml 未设 `mode: runner`（默认 scheduler，不起 poller）；② 未注册凭证（`initRunnerMode` 读不到 credentials → 不启 poller，看 daemon 日志 `未注册 runner`）；③ `autopilot runner status` 看是否「运行中」 |
| session 卡 created 不领 | 检查 `assigned_runner` 是否=本 runner_id（A 模式定向下发，非任意 runner 可领）；runner 是否在线（`GET /api/runners`）；poller 是否因正忙跑别的 session 而停领（单 session 自律，§6.1） |
| 内部端点 401（events/git-token） | 缺 `x-runner-id` 头，或会话归属不符（`session.assigned_runner ≠ 调用 runner`），或 secret 已 revoke。A 模式 runner 不应用全局 worker secret 访问（即便配了也不该走那条路径） |
| `/health` 404 | health 在顶层 `/health`，**不是** `/api/health` |
| GitHub App token 失败 | `GITHUB_APP_ID` 与 `GITHUB_APP_PRIVATE_KEY` 须**同时**配置（缺一报错）；仓库需安装该 App；私有仓 vend installation token（1h，push 前现取，§D6） |
| push/PR 403 | vend token 未注入或过期；私有仓需 App 安装 + repos[].remote_url 与仓库匹配；`pr_created` 的 owner/repo 须属 session.repos（归属校验，§8.2） |
| dev/pr git fatal | A 模式走 executor 路径（`src/core/executor/`），**不用** dev workflow——若误走 builtin dev workflow，老副本统一子目录布局未同步会 git fatal。确认 daemon 是 `mode:runner` 且 session 由 reqgenie 下发 |
