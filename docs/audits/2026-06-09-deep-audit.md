# autopilot 深度审计报告

## 【总评】

项目核心引擎能跑、设计理念清晰，但有一个**静默丢失全部工作成果的 P0**（零代码 prompt 模式没跟上即焚 sandbox 重构）尚未暴雷，且围绕「双状态机协调」「即焚 sandbox 重构残留」「核心路径零测试」三条系统性裂缝集中爆发——整体健康度：**架构方向对、内核稳，但 2026-06 即焚重构留下一片未收口的边角，且最该有回归网的地方恰恰裸奔**。

**最该先修的 3 件事（影响 × 紧迫）：**

1. **EPH-01（P0）**：零代码 `prompt:` 模式 agent 仍跑在空的旧 `workspace/` 目录，git 改动全丢、PR 推空。文档把它列为一等支持路径，触发即静默丢全部成果。改 `prompt-runner.ts:86/293` 两行 cwd 即可。
2. **DM-01 / EPH-05（P1，同根）**：MCP `start_task` 工具绕过 `requirement_id` 非空闸建游离任务 + 走旧持久 clone 路径，破坏核心不变式、阻塞 Phase 2 迁移。让它复用 `startTaskFromTemplate` 单一入口。
3. **TC-01/TC-03/TC-04（P1，同根）**：即焚 sandbox 全链路、重跑幂等清理、watcher 止损逃生门三个最高 churn / 反复踩坑的核心路径**零测试**。EPH-01 这类回归本可被一条 capture 断言钉死。

---

## P0

### EPH-01 零代码 prompt 模式未迁移即焚 sandbox，代码改动全丢
- **位置**：`src/core/prompt-runner.ts:86`、`:293`
- **问题**：cwd 与 codeRoot 仍指向旧持久 clone 目录 `getTaskSandbox(taskId)`，即焚模型下该目录从不创建，agent 在空目录里跑 git。
- **影响**：任何 `sandbox.git=true` + `prompt:` 零代码 phase，runner 的 `captureAgentSandbox` diff 恒空 → `cumulative.patch` 永空 → submit_pr 推零改动 PR，用户看任务「成功」却丢失全部工作成果，无任何告警。dev 工作流用 ts 函数恰好绕开，所以未被 dogfood 撞到。
- **修复**：`:86` / `:293` 改为 `getCurrentSandboxDir() ?? getTaskSandbox(taskId)`，与 `workflow.ts` 各 phase 对齐。

---

## P1

### DM-01 + EPH-05 MCP `start_task` 工具绕过核心不变式建游离任务（跨维度合并）
- **位置**：`src/agents/tools.ts:382`、`:399`、`:402`；`src/core/db.ts:224`、`:494`
- **问题**：`start_task` 直接 `createTask(...)` 不传 `requirementId` → 写入 `requirement_id=NULL` 游离任务，且子任务继承游离；同时走旧持久 clone（`ensureTaskSandbox`）而非即焚 `prepareDeliverMeta`，反查 workspace 漏传 `github_owner/repo`。该工具默认对 chat agent 可达（`mcp__autopilot__start_task`）。
- **影响**：(1) 违反「每 Task 必有 requirement_id」核心不变式，正是迁移 023 要消除的脏数据被运行时重造，Phase 2（NOT NULL+FK）上线即炸；(2) `listRootTasksByRequirementIds` 查不到 → 级联删除失效留孤儿；(3) 旧 clone 路径与即焚双轨发散。
- **修复**：让 `start_task` 复用 `startTaskFromTemplate` 单一入口（强制 reqId）；最彻底是把 `requirementId` 设为 `createTask` 必填、去掉 `?? null` 兜底，在类型层堵死所有绕过路径。注：`DM-07`（死文件 `src/cli.ts:114`）是同一反模式的死代码版本，删除即可。

### SC-1 取消需求不级联停运行中的任务
- **位置**：`src/daemon/rpc-methods.ts:1013`、`src/daemon/routes.ts:764`
- **问题**：`requirements.cancel` RPC/REST 只 `setRequirementStatus(cancelled)`，不停名下 task（对比 `delete` 路径有 `cancelTaskAction` 级联）。
- **影响**：取消后 task 继续烧 token、占 sandbox；scheduler 的 active 过滤不算 cancelled，可能并发起第二个 task；task 最终 transition 时撞终态 req 留下「req cancelled 但 task 还活/done」永久不一致。
- **修复**：抽 `cancelRequirementWithTasks`（先级联 `cancelTaskAction` root tasks）供 cancel 的 RPC + REST 共用；或加 `requirement:status-changed` 订阅者监听 `to===cancelled` 停 task。

