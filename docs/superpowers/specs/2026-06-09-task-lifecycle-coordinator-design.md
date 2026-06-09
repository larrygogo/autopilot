# A1：任务生命周期协调器 — 设计稿

> 来源：architect subagent 对 backlog A1 的核实后设计（2026-06-09）。本稿是 spec，未排实施计划。
> 实施前需用 writing-plans 拆成 TDD 任务，并先验证文末「开放问题」。

**目标**：给每个正在执行的 task run 一个进程内取消令牌，让 cancel 能真正打断 in-flight phase（关闭 CONC-09），并把散在 4 处的级联取消收编进单一 core 入口——但**不**接管 req↔task 双状态机同步（那是更晚的独立议题）。

**核心重定义**：A1 不是「状态转换协调器」（`state-machine.ts` 已经是那个单点——有乐观锁/审计/manifest 同步）。缺的是**执行生命周期协调器**：谁在跑、怎么打断正在跑的东西、终止后的副作用补偿。

---

## 0. 核实后对问题陈述的修正（影响设计的关键事实）

1. **五个驱动者耦合点比想象浅**。它们只通过两条边交互：(a) 都最终调 `transition`/`forceTransition`（state-machine 是状态写入唯一收口，已是单点）；(b) 都通过 `runInBackground`/`executePhase` 启动执行。→ 协调器的边界是「执行生命周期」，不是「状态转换」。

2. **CONC-09 的 abort 管道已修好七成**。`RunOptions.signal` 是一等公民；`anthropic.ts` 的 `spawnClaudeAndConsume` 已把 signal 接到 `proc.kill()`（同步检查 + listener 双保险）；`Agent.run` 已从 `getTaskContext()` 取 ctx。**只差一根线**：cancel → 存的 AbortController → 注入 task-context → `Agent.run` 透传给 provider。→ CONC-09 从「大重构」降级为「接管子」。

3. **git 操作不可中断，是补偿语义的真正难点**。dev `workflow.ts` 的 `runGit` 用 `Bun.spawnSync`（同步阻塞、无 signal）；`submit_pr` 的 push / `gh pr create` 同样。**AbortSignal 对 spawnSync 完全无效**——只能在 phaseFn 的 `await` 让出点之间检查，无法打断正在执行的同步 `git push`。→ submit_pr 补偿不能靠「中途 kill git」，只能靠「phase 边界协作式检查点 + 重跑幂等清理」。

4. **「cancel 是异步的」注释是幻觉**。`cancelTaskAction` 被 4 处独立调用（task cancel RPC、cancelRequirementWithTasks、删需求、删项目），每处自写 `for(listRootTasks){try cancel}catch{}`，3 处注释写「cancel 是异步的，这里不 sleep」——但 cancel 当前**完全同步且不打断 in-flight phase**。注释描述的「异步收敛」不存在。这是协调器要收编的真实重复。

---

## 1. 协调器职责边界

**命名**：`src/core/task-lifecycle.ts`（框架级、零工作流知识）。唯一新增能力：为每个「正在执行的 task run」维护进程内 `AbortController` + 取消信道。

**承接**（成为单一入口）：
- per-task 取消令牌生命周期（建/取/触发/废弃）。这是它存在的核心理由。
- `cancelTask(taskId)` 统一语义 = transition→cancelled + abort in-flight signal + `closeOpenPhaseEvents` + `forgetTaskRecoveryState`。`task-actions.ts` 的 `cancelTaskAction` 变薄 wrapper（保留 `TaskActionError` 映射给 transport 层）。
- 级联取消单一实现：`cancelTasksForRequirements(ids)`，收编现在散在 4 处的 `for(){try cancel}catch{}`。

**不承接**（明确留原处，防范围蔓延）：
- state-machine 原子转换（`transition`/`forceTransition` 不动，协调器调用它不替代它）。
- 具体 phase 业务逻辑（dev `workflow.ts` phaseFn 不动，除 submit_pr 协作检查点——那是 workflow 层自愿加的）。
- Push 模型本身（`runInBackground`/`executePhase` 推进逻辑不动，只在入口/出口登记/注销 controller）。
- watcher 卡死检测（恢复判定保留；watcher 转 failed 时顺手 abort 是加一行调用，非合并）。
- **req 状态机 + scheduler + bridge 的 req↔task 同步（本次不收编，见 §6 YAGNI）**。

