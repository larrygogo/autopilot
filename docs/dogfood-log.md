# Dogfood 实战记录

autopilot 用自己开发自己 — 本文档记录的是从"提需求 → 跑 dev workflow → 产出 PR"完整流程实战过程中发现并修复的真实 bug。客户跑同样的场景应该已经踩不到这些坑。

如果你跑 dogfood 又发现了新 bug，欢迎追加这份 log。

---

## 第一轮（2026-05-17 ~ 2026-05-18）

提需求：`docs 里中文版有些文件英文版根本没有，肯定漏译了好几个。能否做个对比脚本？`

**用 CLI 提交（模拟真实用户口语化输入）**：
```bash
autopilot req new --from-prompt "docs 里中文版有些文件..." -p proj-002
```

走通 5 阶段：design → review → develop → code_review → submit_pr。产物：`scripts/check-docs-translation.ts` + `.github/workflows/ci.yml` + `package.json` 加 `check:docs` script。

中途抓到 7 个真实 bug（commit 引用 `git log` 可查）：

| # | bug | 修在哪 | commit |
|---|---|---|---|
| 1 | clarifier 严格 JSON 解析在 LLM 返回 markdown 围栏 / 中文 spec 时卡死 | `src/daemon/requirement-clarifier.ts` 切 YAML wrapper | `548ea2e` |
| 2 | `routes-auth-token.test.ts` afterAll 误删真实 `~/.autopilot/runtime/api-token` 文件，daemon 起不来 | 测试 afterAll 备份+恢复 | `3802c91` |
| 3 | 状态机 `awaiting_approval → queued` 转换缺失，用户审批后入队报"非法状态转换" | `src/core/requirements.ts` ALLOWED_TRANSITIONS 加 queued | `0341c37` |
| 4 | requirement-scheduler 硬编码工作流名 `req_dev` 不存在（registry 是 `dev`），tickRepo 始终失败回滚 | 改为 `dev` | `b2174ec` |
| 5 | dev workflow develop 阶段 `git add -A` 把用户工作目录所有未提交散改一起卷入 commit，污染下游 code_review 的 diff | develop 阶段开头 `git stash --include-untracked`，commit 后 stash pop | `3fde8c6` |
| 6 | submit_pr 完成后 HEAD 卡在 task feature branch，daemon 主机后续 git 操作默认 base 错位 | submit_pr 末尾 `checkout default_branch` | `10c1bd7` |
| 7 | code_review reject 重做时 developer agent 没拿到 reviewer 反馈，看到 commit 已存在就回答"任务已完成"摆烂，循环到 max_rejections | develop reject 重做 prompt 拼入 `code_review_report.md` | `7304ab9` |

## 第二轮（2026-05-18）