### SC-3 + CONC-03 scheduler.tickRepo 无串行锁 + TOCTOU，同需求起两个 task（跨维度合并，同一问题两次独立确认）
- **位置**：`src/daemon/requirement-scheduler.ts:40-46`、`:109`、`:132-133`；`src/core/task-factory.ts:99`
- **问题**：`tickRepo` 是 async 事件处理器，从「读 active 判空」到「`setRequirementStatus(running)`」之间隔着 `await startTaskFromTemplate`（内含 `await discover()` FS I/O 让出点），无内存串行锁。并发两次 tick 都看到 candidate 仍 queued、task_id 仍 null，1:1 守卫拦不住，双双 createTask。
- **影响**：同需求两个并发 task、各自 clone/跑 agent/push 同名 feat 分支冲突，违反「同仓库串行 + req:task 1:1」核心不变式，双倍算力。对比 `requirement-clarifier` 已有 `_inflightRounds` 串行守卫，scheduler 独缺。
- **修复**：给 tickRepo 加 per-group 内存串行锁（仿 `_inflightRounds`）；并把抢占改原子化 `UPDATE requirements SET status='running' WHERE id=? AND status='queued'` 拿 changes>0 才继续。

### SC-2 tasks.restart 不检查运行态，对 running 任务点 restart 永久卡死
- **位置**：`src/daemon/task-actions.ts:70`、`src/core/runner.ts:76`、`:216`、`src/core/watcher.ts:159`
- **问题**：`restartTaskAction` 只挡终态、不挡持锁运行中。对 running 任务调用会把 status 翻到 `pending_<phase>`，新 executePhase 抢锁失败直接 return，原 phase 完成时因 status≠running_state 跳过推进 → 卡死 pending，watcher 只捞 running_ 不救。
- **影响**：UI「重新执行」按钮（`TaskDetail` actionGroup、`CommandPalette` 均无 disabled 守卫）对正在跑的任务点一下即永久死状态，需人工 `forceTransition` 复活。`resetTaskForRerun` 已有同款 `running_ && isLocked → 409` 守卫，restart 独缺。
- **修复**：`restartTaskAction` 开头加 `if (task.status.startsWith("running_") && isLocked(taskId)) throw 409`，与 `resetTaskForRerun` 对齐。
- **注**：`CONC-02` 是本问题的并发维度重复确认（校正 P2），合并于此按 P1 处理。

### CONC-01 并行块中途 daemon 崩溃/重启 → 卡死 waiting_<group> 永久 stranded
- **位置**：`src/core/runner.ts:357`、`src/core/watcher.ts:159`、`src/daemon/index.ts:318`、`src/daemon/task-actions.ts:85`
- **问题**：fork 时主任务持久化到 `waiting_<group>`，子阶段进度只在内存 `Promise.allSettled`。重启后 promise 丢失，watcher / recoverDanglingTasks 都只认 `running_*`，restart 正则只认 `running_/pending_/awaiting_`，三条路全不匹配 `waiting_`。
- **影响**：用并行工作流时一次**例行 daemon.restart** 就让任务静默永久死亡——不标 dangling、不恢复、手动点 restart 还报错，只能手改 DB。`parallel_build` 示例可触达。
- **修复**：watcher/recoverDangling 纳入 `waiting_*`（反查 group 名 force 回 `pending_<group>` 重跑整组）；restart 正则补 `waiting_` 分支。

### WEB-02 fix_revision 阶段注入反馈后历史不刷新，静默失败
- **位置**：`src/web/src/pages/RequirementDetail.tsx:770-785`；`src/daemon/rpc-methods.ts:1126-1140`
- **问题**：`inject()` 成功只清输入+toast，无 refresh/乐观 append；服务端 `comments.add` 仅当 `status===awaiting_review` 才转态 emit 事件，已是 fix_revision 时不 emit 任何 WS 事件。
- **影响**：用户在修复阶段填反馈、提示「已提交」，但反馈历史列表永远看不到刚提交的这条（已落库但 UI 不反映），无法确认成功、可能重复提交。review 阶段因会转态侥幸正常，掩盖了 bug。违反「状态完整性优先」红线。
- **修复**：`inject()` 成功后 `await refresh({silent:true})`；根因更彻底是 `comments.add` 加 feedback 后无条件 emit `requirement:comments-updated`。

### TC-01 + EPH-06 即焚 sandbox + 累积 patch 模型零测试（跨维度合并）
- **位置**：`src/core/agent-sandbox.ts`（全文件）；`tests/` 无任何 `acquire/capture/releaseAgentSandbox/cumulativePatch` 引用
- **问题**：最高 churn 核心机制（13 个连续 commit + PR#86）零回归网。`agent-sandbox.ts:114` 的 `git apply --3way` 后必须 `git reset -q`（commit 926e1ef 修「改动进 index → code_review 看空 diff 反复驳回」），这条杀任务回归无任何测试守护。
- **影响**：任何对 clone/checkout/apply/reset/diff 顺序的改动可静默回退到「空 diff 反复驳回」「session No conversation found」等已修 bug，单测全绿、smoke-test 不碰，等 dogfood 撞墙。EPH-01 本可被一条 capture 断言抓住。
- **修复**：新建 `tests/agent-sandbox.test.ts`：tmp git 仓库 → prepareDeliverMeta → acquire → 改文件 → capture 断言 patch 非空 → 二次 acquire 断言 patch apply 进工作树（**不带 --cached 的 git diff 能看到，直接钉死 reset -q 回归**）→ release 断言目录删除；覆盖 read-only 不回写、deliver 不 capture、reject 返工 patch 覆盖。