**依赖方向**：
```
                 state-machine.ts  (transition/forceTransition)  ← 不变，最底层
                       ▲
       ┌───────────────┼────────────────┐
   task-lifecycle.ts  runner.ts        watcher.ts
   (controller 登记)  (executePhase)   (卡死恢复)
       ▲               │ 登记/注销         │ abort+force
   task-actions.ts ──► cancelTask / cancelTasksForRequirements
   (RPC wrapper)
       ▲
   rpc-methods.ts  (4 处 cancel 调用 → 全走协调器)
```

不替换 bridge（事件投影器，正交）/ scheduler（`_inflightGroups` 串行锁保留）/ watcher（无人值守兜底）。**协调器是 core 纯机制层，不认识 submit_pr/dev/review，守住「框架核心零业务知识」红线**。

---

## 2. per-task 取消令牌（CONC-09 核心）

### 2.1 数据结构（仿 `_inflightRounds`/`_inflightGroups` 成熟范式）
```ts
// key = taskId。executePhase 入口 acquireLock 保证同一 task 同时只有一个 phase 在跑
//（并行块是单 executeParallelGroup 调用内的 Promise.allSettled，仍在同一把锁下），故一对一。
const _controllers = new Map<string, AbortController>();
```

### 2.2 signal 贯穿链路
```
cancelTask(taskId) → _controllers.get(taskId)?.abort()        ← 触发
executePhase 入口：new AbortController() 存入 _controllers，signal 放进 TaskContext
  → runWithTaskContext({ taskId, phase, sandboxDir, signal }, () => phaseFn(taskId))
  → Agent.run: runOptions.signal = options?.signal ?? ctx?.signal   ← 唯一注入点
  → provider.run({ signal }) → spawnClaudeAndConsume({ signal })  ← 已有：signal→proc.kill()
```

**核心改动点（小且集中）**：
1. `task-context.ts`：`TaskContext.signal?: AbortSignal` + `getCurrentAbortSignal()`（与 `getCurrentSandboxDir()` 对称）。
2. `runner.ts` executePhase + executeParallelGroup：入口 `registerRun`、`finally` `unregisterRun`、ctx 带 signal。
3. `agent.ts` Agent.run：`signal: options?.signal ?? ctx?.signal`（显式传入优先，否则用 ctx 兜底）。
4. `task-lifecycle.ts`：新文件，`registerRun/unregisterRun/abortRun/cancelTask/cancelTasksForRequirements`。

**关键收益**：注入点放在 `Agent.run` 而非各 phaseFn → `prompt-runner.ts`（直接调 `agent.run` 不传 signal）**零改动自动获益**，所有走 `agent.run` 的 phase 都自动可中断。

### 2.3 signal 生命周期
| 时机 | 动作 | 位置 |
|---|---|---|
| 建 | 拿锁、确认 task/workflow 后 `registerRun(taskId)` | runner.ts 入口（setPhase 后、phaseFn 前） |
| 触发 | `cancelTask`/`abortRun` 调 `controller.abort()` | task-lifecycle.ts |
| 正常废弃 | `executePhase` finally `unregisterRun`（成功/失败/挂起均过） | runner.ts finally（与 releaseLock 同块） |
| 重跑换新 | 旧 controller 已在上轮 finally 注销，新 executePhase 建全新 controller（无需在 resetTaskForRerun 显式管） | 天然由 executePhase 生命周期处理 |

**边界情况**：
- cancel 命中「两轮之间」（上 phase 已注销、下 phase 未注册）：`abortRun` 返 false 不抛，但 `cancelTask` 的 transition→cancelled 生效；下个 `executePhase` 入口发现已是 cancelled 终态 → transition 抛 `InvalidTransitionError` → 现有守卫（executePhase:131-143）warn 跳过。**无新风险**。
- register 时 map 已有旧 controller（不该发生，锁保证）：防御性先 abort 旧的再覆盖，防泄漏。

---

## 3. submit_pr 中途 abort 的补偿语义

### 3.1 残酷约束
`submit_pr` 的 commit/push/`gh pr create` 全是 `Bun.spawnSync`。**AbortSignal 无法打断 spawnSync**。submit_pr 里唯一让出点是生成 PR body 的 `await agent.run`——cancel 若在它之前命中，则 **commit+push 已完成、PR 未创建**。**靠 signal 精确卡在某半态收口，技术上做不到**（除非把 git 异步化，YAGNI）。

### 3.2 设计选择：协作式检查点 + 幂等重跑兜底（不追求中途精确收口）
呼应「失败自愈哲学」：补偿不靠「撤销半成品」，靠「重跑幂等清理 + 让半成品无害」。

