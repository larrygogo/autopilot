# 声明式 phase 判据 / 分支（消除工作流脚本断崖）

> 状态：设计 spec，待评审。评审通过后再出实现 plan。
> 日期：2026-06-14

## 1. 问题与证据

用户反馈：纯手工写 / 改 `workflow.ts` 里的 `run_<phase>` 函数太难。

读 `examples/workflows/dev/workflow.ts` + `src/core/runner.ts` + `src/core/prompt-runner.ts` + `src/core/registry.ts` 后，**真实难点比表面窄得多**：

### 1.1 大半样板其实已经是框架的活（不需要用户写）

| 用户以为要手写 | 实际上框架已自动做 | 证据 |
|---|---|---|
| phase 结尾 `transition(<phase>_complete)` + `runInBackground(next)` | phase 函数**什么都不做**，runner 自动 `complete_trigger` + 起下一阶段；gate phase 自动挂 `awaiting_<phase>` | `runner.ts:213-265`（"自动推进下一阶段（若阶段函数没主动 transition）"） |
| `readFileSync(上一阶段产物)` 拼进 prompt | `${HANDOFF}`（自动收集所有上游交付摘要）/ `${HANDOFF_<阶段>}`（指定阶段）/ handoff 协议自动落 `handoff.md` | `prompt-runner.ts:85-182`，`makePromptRunner` |
| 注入 `${REQUIREMENT}` / `${WORKSPACE}` / repo 路径 | 模板变量已内置，`${WORKSPACE}` = 共用沙盒 clone 根 | `prompt-runner.ts:expandPromptTemplate` |
| 调 agent | `agentForPhase(wf, phase).run(...)` 由 prompt-runner 代劳 | `prompt-runner.ts:283-307` |
| ask_user 多轮追问消费 | prompt-runner 自动 `consumePendingPrompts` 循环 | `prompt-runner.ts:302-333` |

零代码 `prompt:` 模式（`bindPhaseFunc` 在无 `run_<phase>` 函数但有 `prompt:` 字段时启用 prompt-runner）已经把**线性"调 agent"阶段**完全免代码化。

### 1.2 唯一的断崖：按 agent 输出分支

`dev/workflow.ts` 那 70 行 `run_review` 的**全部本质，是一个判据二分支**：

- agent 输出含 `REVIEW_RESULT: PASS` → 走下一阶段（develop）
- 含 `REVIEW_RESULT: REJECT` → 退回 design 重做，数驳回次数，触顶转 failed

prompt-runner **没有"判据 / 分支"概念**——跑完永远靠 runner 自动往下走。这就是用户一想做"评审 / 验收 / 质量门"就必须掉进 TS 的**唯一原因**。

### 1.3 状态机转换其实也已就绪

`review` phase 配 `reject: design`（已有语法糖）后，`buildTransitions` 已自动生成：

- `review_reject`：`running_review → review_rejected`（`registry.ts:592-596`）
- `retry_design`：`review_rejected → pending_design`（`registry.ts:599-605`）
- `max_rejections`（缺省 10）字段已存在（`registry.ts:237`）

dev workflow.ts 只是**手动调用这两个已存在的 trigger** + 手动数次数 + 触顶 `forceTransition("failed")`。

**结论：补上声明式判据，让 prompt-runner 跑完后自己判、自己调这些已存在的 trigger，就能让"调 agent → 判 PASS/REJECT → 驳回回退 → 触顶报人"整条最常见回路零代码。**

## 2. 目标与非目标

### 目标（北极星，来自 pm 产品判断）

> 用户只写 yaml（prompt + 几个声明字段）就能完整描述一条 PR 交付管线，**包括带"通过 / 驳回回退"分支的评审回路**。碰 TS 的唯一理由，是要做的事已超出"定制 PR 交付管线"这条产品轴。

必须零代码覆盖（不准掉 TS）：

1. 读上一阶段产物喂下一 prompt — **已有**（`${HANDOFF}`），本 spec 只补可发现性
2. **按 agent 输出判据 PASS/REJECT 分支** — 本 spec 核心
3. **驳回回退重做 + 计数 + 触顶报人** — 本 spec 核心（复用已有 `reject:` / `max_rejections`）

### 非目标（红线，防越界成"可视化编排一切"）

- ❌ 不做任意 `if/else/循环`的声明式表达。判据只覆盖**单判据二分支**（pass / reject 回退一个目标）。多路分支、嵌套条件 = 掉 TS 的信号。
- ❌ 判据只支持"在 agent 文本里找标记串 / 正则"。要跑真实校验（编译、测试退出码）再分支的 = 掉 TS。
- ❌ 不优化、不鼓励手写 TS。TS 是逃生舱，文档冷处理。
- ❌ 内核记账（transition 管道 / 计数 / 多库布局 / 产物契约）永不进用户视野。

## 3. 设计

### 3.1 yaml `decision` 字段

在 phase 上新增可选 `decision` 段。仅对 **prompt 模式 phase**（无 `run_<phase>` TS 函数）生效。