### TC-03 resetTaskForRerun 即焚/远程清理分支未测（重跑幂等核心）
- **位置**：`src/core/task-factory.ts:264-291`；`tests/runner.test.ts:278-302`（用无 sandbox 段的夹具，整块被跳过）
- **问题**：唯一的 rerun 测试用 `makeTestWorkflow`（无 `sandbox.git`），`deleteRemoteDeliverBranch` + 清 artifacts + `purgeAgentRuns` + `prepareDeliverMeta` 重置元数据整块零覆盖，只断言了 DB 层重置。
- **影响**：「重跑=干净重来」（失败自愈哲学核心，commit 42318b6/8edd9d9/ecaff8f 反复修过）的不幂等回归（旧 patch 污染、远程分支未删致 push 冲突、deliver meta 未回写致下轮拿不到 workspace）全抓不到。
- **修复**：加带 `sandbox.git=true` 夹具 + 真实 git 仓库，断言 artifacts 清空、`.agent-runs` 消失、`.worktree.json` 重写、task 的 branch/workspace_path 更新。

### TC-04 watcher MAX_RECOVERIES_PER_PHASE 止损逃生门零测试
- **位置**：`src/core/watcher.ts:222-242`；`tests/watcher.test.ts`（3 个用例均单次调用，不触发上限）
- **问题**：同 task:phase 恢复累计达 3 次后 `forceTransition(failed)` 的死循环熔断器无测试，60s 节流也没测。
- **影响**：runner 注释明指这是 deterministic 崩溃任务的兜底终止器；若回退（key 拼错/比较写反/漏 delete），卡死任务被无限弹回，永不进 failed，用户既看不到失败也无法重跑——状态永久卡死类故障。纯内存 Map + DB 逻辑极易测却没测。
- **修复**：循环调 `checkStuckTasks` 推 recoveryCount 到 4 轮（跳过 60s 节流），断言第 4 轮 `status==='failed'` 且 emit `watcher:recovery(toStatus:'failed')`；另加 60s 节流 no-op 用例。

---

## P2

### SC-5 安装版 dev 工作流 submit_pr 直接落 done，整套 review 回路在生产失效
- **位置**：`examples/workflows/dev/workflow.yaml:61`、`src/daemon/requirement-scheduler.ts:109`、`src/daemon/pr-poller.ts:58`
- **问题**：scheduler 硬编码 `workflow:"dev"`，dev 末阶段 submit_pr 直落 done，无 await_review。pr-poller 只扫 `awaiting_review`，dev 路径的 req 从不经过。带 review 回路的 `req_dev` 未被 `init` 安装。
- **影响**：生产「需求 done」= PR 刚提交未合并；pr-poller、CHANGES_REQUESTED→fix_revision 自动回路、merge→done 检测全失效；bridge 两条映射成死代码。铁证 commit b2174ec 因「req_dev not found」把 workflow 名改回 dev。
- **修复**：产品上明确 dev 的 done 语义=已提 PR，或给 dev 补 await_review 与 req_dev 对齐；至少在 CLAUDE.md 标注 dev 路径无 review 回路。

### CONC-09 cancelTaskAction 不打断 in-flight phase，agent 跑完仍 push/开 PR
- **位置**：`src/daemon/task-actions.ts:42-64`、`src/core/runner.ts:165`
- **问题**：cancel 只做状态机 transition，runner 无 cancellation token，phaseFn 的 agent.run/git push 继续跑到底。`projects.ts:112` 注释自称「停子进程由 cancelTaskAction 负责」但实际不 kill。
- **影响**：取消后若 submit_pr 已在执行，分支仍 push 到 GitHub、PR 仍开出，与「已取消」认知冲突。
- **修复**：引入 per-task AbortController，executePhase 在 agent.run/git push 前检查取消标志；至少 UI 文案明确「取消不保证立即中止正在执行的步骤」。

### CONC-05 pr-poller 周期重叠 + last_reviewed_event_id 读改写非原子，重复注入 feedback
- **位置**：`src/daemon/index.ts:260`、`src/daemon/pr-poller.ts:99-142`
- **问题**：`pollAllPRs` fire-and-forget 无重入守卫；`pollOne` 先 `await ghPrView` 后才读 `last_reviewed_event_id` 去重。gh 慢于轮询间隔时两次 pollOne 读同一旧值，重复 createComment。
- **影响**：慢轮询下 review 反馈重复落两条 feedback 评论（状态机能挡住重复转态但评论去重失效），agent 看到重复反馈。默认 5min 间隔下罕见。
- **修复**：`pollAllPRs` 加 `_polling` 重入守卫；或 createComment + updateRequirement 进单事务以 `last_reviewed_event_id` 做 compare-and-swap。