| 半态 | 设计后行为 |
|---|---|
| **已 commit 未 push** | **无需补偿**——commit 只在 task 独立 clone，源仓库零痕迹；重跑 `resetTaskForRerun` 删整个 clone 重 clone，半 commit 蒸发 |
| **已 push 未开 PR** | **重跑兜底**——`resetTaskForRerun` 已调 `deleteRemoteDeliverBranch` 删远程交付分支。⚠️ 但**用户直接 cancel 不重跑时，孤儿分支留在远程**（已知可接受残留，见 §3.4） |
| **已开 PR** | **无需补偿**——PR 是有效交付物，task cancelled 但 PR 在，用户自行决定 merge/close；重跑 `gh pr` 检测 OPEN PR 复用 |

### 3.3 协作式 abort 检查点（workflow 层，可选增强）
submit_pr 不可逆操作前加检查，把「已 push 未开 PR」窗口从「整个 push+create」缩到「push 单命令执行期间」：
```ts
// dev workflow.ts run_submit_pr，push 之前
const signal = getCurrentAbortSignal();
if (signal?.aborted) throw new Error("任务已取消，submit_pr 中止于 push 前");
runGit(["add","-A"], repoPath); runGit(["commit", ...], repoPath, false);
if (signal?.aborted) throw new Error("任务已取消，submit_pr 中止于 push 前");
runGit(["push", ...], repoPath);
```
⚠️ 检查点抛错会进 executePhase catch → 失败计数路径。但此时 task 已 cancelled 终态，需验证不会把 cancelled 误翻 failed（见 §5 必钉测试）。

### 3.4 必须做 vs YAGNI
**必须做**：§2 全部（AbortController 贯穿）；submit_pr push 前协作检查点（1 处 workflow 层）；验证「cancel→重跑删 clone + 删远程分支」覆盖半态（多为确认现有 resetTaskForRerun 已覆盖 + 补测试）。

**YAGNI（不做）**：
- ❌ runGit 异步化 + 每条 git 命令检查 signal（push 通常几秒、单用户本地命中概率极低，改动面远大于收益）。
- ❌ cancel 时主动 `git push --delete` 远程半推分支（需 core 知道 submit_pr 业务概念 + 分支命名，**违反 core 零业务知识红线**；纯 cancel 不重跑的孤儿分支作为已知可接受残留——源仓库零痕迹红线仍守住，孤儿在远程不污染本地）。
- ❌ 「已开 PR 后 cancel 自动 close PR」（PR 有价值，自动 close 反删用户可能想要的；停下报人不自动撤销）。

---

## 4. 分阶段迁移路径

每阶段可独立合并、各带回归网、各过 `bun test`+`bun run typecheck`。

### 阶段 1：AbortController 贯穿（CONC-09 核心，第一步）· 低风险高价值
**为什么第一**：abort 管道已修好七成，这步只「接一根已存在的管子」，纯增量——不删不改现有止血，只在 cancel 路径上多 abort 一下。即使后续阶段不做，本步即关闭 CONC-09。

改动：新建 `task-lifecycle.ts`（仅机制：`_controllers` + `registerRun/unregisterRun/abortRun`，先不收编级联）；`task-context.ts`（signal + getter）；`runner.ts`（register/unregister/ctx 带 signal）；`agent.ts`（signal 兜底）；`task-actions.ts` cancelTaskAction transition 后加 `abortRun`。

回归面：finally 任何 return 都过（现有 try/finally OK）；register 必须在 acquireLock 成功后；测试 (a) cancel 运行中→signal.aborted (b) 正常完成→map 清空 (c) cancel 两轮之间→abortRun 返 false 不抛、transition 仍生效。

### 阶段 2：cancelTask 收口 + 级联单一实现 · 中风险
前置：阶段 1。改动：`task-lifecycle.ts` 加 `cancelTask` + `cancelTasksForRequirements`；`task-actions.ts` cancelTaskAction 变薄 wrapper、cancelRequirementWithTasks 改调级联函数；`rpc-methods.ts` 4 处 `for(){try}catch{}` 统一调级联函数 + 修 3 处「cancel 是异步的」过期注释。

回归面（触及 SC-1 级联，最谨慎）：**SC-1 不能复活**（取消有运行中 task 的需求 → task cancelled + abort + req cancelled）；删需求/项目 best-effort 不变；closeOpenPhaseEvents/forgetTaskRecoveryState 不漏（CONC-08 不复活）。

### 阶段 3：submit_pr 协作检查点 + 半态重跑覆盖验证 · 低风险
前置：阶段 1（需 getCurrentAbortSignal）。可与阶段 2 并行。改动：run_submit_pr push 前 2 处检查点；补测试（cancel 命中 develop→重跑删 clone 不泄漏；cancel 命中已 push→删远程分支）。回归面：检查点抛错不把 cancelled 误翻 failed；不影响正常 submit_pr。