```yaml
phases:
  - name: design
    timeout: 900
    prompt: |
      你是资深架构师。根据 ${REQUIREMENT} 输出技术方案。
      ${REJECTION}            # 驳回重做轮自动注入上次驳回理由；首轮为空
    handoff: true            # 产出 handoff 给下游读

  - name: review
    timeout: 900
    reject: design           # 已有语法糖：生成 review_reject + retry_design + max_rejections
    prompt: |
      评审 ${HANDOFF_design} 是否满足 ${REQUIREMENT}。
      最后必须独占一行输出 REVIEW_RESULT: PASS 或 REVIEW_RESULT: REJECT。
      若驳回，在 "## 驳回理由" 下说明。
    decision:                          # ← 本 spec 新增
      pass: "REVIEW_RESULT: PASS"      # 命中 = 通过（走 complete_trigger，框架自动推进）
      reject: "REVIEW_RESULT: REJECT"  # 命中 = 驳回（走 jump_trigger → retry_<target>）
      reason_section: "## 驳回理由"     # 可选：从 agent 输出抽驳回理由，存起来注入下一轮
      # on_reject / max_rejections 不在 decision 里重复 —— 复用 phase 顶层的 reject: / max_rejections
```

**字段语义**：

| 字段 | 必填 | 说明 |
|---|---|---|
| `pass` | 是 | 判定通过的标记。命中 → phase 函数静默返回，runner 自动 `complete_trigger` 推进 |
| `reject` | 是 | 判定驳回的标记。命中 → 走驳回分支（见 3.2） |
| `reason_section` | 否 | markdown 二级标题；从 agent 输出抽该段为驳回理由。缺省取 agent 输出全文截断 |
| `match` | 否 | `"contains"`（默认，子串包含）/ `"regex"`（正则）。`pass`/`reject` 按此解释 |

**判定优先级**：先查 `reject` 再查 `pass`（驳回优先，避免"PASS 但附带 REJECT 字样"误判通过）。两者都不命中 → phase 抛错（`无法解析判据结论`），落失败计数让用户看到（与 dev `run_review` 的 `else throw` 一致）。

**`on_reject` 目标从哪来**：复用 phase 顶层 `reject: <target>` 语法糖派生的 `jump_target`。`decision` 不重复声明回退目标——避免两处真相。若 phase 有 `decision` 但无 `reject:`/`jump_target` → registry lint 报错（"decision.reject 需要 reject: 目标"）。

### 3.2 prompt-runner 接管判据（运行时）

`makePromptRunner` 跑完 agent、拿到 `finalText` 后，若 phase 有 `decision`：

```
1. reject 命中？
   ├─ 是 → 抽 reason（reason_section）
   │      ├─ 数驳回：rejection_counts[<phase>]++（复用 task.rejection_counts JSON，与 dev 同列）
   │      ├─ 未触顶（< max_rejections）：
   │      │     updateTask({ rejection_counts, rejection_reason: reason })
   │      │     transition(jump_trigger)         // review_reject：running_review → review_rejected
   │      │     transition(retry_<target>)       // retry_design：review_rejected → pending_design
   │      │     runInBackground(<target>)        // 回 design 重跑
   │      └─ 触顶（≥ max_rejections）：
   │            notify(task, "...反复驳回，已暂停等待人工", "task-failed")
   │            updateTask({ rejection_counts, rejection_reason: reason })
   │            forceTransition("failed", "...驳回 N 次，已暂停")
   ├─ 否 → pass 命中？
   │      ├─ 是 → 什么都不做（runner 自动 complete_trigger 推进下一阶段）
   │      └─ 否 → throw new Error("无法解析判据结论")
```

**这段逻辑 1:1 复刻 `dev/workflow.ts:run_review` 209-253，只是从用户代码搬进框架。** 用户的 70 行 → 0 行。

**与 runner 自动推进的协作**（关键，已验证）：`runner.ts:220` 的自动推进有守卫 `if (current.status === phaseDef.running_state)`。

- pass：prompt-runner 不动状态 → 仍 `running_review` → runner 自动 `complete_trigger`。✓
- reject：prompt-runner 已 transition 到 `pending_<target>` → 状态 ≠ `running_review` → runner 自动推进被守卫跳过。✓
- failed：forceTransition 到 `failed` → 同上跳过。✓

无需改 runner，纯加在 prompt-runner 内。

### 3.3 驳回理由回注：`${REJECTION}` 模板变量

驳回回退后，目标 phase（design）重跑时**必须拿到上次驳回理由**，否则 agent 看不到要改什么（dev 用 `readFileSync(plan_review.md)` + `rejectionHistory` 拼 prompt 解决）。

新增模板变量（`expandPromptTemplate`）：

- `${REJECTION}` — 最近一次驳回理由（`task.rejection_reason`）。无驳回时为空串。
- `${REJECTION_COUNT}` — 当前 phase 已被驳回次数（可选，给 prompt 写"这是第 N 次重做"）。

design 的 prompt 里写一行 `${REJECTION}` 即可——首轮空、重做轮自动带上理由。**取代 dev 里整段 `rejectionHistory` 手写逻辑。**