提需求：`README 顶部加个 dogfood 状态徽章` → PR 真实创出 [#82](https://github.com/larrygogo/autopilot/pull/82)。

5 阶段端到端跑通，零 rejection。又抓到一个：

| # | bug | 修在哪 | commit |
|---|---|---|---|
| 11 | bug 5 fix 的 `git stash pop` 用 `check=false` 容错，pop 冲突时静默失败留 UU conflict markers，连锁让 bug 6 fix 的 `checkout default_branch` 也因 unmerged 失败 | pop 失败时把 unmerged 文件列表 + 恢复指引写到 `dev_report.md` | `0badbfc` |

## Onboarding 体验补足

| # | bug | 修在哪 | commit |
|---|---|---|---|
| 8 | `autopilot init` 只创空目录，新用户跑任何 dev task 都报"找不到工作流" | init 末尾自动 `cloneTemplate("dev", "dev")` | `312d633` |
| 9 | 老用户已 init 过的，examples 后续改 bug fix 拿不到 | 新增 `autopilot workflow sync <name>` 命令（dry-run + `--apply`） | `659a908` |
| 12 | `autopilot doctor` 在 CLAUDE.md 文档化的"零配置"模式（`providers` 段不写）下误报"没有 enabled provider"。客户跑 init 后看到红色 error 误以为没装好 | doctor providers 段不存在时视为零配置，L1 不报 error，引导 `--probe` 跑 L2 探测 CLI | `32debc2` |
| 13 | CLI `autopilot daemon status` 只显示 `版本: 1.0.0`，缺 git_sha / started_at。客户做 daemon restart 后没法从 CLI 一眼 verify"现在跑的真是新代码" | daemon status 输出加 `· <git_sha>` 和`启动于` 行，跟 web Settings 「Daemon 信息」卡对齐 | `8465c5a` |
| 14 | `autopilot task status <id>` 默认裸 `JSON.stringify` 输出，跟无 id 的表格视图风格不一致，客户读完跑完的 task 还得手工读 JSON | 默认 human-readable 字段列表 + `--json` 选项保留脚本友好；`task logs` 末尾加 workspace path + `--follow` 引导 | `a10d7ad` |
| 15 | 状态机缺 `running → done` 转换，requirement 跑完 dev workflow 卡 running 状态，bridge silent skip 不报错 | ALLOWED_TRANSITIONS.running 加 done | `685c3ed` |
| 16 | `autopilot config doctor --probe` 在零配置模式下不探测任何 CLI（providers 段空数组过滤后 enabled list 为空），客户看不到"装了 claude / codex / gemini" 提示 | 零配置时探测全部三家内置 CLI，凭证未登录降级 warning 而非 error | `89f3c94` |
| 17 | doctor warning 计入 exit 1（"提示性"问题如可选 CLI 没装），客户 CI 里跑 `doctor` 被误判失败 | exitCodeFor 改 POSIX 标准：error → 1 / warning → 0 | `89f3c94` |
| 18 | `168a47e` 在 package.json 加了 `coverage:rpc` script 但忘把 `bin/coverage-matrix.ts` 一起入库，刚 clone 仓库的客户跑 `bun run coverage:rpc` 直接 file not found | 补 commit 工具 + 文档（`docs/rpc-coverage.md`） | `b8f4cf9` |
| 19 | `autopilot init` 只跑 SCHEMA 不跑 migrations，客户 init 完只有 tasks/task_logs 两张表，跑 dashboard 创 project 立即报 "no such table: projects"（bug 8 修过"自动装 workflow"但漏修了数据库本身） | init 内调 runPendingMigrations()，输出"应用 N 条迁移" | `9932f62` |
| 20 | 纯 CLI 路径被 web 依赖打破：`autopilot req new` 在 0 project 时报"请先在 web /library 创建"。客户走 CLI 还要开浏览器才能创第一个 project | 加 `autopilot project list / create / delete`；req new 错误信息引导 `autopilot project create <name>` | `1f50389` |
| 21 | 同 bug 20 下游：`autopilot req new` / `autopilot task start --repo X` 都依赖 codebase 已注册，但 CLI 没有 codebase 注册命令。客户卡在 project 之后第二步 | 加 `autopilot codebase list / create / delete / health`，create 含本地路径校验 + --github 格式校验 + --no-project 走全局 | `500263b` |
| 22 | CLI 所有子命令 `--port` 默认硬编码 6180，commander 永远注入 opts.port，getClient 内 listen.json 永远被忽略。客户改 `config.yaml.daemon.port=16180` 后 `daemon status` 报错 pid（连用户主 6180）+ 监听 16180 两套数据源不一致 | getClient 改"显式 --port 非默认 → 覆盖；否则 listen.json 优先；最后 default" | `9edb0bf` |
| 23 | `req new --no-extract` 完全不生效：commander 把 `--no-extract` 解析为 `{ extract: false }`，代码检查 `opts.noExtract` 永远 undefined → 永远走 extract 分支调 LLM。无 LLM 配置的客户必报 "抽取失败：TIMEOUT 300s" | 类型 noExtract → extract，检查 `opts.extract === false` | `9edb0bf` |
| 24 | bug22 修了 12+ CLI 命令但漏了 `tui` + `dashboard`：tui 直接 `parseInt(opts.port)` 永远用 default 6180、dashboard 拼 URL 用 default 6180。客户改 `daemon.port=16180` 后跑 tui/dashboard 都连用户主 6180 daemon 而非自定义 daemon | 抽出 `resolvePort()` 纯函数给所有客户端命令共享，tui/dashboard 也走 listen.json 优先 | `11991d2` |
| 25 | daemon 启动 retention 用 `setInterval(prune, 3600_000)` 但 **不立即触发**。客户 `daemon stop` 累积一周旧 workspace → `daemon start` 后第一小时 retention 完全无效，看着像功能坏了 | 抽出 runRetention()，启动时同步跑一次再开 setInterval；加 3 个集成测试用 spawn 子进程完整跑 (loadConfig + DB + scan + prune) | `55f3382` |
| 26 | bug22 系列遗漏：`TokenGate.tsx` 给局域网用户的指引文案硬编码 "127.0.0.1:6180/settings"。客户改了 daemon.port=16180 后，局域网用户照着说明在本机打开是 404 | 用 `location.port` 替代硬编码 6180，链接跟随客户实际端口 | `acf9b12` |
| 27 | `config:updated` 事件 emit 后**无 daemon 内 subscriber**：客户在 web Settings 改 agent.model → "已保存"亮起 → 下个 task 跑的是 cached Agent 旧 model | daemon 启动时 onEvent("config:updated", clearAllAgentCache)，新增 clearAllAgentCache() 异步清 + close 所有缓存 Agent | `cd533a9` |
| 28 | bug 27 同源遗漏：`workflow:reloaded` emit 后 daemon 内无 listener 清 agent cache。客户改 workflow.yaml.agents[] 保存 → daemon 重 discover → cache 还在 → 下个 task 旧 Provider | daemon 启动时 onEvent("workflow:reloaded", clearAllAgentCache)；顺手修 resolveQuestion 误导注释 | `4e666fb` |
| 29 | 5 处 web silent failure：Workflows.tsx toggle/reloadSelected catch ignore → 用户点 workflow 看着卡住；3 个组件的 clipboard.copy() catch ignore → 点复制按钮没反应。Web 上"没反应"等同于"应用挂了" | 全部改成 catch (e) + toast.error() 告诉用户失败原因 | `7110d4e` |
| 30 | src/core 多处错误信息缺上下文：`"template not found"`、`"工作流名称非法"`、`"phases 不能为空数组"`、`"agents 必须是数组"`、`"templates root not found"` 等。客户看到一脸懵：哪个模板？哪个工作流？怎么是非法？ | 全部加具体上下文：模板名 + 已有模板列表 / 工作流名 + 允许字符 / 实际路径 + 期望边界 / 实际类型。新增 availableTemplates() 辅助列模板 | `73ab4c9` |
| 31 | 状态机非法转换错误信息缺 hint：`"非法状态转换：queued → done"`、`"非法转换：状态 'running_dev' 不支持触发器 'foo'"`。客户/dev 调试时不知道合法去向，要翻源码 | 错误信息追加 hint：requirement 用 legalTransitionsFrom() 列合法去向；task state-machine 列状态支持的全部触发器；终态时显式说"已是终态" | `a0e017a` |
| 32 | rpc-methods.ts 80+ handler 报 `RpcError("INVALID_PARAM", "需要 id")` 不知是哪种 id（task/req/proj/cb）。逐个改改工作量大 | 在 `invokeRpcMethod` 单点改动：所有 error message 自动加 `[method]` 前缀，覆盖 80+ handler。客户截图给开发时不必再追问"调的哪个接口" | `4280544` |

---

## 客户从 0 上手现在应该走的路径

```bash
git clone https://github.com/larrygogo/autopilot && cd autopilot
bun install
autopilot init                              # 自动装 dev workflow + 跑全迁移
autopilot daemon start                      # 后台启动 daemon + supervisor

# 选一：纯 CLI（bug 20/21 修过后完整路径）
autopilot project create "My Project"
autopilot codebase create myrepo ./path/to/repo --github owner/repo
autopilot req new "你的需求描述"             # cwd 在 codebase 内自动推断 codebase

# 选二：web UI
autopilot dashboard                         # 浏览器 → 创建 project / codebase → 提需求
```

老用户（init 已经在 fix 之前跑过）拉 repo 后跑一次：

```bash
git pull
autopilot workflow sync dev          # dry-run 显示 diff
autopilot workflow sync dev --apply  # 真覆盖
autopilot daemon restart             # 让新 workflow.ts 生效
```

## 测试覆盖现状

本次实战同时补的测试（防回归）：

- `tests/recover-dangling-tasks.test.ts` 7 用例：daemon 主动重启 vs 崩溃路径区分
- `tests/routes-auth-token.test.ts` 8 用例：token 鉴权 4 条路径（loopback 豁免 / Bearer / X-header / `?token=`）
- `tests/rpc-daemon-setHost.test.ts` 7 用例：setHost 网卡校验，防 daemon 进崩溃循环
- `tests/workflow-templates.test.ts` +9 用例：workflow sync diff / 覆盖行为
- `tests/supervisor-logic.test.ts` 11 用例：supervisor 退避决策（exit 0/75/crash、crash loop 30s 窗口、attempt 退避索引）
- `tests/workspace-retention.test.ts` 10 用例：days / max_total_mb 策略 + isTerminal 注入保护运行中任务
- `tests/logger-rotation.test.ts` 8 用例：daemon log 切割阈值 + rotateIfNeeded export
- `tests/api-token.test.ts` 20 用例：token 生成/读取/验证/轮换 + 路径函数化
- `tests/pid.test.ts` 28 用例：daemon/supervisor PID + listenInfo + 僵尸检测
- `tests/pr-poller.test.ts` +6 用例：PR 轮询边界
- `tests/doctor.test.ts` +3 用例：零配置模式 + exitCodeFor
- `tests/cli-config.test.ts` +1 用例：warning → exit 0 / error → 1
- `tests/requirements.test.ts` +5 用例：状态转换覆盖 bug 3/15

861 测试 / 0 失败（截至 commit `a0e017a`）。

## 还没验过的边界（欢迎补）

- ~~supervisor 真子进程端到端~~ ✓ **全部三场景已验**：(1) 起 `daemon supervise` + `taskkill /F daemon-pid`，supervisor 1s 退避后自动重启；(2) 连续快速 kill 3 次（daemon 跑 < 10s）观察 backoff 从 1s → 1s → 1s → 2s 递增对齐 `BASE_BACKOFF_MS=[1000,2000,5000,...]`；(3) 调 `daemon.restart` RPC 触发 exit 75 → supervisor log "daemon 主动请求 respawn (code=75)，立即重启" → 新 daemon 立即起，**无 backoff**。三条路径都跟 supervisor.ts 设计对齐。
- ~~workspace_retention 在 daemon 实际跑一段时间后真触发清理~~ ✓ **已验**：手动跑 prune e2e 验证 days=1 + 30 天前 done task 被清；同时发现 bug 25（启动后第一小时不跑）并修复 + 3 个集成测试。
- 多设备局域网访问 token 二维码扫码流程（需要真实手机/平板）
- 4 个零调用 RPC method (`tasks.events`、`tasks.subtasks`、`requirements.finishClarification`、`requirements.retryClarify`) 是孤儿（注册了但客户端忘接）；删之前要确认是否未来想暴露
- working tree 上有一个进行中的"邮箱+密码+JWT cookie 登录"feature（routes.ts auth 路由 + core/auth.ts + migration 020 + Login.tsx/AuthGate.tsx/useAuth.ts），后端完整、前端组件完整，但**缺"首次创建用户"入口** —— UI 无 setup 按钮、CLI 无 `autopilot auth setup` 命令，导致 authEnabled 永远 false（fallback 老 TokenGate），feature 实质未启用。补完只需把 AuthGate 在 `!authEnabled` 分支加"启用 auth"按钮或加 CLI `user create` 命令。白名单已加 auth.ts（commit `160b115`），feature 文件未 commit。

## 诊断工具

- `bun run coverage:rpc` —— 跑 RPC × {web/tui/cli} 客户端覆盖矩阵，发现死代码 / 反渗内核命名候选。输出在 `docs/rpc-coverage.md`。
- `bun run smoke-test` —— 跑客户 onboarding CLI 完整路径（init → 表全建 → 二次幂等 → doctor → project/codebase/req new 命令存在 → workflow list → daemon status）。12 步任意失败立即 exit 非 0。CI 在每个 PR 跑一遍防回归（`.github/workflows/ci.yml`）。

## 端到端 dogfood 验证（28 bug 隐式覆盖）

最后一次完整 e2e（commit `e3071aa` 后）：客户在临时 HOME 跑 init → daemon supervise + 16183 端口 → project create → codebase create → req new --no-extract。

观察结果：
- `daemon status` 显示正确 pid + git_sha（bug 22 / 24 端口解析路径通）
- project / codebase / req new 命令完整链路通（bug 20 / 21）
- daemon 内部 log **0 WARN / 0 ERROR**
- clarifier 真调通了 LLM（user 主 daemon 配过 claude），创了 qst-001 提"实现范围 + 技术栈"问题，req-001 进 clarifying 状态
- title 被 LLM 改写成 "myrepo 项目新增用户登录页面"
- spec_md 走 noExtract 分支（bug 23 fix 生效，daemon 端模板包装）

实际所有前面修过的 28 个 bug 都隐式跑通。