### 阶段 4（可选，YAGNI 边界）：watcher 放弃任务时 abort
watcher `forceTransition(failed)`（recoveryCount 触顶）时若仍有 in-flight controller 顺手 `abortRun`。价值低（watcher 判卡死前提是没持锁、controller 多半已注销），列可选。

---

## 5. 回归面评估：最可能复活哪些已修 bug

| 已修项 | 复活风险 | 必钉死不变式 |
|---|---|---|
| SC-1 取消需求级联停 task | **高**（阶段 2 重写级联） | 取消需求→所有 root task cancelled + signal abort + req cancelled |
| CONC-08 cancel 清 watcher 计数 | 中 | cancel 后 recoveryCount map 无残留 |
| ERL-2 僵尸 phase event | 中 | cancel/完成后无 open phase event |
| SC-2 restart 409 | 低（不在收编范围） | running+isLocked 时 restart 抛 409 |
| CONC-09 自身（注入点错位） | 中 | cancel prompt-runner phase→子进程收到 abort（验证注入点在 Agent.run） |
| **确定性失败止损 / failure_count** | **中（最危险）** | **cancel 导致的 abort 错误不应累加 failure_count / 不应 forceTransition→failed** |
| submit_pr 半态 | 中 | cancel 命中 push 前→cancelled（非 failed），无半 PR 或被重跑覆盖 |

**最危险回归——abort 错误污染失败计数**：当前 executePhase catch 把任何非 InvalidTransitionError 当 phase 失败（计数 + 可能 forceTransition→failed）。cancel 触发的 abort 让 `agent.run` 抛「被取消或超时」→进 catch。需在 catch **开头优先判断 task 是否已 cancelled / signal 是否 aborted**，是则静默退出而非失败计数：
```ts
const tNow = getTask(taskId);
if (signal.aborted || (tNow && tNow.status === "cancelled")) {
  log.info("phase 因取消中止 [task=%s phase=%s]", taskId, phase);
  return;  // 静默退出，finally 注销 controller
}
```
**这是阶段 1 必须一并处理的细节**，否则 CONC-09 修复会引入新「cancel 后任务被标 failed」bug。

---

## 6. YAGNI 边界（明确不做）

1. ❌ **统一 req+task 双状态机 / 协调器接管 req↔task 同步**——最诱人但风险极高（动 scheduler+bridge+clarifier 三处已验证的 `_inflight` 锁），单用户收益有限（不一致窗口已被各锁 + 乐观锁 + watcher 兜住）。协调器只管 task 执行生命周期。「双状态机协调」留作更晚的独立议题（见 MEMORY `state-machine-robustness`）。
2. ❌ git 全异步化以支持精确中断（§3.4）。
3. ❌ 协调器做跨 task 全局调度/优先级/抢占（scheduler per-group 串行已够，单用户不需要）。
4. ❌ per-phase（而非 per-task）controller 粒度（锁保证 task 内单 phase；并行块子阶段共享 task 级 signal，CONC-06「真取消兄弟」另算且已 defer）。
5. ❌ 持久化 controller / cross-restart 取消（AbortController 进程内；重启后 in-flight 靠 watcher 恢复，不需持久化取消令牌）。
6. ❌ cancel 时主动清远程孤儿分支（§3.4，违反 core 零业务知识红线，留 workflow cancel hook 机制，未来）。

---

## 开放问题（实施前/实施中需验证）

1. **失败计数污染（§5 最危险项）**：cancel→abort→agent.run 抛错进 catch→是否脏写 failure_count / 误触 forceTransition。推断「forceTransition 因终态被吞但 updateTask 在其前执行」，但**需实跑 cancel-during-develop 集成测试确认终态**。建议阶段 1 先写此测试（红）再加 catch 守卫（绿）。
2. **OpenAI/Google provider abort 完整性**：仅核实 anthropic 的 signal→kill 完整。审计 ERL-5 提示「OpenAI/Google provider abort listener 不移除（主路径不传 signal）」，暗示其 signal 处理可能不如 anthropic 完整。dev 默认 anthropic，但若有 phase 配 openai/google，**需核实这两个 provider 的 spawn+signal 实现**。
3. **submit_pr commit→push 间是否真无 await**：现状是连续 spawnSync 无让出点。若未来插入 await，§3.2「已 commit 未 push 难命中」结论会变。以现状为准。
4. **manifest 同步与 abort 的交互**：transition→cancelled 触发 `appendManifestTransition`。abort 正在写 manifest 的 phase 是否有竞态，未深入 manifest.ts。低概率，若阶段 1 测试出现 manifest 不一致再查。