### EPH-02 task-outcome diff_stat 即焚模型下永久算 0/null
- **位置**：`src/daemon/task-outcome.ts:76-82`；`src/core/task-factory.ts:178`
- **问题**：即焚模型不再注入 `repo_path` → 回退到 `workspace_path`=零痕迹源仓库 → `git diff origin/<base>` 输出空。真实 diff 只在 cumulative.patch。commit ecaff8f 修过的 0 files 误报被即焚迁移 112e3d6 悄悄打回。
- **影响**：所有即焚终态任务的产出卡「N files changed +x/-y」永久消失或显示 0。用户可点 PR 链接看真实 diff（workaround），属信息性退化。
- **修复**：diff_stat 改从 cumulative.patch 解析，或 submit_pr 成功时把 `git diff --shortstat` 持久化进 task。

### EPH-03 SandboxBrowser「释放」删的是旧 workspace/ 而非展示的 artifacts/
- **位置**：`src/web/src/components/SandboxBrowser.tsx:289`；`src/daemon/routes.ts:1084`；`src/core/sandbox.ts:611`
- **问题**：列表/预览读 `artifacts/`，但「释放」按钮删 `workspace/`（即焚下从不创建），返回 removed=false，产物纹丝不动还提示「workspace 不存在」。
- **影响**：释放功能对即焚模型实际失效（fail-safe：删空目录无数据丢失），文案误导。1a8edfa 只改了 header 没改删除路径。
- **修复**：改用删 `getTaskArtifactsDir` 的 API，同步修对话框文案与路径。

### EPH-04 用户决断 decision.md 写到旧 workspace/，UI 沙盒 tab 读 artifacts/ 永远看不到
- **位置**：`src/daemon/task-actions.ts:201`
- **问题**：gate 决断 `decision.md` 写 `getTaskSandbox()`=workspace/，而同 phase 的 agent-trace/phase.log 与 SandboxBrowser 都用 `getTaskArtifactsDir()`=artifacts/，唯一离群点。
- **影响**：决断记录与产物分家，沙盒 tab 永看不到决断历史；即焚下 workspace/ 不存在则孤儿化。权威记录在 DB（`last_user_decision`）未真丢，属可观测性缺陷。
- **修复**：`:201` 改 `join(getTaskArtifactsDir(taskId), dirName)` 统一。

### RERUN-02 watcher recoveryCount 跨 reject 返工轮不重置，误杀合法返工
- **位置**：`src/core/watcher.ts:58`、`:222`；`src/core/runner.ts:184-187`；`examples/workflows/dev/workflow.ts:320-326`
- **问题**：`recoveryCount` key=`taskId:phase`，phase 成功只清 DB failure_count 不清它。dev 的 code_review 驳回经 retry_develop 重入同一 develop phase（同 key），上轮卡死计数累积。
- **影响**：develop 第一轮被救活 2 次后成功，返工再卡 1 次即达 3 → 任务被误判 failed。`resetTaskForRerun` 已为手动重跑修了同款问题（`task-factory.ts:260`），对称的自动 reject→retry 路径漏了。
- **修复**：phase 成功时（`runner.ts:184` 那块）导出 `clearPhaseRecoveryCount(taskId, phase)` 一并清，或让 recoveryCount 随 failure_count 归零。

### RERUN-07 deleteRemoteDeliverBranch 吞掉「删远程分支真失败」，rerun push 卡满 5 次
- **位置**：`src/core/sandbox.ts:386-411`；`examples/workflows/dev/workflow.ts:346`
- **问题**：42318b6 把 push 改回普通 push，幂等全靠重跑前删远程旧分支。但删分支对 404(良性) 与真失败(受保护/无凭证/网络) 一律 warn 返回 `{deleted:false}`，分不清。
- **影响**：删分支真失败时 rerun 普通 push 撞已存在分支 → non-fast-forward，被判可恢复反复重试 5 整轮完整流水线才 failed，根因对用户完全不可见。
- **修复**：用 gh api 区分 404(幂等成功) vs 其它错误(真失败)，真失败 surface 到 `schedule_error`/任务日志；或 rerun 删失败时回退 `push --force-with-lease`。

### ERL-1 phase 自转移工作流的 phase_event 永不 close，「僵尸 running event」重现
- **位置**：`src/core/runner.ts:216`、`:237`；`src/web/src/components/TaskPhaseTimeline.tsx:31`
- **问题**：close phase_event 被 `if (current.status === phaseDef.running_state)` 守卫，但 shipped 的 dev 各 phase 函数自己 transition+runInBackground，返回后 status 已变 → 守卫为假 → endTaskPhase 永不执行 → event 永久 `status='running'`。
- **影响**：dev 是默认装的，几乎所有真实任务命中——Web「阶段进度」里每个已完成 phase 恒显「进行中」▶ 且耗时无限上涨，currentIndex 卡住；P50 统计只计 done event 长期样本不足。正是 commit 4b0b387 修过的 bug 经成功路径重新引入。
- **修复**：把 `endTaskPhase('done')` 移出 running_state 守卫；最稳是 executePhase 的 finally 顶部对仍开着的 phaseEventId 兜底 close（同时覆盖 ERL-2）。