> 设计选择：`rejection_reason` 是单列（最近一次），跨多个判据 phase 会互相覆盖。当前 dev 也是单列，够用。若将来多判据 phase 并存需区分，再加 `${REJECTION_<phase>}`（YAGNI，本期不做，spec 留记）。

### 3.4 与 gate（人工决断）的关系

`gate: true` 是**人工** pass/reject（挂 `awaiting_<phase>` 等 UI 点按钮）；`decision` 是 **agent 自动**判。两者互斥：

- 同一 phase 同时有 `gate: true` 和 `decision` → registry lint 报错。
- gate 路径不变（runner 已处理 `await_<phase>`）。

## 4. 兼容性

- **dev / ad-hoc / __fix 零影响**：它们有 `run_<phase>` TS 函数，`bindPhaseFunc` 优先用 TS 函数，根本不进 prompt-runner。`decision` 是 prompt 模式专属、opt-in。
- **现有纯 prompt 工作流零影响**：没写 `decision` 的 prompt phase 行为完全不变（跑完自动推进）。
- **registry / 状态机零改动**：`decision` 复用已生成的 `jump_trigger`/`retry_<target>`/`max_rejections`/`complete_trigger`，不新增转换类型。
- **PhaseDefinition 类型**：加可选 `decision?: PhaseDecision` 字段（registry.ts 类型 + 透传，不做语义——枚举语义在 prompt-runner）。

## 5. Web 编辑器暴露（含可发现性止血）

工作流 = 一等公民，新能力必须 Web + CLI 同时覆盖（CLAUDE.md 落地原则）。

1. **PhaseEditForm 新增「判据 / 分支」段**（prompt 模式 phase 才显示）：pass 标记、reject 标记、reason_section、回退目标（下拉选已有 phase，写回 `reject:`）、match 模式。
2. **prompt 输入框变量提示补全**（独立的可发现性修复，无论 decision 做不做都该补）：当前只列 `${TASK_TITLE} ${REQUIREMENT} ${WORKSPACE} ${PHASE}`，补 `${HANDOFF}`、`${HANDOFF_<阶段>}`、`${REJECTION}`、`${REJECTION_COUNT}`、`${TASK.<字段>}`，每个带一句说明。
3. CLI：`workflow show` 输出 decision 字段（只读够用，编辑走 yaml import / Web）。

## 6. dogfood 验证（可选，建议做）

把 `examples/workflows/dev` 的 `review` phase 从 TS 函数改成声明式 `decision`，作为"70 行塌缩成 6 行"的活证。
- 风险：dev 是产品工作流，改它要 `workflow sync dev --apply` 推给老用户。
- 折中：**先不动 dev**，新建一个 `examples/workflows/review_loop`（最小评审回路示例）作为声明式判据的范例 + 测试夹具，dev 保持 TS 直到声明式经一轮 dogfood 稳定。

## 7. 测试计划

- 单元（prompt-runner）：
  - reject 命中 → 调 jump_trigger + retry + runInBackground（mock transition，断言调用序列与参数）
  - pass 命中 → 不动状态（runner 自动推进路径另测）
  - 都不命中 → throw
  - 触顶（rejection_counts 达 max_rejections）→ forceTransition failed + notify
  - reason_section 抽取（命中段 / 缺段降级取全文）
  - match: regex 模式
- 单元（expandPromptTemplate）：`${REJECTION}` / `${REJECTION_COUNT}` 解析（有/无驳回）
- 集成：`review_loop` 夹具跑通 pass 路径 + reject 一轮回退路径 + 触顶 failed 路径
- 回归：dev 工作流（仍 TS）行为不变；纯 prompt 无 decision 行为不变

## 8. 落地顺序（评审通过后出实现 plan）

1. **可发现性止血**（独立、零风险、先合）：编辑器变量提示补全 + 文档讲清"零代码 prompt 模式能做到哪、何时掉 TS"。
2. 类型 + 模板变量：PhaseDefinition.decision 类型、`${REJECTION}`/`${REJECTION_COUNT}`。
3. prompt-runner 判据接管（核心）+ 单元测试。
4. registry lint（decision 需 reject 目标；decision×gate 互斥）。
5. `review_loop` 示例夹具 + 集成测试。
6. Web 编辑器「判据 / 分支」段。
7.（可选，后续）dev review phase 声明式化 dogfood。

## 9. 待评审决策点

1. `reason_section` 缺省行为：取全文截断 vs 报 warn 要求必配？（倾向：缺省取全文，warn 提示）
2. `${REJECTION}` 单列覆盖问题：本期单列够用，还是直接上 `${REJECTION_<phase>}` 多键？（倾向：单列，YAGNI）
3. dogfood：是否本期就把 dev review 改声明式？（倾向：否，先 `review_loop` 示例，dev 稳定后再迁）
4. `match` 是否本期就支持 regex，还是先只做 `contains`？（倾向：先 contains，regex 留字段位）
5. 判据标记的"独占一行"要求：是否强制 agent 输出在独立行（更稳的解析），还是子串包含即可？（倾向：contains 子串，文档建议独占行）