### SEC-1 JWT 登录仅客户端 AuthGate 生效，服务端不强制
- **位置**：`src/daemon/routes.ts:272`、`:288`、`:478`；`src/web/src/components/AuthGate.tsx:31`
- **问题**：`checkAuth` 第一行 `if (!API_TOKEN) return true`，未设 API token 时全放行，JWT 只是 token 失败后的兜底；WS 升级门完全不查 JWT cookie。配了登录但没设 token 的用户，daemon 对任何来源开放全部 /api 与 WS RPC。
- **影响**：登录页形同虚设（但启动门 `index.ts:118` 强制暴露 0.0.0.0 必须设 token，掐死了「自以为安全实则裸奔」的最危险场景，故降 P2）。残留：loopback 下 LoginPage 纯装饰可 curl 绕过；JWT 子系统不覆盖 WS，LAN 上 JWT-only 浏览器建不了 WS，登录子系统对其设计目的不可用。
- **修复**：`hasAnyUser()` 为真时即便无 API_TOKEN 也校验 JWT（非 loopback）；WS 门支持 JWT cookie 校验。`SEC-6`（启动门不感知 JWT）是其派生项，随之修复。

### SEC-2 /mcp 路由绑 0.0.0.0 时对全网可达且绕过 API token 门
- **位置**：`src/daemon/routes.ts:456-468`；`src/agents/mcp-server.ts:39`
- **问题**：/mcp 在 /api token 门和 loopback 判定之前处理，不做 loopback 限制，只靠 MCP Bearer token。tools/call 暴露 start_task/cancel_task 等可变操作。MCP 客户端永远是本机子进程（URL 回退 127.0.0.1），无理由对 LAN 开放。
- **影响**：多一个对外暴露、可触发任务执行的面，违背最小暴露原则。token 高熵难爆破故 P2，但若 token 泄露可远程 start_task。
- **修复**：给 /mcp 加 `isLoopbackSocket` 闸（与 `/api/fs/list` 同款 403）；token 比较改 `timingSafeEqual`。

### DM-02 workspace `--no-project` 实际只能用一次
- **位置**：`src/cli/workspace.ts:105`；`src/daemon/rpc-methods.ts:1850`；`src/migrations/025-one-workspace-per-project.ts:43`
- **问题**：`--no-project` → RPC 把缺省 project_id 读成空串 `""`，守卫因假值跳过，写入空串。迁移 025 的部分唯一索引把所有空串 project_id 顶层 workspace 视为同一项目，第二条直接 `UNIQUE constraint failed`。
- **影响**：注册第二个不挂项目的本地仓库必失败，且错误是裸 SQLite 文案（用户根本没选项目）。公开 flag 实际只能用一次。
- **修复**：推荐禁掉 `--no-project` 强制挂 project（缺省自动建/选 default），与「Project⊃Workspace」数据模型一致；或把空串归一化为 NULL（但需同步处理 alias 去重）。

### WEB-01 WS 重连后 TaskDetail/RequirementDetail 不补拉核心数据
- **位置**：`src/web/src/pages/TaskDetail.tsx:63`；`src/web/src/pages/RequirementDetail.tsx:532`
- **问题**：TaskDetail 完全不消费 wsState，只增量订阅；RequirementDetail 重连只补拉 clarifier round，req 本体/questions/feedbacks 不补拉。daemon 侧 task/requirement 频道无 snapshot provider。
- **影响**：`daemon stop && start`（升级路径）或网络闪断时，断连窗口内的 done/failed/状态转换事件丢失，重连后因已终态不再有新事件，页面永久显示旧状态（一直转圈「运行中」实际已完成）。`useNowCards`/`RunningTasksIndicator` 都做了补拉，这两个最核心详情页漏了。需 F5 恢复。
- **修复**：两详情页加 `useEffect(() => { if (wsState==="connected") void refresh(); }, [wsState])`；或 daemon 侧为 task/requirement 频道注册 snapshot provider。

### WEB-03 RequirementDetail 多个乐观更新成功后不 refresh，事件丢失即留错误本地状态
- **位置**：`src/web/src/pages/RequirementDetail.tsx:615/639/696/715/734`
- **问题**：`enqueue/approve/markDone/requestFix/retryFromFailed` 乐观 setReq 后只 toast，无 refresh，全靠 WS 事件回收 task_id/pr_url。对照 `markReady/cancel/deleteReq` 都有 `await refresh()`，这几个独缺。
- **影响**：入队/审批成功后若恰逢断连（与 WEB-01 同源叠加），本地停在乐观 `queued` 且 task_id 为 null，显示「排队中」但无执行记录看似卡死，实际调度器已起 task。
- **修复**：每个乐观 mutation 成功分支补 `await refresh({silent:true})`。

### TC-02 deleteRemoteDeliverBranch 的 feat/ 前缀安全护栏零测试
- **位置**：`src/core/sandbox.ts:386-411`；`tests/` 无引用
- **问题**：删远程分支前唯一安全闸是 `meta.branch.startsWith('feat/')` 与 `mode==='clone'` 两道运行时校验，零测试。`feat/` 前缀在 `deliverBranchName`(生成) 和此处(校验) 两文件独立断言、无共享常量。
- **影响**：守卫当前正确，但未来重构分支命名忘同步 startsWith → 对非 feat/ 分支发 DELETE，若撞用户真实分支即触碰「用户仓库零痕迹」最高红线。安全护栏必须有测试钉死。
- **修复**：单测构造 `.worktree.json`：`feat/x`→走到 gh、`main`/`autopilot/x`→断言 `{deleted:false}` 且绝不调 gh DELETE、`mode!=='clone'`→不动远程。

### TC-05 状态机乐观锁并发冲突分支（changes===0）未测
- **位置**：`src/core/state-machine.ts:117-127`；`tests/state-machine.test.ts`
- **问题**：CAS 锁 `WHERE id=? AND status=?` 的 `changes===0` 抛「并发冲突」分支无任何用例触发（四驱动者并发转同一 task 的唯一防线）。
- **影响**：若 `AND status=?` 被误删退化成无条件 UPDATE，并发双写都成功、状态机踩乱，现有测试发现不了。
- **修复**：createTask 到 pending → 手动 `UPDATE status='other'` 模拟抢先 → transition 断言抛 InvalidTransitionError 含「并发冲突」、task_logs 不新增。

### TC-06 失败后成功清 failure_count + isRecoverableError C2 旁路未测
- **位置**：`src/core/runner.ts:183-188`、`:299`；`tests/runner.test.ts`
- **问题**：(1) phase 成功清 failure_count（commit 712df1d 修「正在重试」横幅残留）无「先失败累计→再成功→断言归零」用例；(2) `isRecoverableError` C1/C2 分水岭零测试。
- **影响**：(1) 横幅残留 bug 回退会让正常推进的任务仍显「⚠ 正在重试(n/5)」；(2) 写错会把 git push 冲突当确定性失败一次 failed，重跑幂等来不及发挥，打穿失败自愈哲学。
- **修复**：加 (a) throw 两次不同错攒 count→成功→断言 count=0+指纹清空；(b) 连续 throw 同一 non-fast-forward→断言第 2 次仍 NOT failed、满 5 次才 failed。

### TC-07 anthropic provider idle 超时 + cwd 变更弃 session 两处刚修逻辑无测试
- **位置**：`src/agents/providers/anthropic.ts:216-222`、`:257`、`:386-389`
- **问题**：idle 超时（e56f79c「改 idle 不误杀慢任务」）与 cwd 变弃 session（87bf303「即焚副本 session 复用失败」）两处近期关键修复零覆盖。
- **影响**：idle 逻辑回退 → 正常但慢的 agent 被一刀切 kill；cwd-session 逻辑回退 → 即焚下每 phase 复用已销毁 session，`claude --resume` 报错整 phase 失败。
- **修复**：抽 idle 定时器为可注入 spawn 的纯函数单测（持续吐消息→不 abort；超时无消息→abort）；run(cwd=A)→run(cwd=B) 断言 sessionId 被清。

### TC-08 getPhaseSandboxSpec 即焚生命周期总闸未测
- **位置**：`src/core/registry.ts:128-140`；`src/core/runner.ts:160-173`
- **问题**：解析 phase 的 `{code, ephemeral, deliver}` 缺省值（read-only/ephemeral:true/deliver:false）零测试，runner 完全依赖它分发 capture/release/deliver。
- **影响**：spec 解析回退 → deliver phase 误回写覆盖累积链、read-write 改动没 capture 丢代码、副本不 release 磁盘泄漏。YAML 字段语义改动无回归网。
- **修复**：registry 单测断言省略 sandbox 段→默认值、显式 `deliver:true`/`ephemeral:false`→正确解析。

---

## P3

合并同根的 sandbox 残留与文档漂移，逐条从简：

- **SC-4** `src/core/requirements.ts:82`：`awaiting_review` 缺 `failed` 转换，task failed 时 bridge 同步不了，req 永卡 awaiting_review，pr-poller 持续轮询死 task。→ ALLOWED_TRANSITIONS 给 `awaiting_review` 补 `failed`。
- **SC-6** `src/daemon/rpc-methods.ts:984`：`requirements.transition` 描述称「绕过验证」实则仍走严格校验，且不级联 task。→ 改描述与实现一致。
- **RERUN-01** `src/core/task-factory.ts:214` vs `:257`：docstring 称「保留 task_logs 审计」但实际 `clearTaskRunHistory` DELETE 之（权威审计在 manifest，DB 是可重建缓存）。→ 改 docstring 措辞。
- **RERUN-03** `src/core/watcher.ts:224`：放弃转 failed 时仍 emit `watcher:recovery`，Now 屏同时弹「已自动恢复」+「失败」两张矛盾卡。→ 放弃路径不复用该事件，或 stuck.onEvent `if(toStatus==='failed') return []`。
- **RERUN-04** `src/daemon/task-actions.ts:47`、`src/core/task-delete.ts:18`：终态集缺 `failed` 兜底，自定义工作流显式声明 terminal_states 漏 failed 时无法删除 failed 任务（`data_pipeline` 示例命中）。→ 三处终态集统一抽 helper 并强制并入 `failed`。
- **RERUN-06** `src/core/watcher.ts:19`：卡死判定 fallback 读已废弃 workspace/ 目录，即焚下 mtime 恒 0，防御退化为单信号（但锁守卫 `watcher.ts:168` 兜住实际危害）。→ 改扫 `.agent-runs/` 或显式声明仅靠心跳+锁。
- **RERUN-08** `src/core/task-factory.ts:247`：重跑清 `pr_url` 但不清 `requirement_sub_prs`，子模块旧 PR 链接残留（仅命中集合变化的窄场景）。→ 重跑同处一并清 sub_prs。
- **RERUN-09** `src/core/task-factory.ts:31`：交付分支名耦合可变 title slug 而非纯稳定 taskId（当前无改 title 路径，潜在脆弱点）。→ 分支用 `feat/task-<taskId8>`，PR title 与分支名解耦。
- **EPH-07/EPH-08** `src/core/sandbox.ts:293`（`pickUniqueBranchName` 死代码）、`src/daemon/routes.ts:931`（GET task 返回的 `workspace` 字段即焚下指向不存在目录，UI 可点击复制到空目录）、并行 read-write 子阶段共享 cumulative.patch「最后写赢」静默丢改动（runner.ts:401 已自认 YAGNI）。→ 删死代码、workspace 字段改指 artifacts、registry 禁止并行块内多 read-write 子阶段。
- **CONC-04** `src/daemon/index.ts:251`：scheduler 30s setInterval fire-and-forget 无重入守卫（但 discover 为本地 FS 亚秒级，触发需病态慢盘）。→ 加 `_running` 重入守卫或先占位推进 next_run_at。
- **CONC-06** `src/core/runner.ts:401`：`cancel_all` 名实不符（等全 settle 不真取消兄弟 agent）。→ 改名 `fail_group` 或贯通 AbortController。
- **CONC-07/CONC-08** `src/core/db.ts:142`（无 `busy_timeout`，仅 run-phase.ts 旁路触发 SQLITE_BUSY）、`src/core/watcher.ts:55`（recoveryCount Map 在 cancel/done 终态不清，轻微累积）。→ initDb 加 `busy_timeout=5000`；cancel/done 终态调 `forgetTaskRecoveryState`。
- **ERL-2** `src/core/runner.ts:318`：finally 不兜底 close phaseEventId（核心残留已并入 ERL-1，独立价值仅一条防御性 finally）。→ finally 顶部统一 close 仍开着的 event。
- **ERL-3/ERL-4/ERL-5/ERL-6**：`disableBus` 不解绑 '*' 监听器（进程退出无害）；`computeDiffStat` 先 await exited 再读 stdout（--shortstat 输出极小不会死锁）；OpenAI/Google provider abort listener 不移除（主路径不传 signal）；Windows TerminateProcess 跳过 shutdown（WAL+supervisor 兜底）。→ 均按对称范式补解绑/调顺序/加 removeEventListener，或接受现状。
- **SEC-3/SEC-4/SEC-5**：token 比较用 `===` 非常量时间；git 命令未用 `--` 隔断 base 位置参数（用户自设 `-` 开头 default_branch 触发）；API token 走 query string 留存浏览器历史（WS API 限制下的已知权衡）。→ 封 `secureCompare`；git 位置参数前插 `--` + default_branch 白名单校验；WS 改首帧握手或一次性 ticket。
- **DM-03/DM-04/DM-05/DM-06/DM-08**：部分唯一索引对 NULL project_id 失效（当前无写 NULL 路径，潜在）；NNN 三位 padding >999 时 lex 排序回绕致 ID 碰撞（确定性故障但需 >999 实体）；迁移引擎无 down() 与 CLAUDE.md「可回退」不符；`setup.saveWorkspaces` 缺 1:1 守卫抛裸 SQLite 错；迁移 023 回填直接置 `running` 绕过状态机入口（bridge 守卫兜住）。→ project_id 加 NOT NULL/拒空串；ID 排序改 `CAST(SUBSTR(id,...) AS INTEGER)`；改文档措辞；setup 补守卫+映射；回填改 `queued`。
- **DC-1/DC-2/DC-3/DC-4** + **RO-2**：`coverage:rpc` 工具因不扫 `src/client` 系统性误报 CLI 覆盖为空（97 个「只 web 用」大量假阳性，会误导清理决策）；`tasks.events`/`tasks.subtasks` 死 RPC 三联（注册无调用方）；`requirements.finishClarification`/`retryClarify` RPC 生产死胎（web 走 HTTP 双胞胎，RPC 仅测试覆盖）；CLAUDE.md 称 `/api/repos` 保留至 P6 实际已删。→ 矩阵纳入 client 层或标注间接调用；删死 RPC + HTTP 双胞胎；web 改走 RPC 收敛 HTTP/RPC 并存；更新文档。
- **RO-1** `src/core/card-sources/*`、`src/core/now-types.ts:20`：内核 card-source 硬编码 Web 中文文案 + Web SPA 路由 href，`NowCard.href` 把 Web URL 烤进内核契约（TUI 继承走不通的链接）。注：红线靶子是 trigger/state-machine 命名，此处是展示文案/路由耦合，故 P3 而非 P2。→ card-source 产出语义化动作描述符（`{kind,target}`）由各客户端翻译；href 从必填降级为客户端从 `related.{type,id}` 派生。`task-failed.ts` 的 `invoke:{method,path}` 变体已是现成中立范式。
- **WEB-04/WEB-05/WEB-06/WEB-07/WEB-08**：TaskDetail 切 taskId 不重置旧状态（被 1:1 复用/loading 卸载/路由重定向三重压制，几乎不可达）；`task:prompt-queued/answered` payload 用 `id` 非 `taskId` 致 task:{id} 漏投（伴生 task:updated 兜底，无专属消费方）；Tasks `allRows` useMemo 漏 now 依赖（仅相对时间文本陈旧，分桶用新鲜 now）；删除/取消用原生 `confirm()` 与 ConfirmDialog 体系不一致；rpcCall connecting 期 waitForOpen 5s（被动断连下 mutation 卡满 5s 才反馈）。→ 加 `setTask(null)`/`key={taskId}`；payload 统一 `taskId`；`[tabs, now]` 依赖；统一 ConfirmDialog；disconnected 态 fast-fail。

---

## 【主题归纳】

**主题一：双状态机缺单一协调者（最系统、最危险）**
SC-1/SC-2/SC-3/SC-4/CONC-01/CONC-03/CONC-09/TC-05 全是同一架构裂缝的不同切面：`requirement` 与 `task` 两套状态机 + 四个驱动者（runner Push / watcher / scheduler / 用户操作）没有单一协调层。表现为——req→task 反向驱动缺失（cancel 不级联停 task）、读后改的 TOCTOU 竞态（tickRepo 双起 task）、状态机转换表缺边（awaiting_review→failed）、绕状态机直改 status 卡死（restart）、并行 fork 状态无恢复（waiting_<group> stranded）。`requirement-clarifier` 的 `_inflightRounds` 串行锁是项目内已有的正确范式，但 scheduler 没复用。**根因：req↔task 桥接是单向（task→req）+ 无并发协调原语，每个驱动者各自为政。** 建议设计一个统一的「task 生命周期协调器」承接所有终止/级联/并发抢占，而非散落在 RPC handler 里。

**主题二：即焚 sandbox 重构（2026-06）收口不全**
EPH-01~08 + RERUN-06 + DM 部分：2026-06 把常驻 clone 改即焚副本（`workspace/`→`.agent-runs/` + `cumulative.patch` + `artifacts/`）是 13 个连续 commit 的大重构，但有一批旁路没跟上——`prompt-runner`（cwd 没切，**P0 丢数据**）、`task-outcome`（diff 算源仓库）、`SandboxBrowser`/`task-actions`（删/写旧 workspace/ 目录）、`watcher`（mtime 读旧目录）、MCP `start_task`（整条走旧 clone）、GET task 的 workspace 字段。**根因：重构改了主路径（dev 的 ts 函数 phase），但「读/写 sandbox 目录」的引用散落在 7+ 个文件，缺一次全局 `getTaskSandbox` → `getCurrentSandboxDir/getTaskArtifactsDir` 的收口审计。** dev 工作流恰好绕开了所有坑，所以 dogfood 没撞到——这本身是覆盖盲区的信号。

**主题三：最高 churn 核心路径零测试，回归靠 dogfood 撞**
TC-01~09 集中在 agent-sandbox 即焚全链路、resetTaskForRerun 幂等清理、watcher 止损熔断、状态机乐观锁、provider idle/session、getPhaseSandboxSpec——全是反复修过 bug、改动频繁、坏了不可恢复的承重路径，却完全没有回归网。EPH-01（P0）、ERL-1（僵尸 event）、RERUN-02（误杀返工）这些回归，每一个都本可被一条针对性断言钉死。**根因：测试夹具用 no-op / 无 sandbox 段的 `makeTestWorkflow`，与生产真实行为（自转移 phase + sandbox.git）分叉，测试全绿掩盖缺陷；smoke-test 又不起 daemon、不跑 phase。** 即焚模型上线前应优先补 TC-01/TC-03/TC-04 三条，它们守的正是「静默丢工作成果 / 重跑不幂等 / 永久卡死」三类最贵的故障。

**主题四（次要）：Web 状态完整性与 WS 重连对账**
WEB-01/02/03 + ERL-1：违反 CLAUDE.md「状态完整性优先」红线的几处都源于「乐观更新/增量订阅后不对账」——重连不补拉、mutation 成功不 refresh、服务端某些路径不 emit 事件。`useNowCards` 已有正确的 `wsState===connected` 补拉范式，核心详情页反而漏了。**根因：WS 是 fire-and-forget 增量推送、无断连期事件 replay，客户端缺统一的「重连即全量对账」纪律。** 修复模式统一（成功后 `refresh({silent})` + 重连 effect），优先级在功能正确性之后。
