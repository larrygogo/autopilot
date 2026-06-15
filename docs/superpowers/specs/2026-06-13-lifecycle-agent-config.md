# 生命周期 Agent 配置设计 (2026-06-13)

> 状态：**设计待审**。来源：architect（技术）+ pm（产品）联合设计，主 agent 合成。
> 触发：用户指出「工作流配不了澄清阶段的 agent」，主张「编排分两部分：① 固有生命周期 ② 执行阶段动态流程」。

## 1. 命题与事实校准

用户主张工作流应分两部分。**洞察正确**（生命周期 ≠ 执行流程），但落地形态要校准：

- **平台/daemon 层「生命周期 agent」全集**（写死、无统一配置面）：
  - **clarify**（`clarifier-agent.ts` CLARIFIER_DEFAULTS：anthropic/15turns/bypassPermissions/固定 prompt）—— 需求澄清轮
  - **extract**（`requirement-extract.ts` 复用 buildClarifierAgent）—— 一句话抽 title+spec
  - **fix**（`fix-revision-runner.ts` FIXER_AGENT：max_turns 40/bypassPermissions，挂内置 `__fix` workflow）—— 修复轮
  - **author**（`workflow-author.ts` 复用 buildClarifierAgent）—— AI 建工作流
- **pm 关键校准**：clarify 的 per-req provider/model 覆盖**已有 Web UI**（RequirementDetail ClarifierDialog，写 `clarifier_provider/model` 两列，迁移 016），但**入口卡在 `questions.length > 0`**——澄清解析失败时无 question → 卡片不渲染 → 入口在最该用时消失；且无「换模型重试」闭环。CLI 侧 0 配置/0 重试命令。
- ⇒ 真痛点 = **入口可达性反了 + 失败无恢复出口**，不是「完全没能力」。

## 2. 核心架构决策（architect + pm 一致）

- **生命周期 agent = 平台/数据层配置，归 config.yaml 全局，不进 workflow.yaml**。澄清产出 spec（数据），发生在工作流执行前；绑工作流违背 CLAUDE.md「需求=数据层 / 工作流=逻辑层」红线。**否决「每工作流一套」（B）**：① 语义越界 ② extract 在需求/工作流都不存在时就跑、物理无法绑工作流 ③ 诱发澄清行为碎成 N 份。
- **两层归属**：**全局默认（config.yaml `lifecycle:`）+ clarify 需求级覆盖（复用 016 两列）**。其他三个 agent 无「按需求微调」语义，不做 per-req。
- **RPC 走 `lifecycle.*` 新命名空间**，与 workflows.* / providers.* 并列，**不塞 workflows.setMeta**（协议层就把「执行部分」与「生命周期部分」分清）。
- **零配置逐字节等价现状**：无 `lifecycle:` 段时，4 个 agent 行为与改造前每字段相同（代码兜底 CLARIFIER_DEFAULTS / FIXER_AGENT 保留）。clarify 必保 bypassPermissions、fix 必保 max_turns 40。
- **UI 不在工作流编辑器加「生命周期区」**（pm）：那会暗示澄清属于工作流。落点 = 工作流编辑器配执行 phase（已有）+ **设置页配平台生命周期 agent 默认**（新）+ **需求页失败处就地覆盖**（修可达性）。

## 3. 配置 schema（architect）

config.yaml 顶层 `lifecycle:` 段，四 agent 各自独立、复用 `InlineAgentConfig` 形状（零新类型），字段级 merge（非整段替换）：

```yaml
lifecycle:
  clarify: { provider, model, max_turns, permission_mode, system_prompt }   # 任意子集
  extract: { ... }
  fix:     { ... }
  author:  { ... }
```

合并优先级（每层只覆盖自己声明的字段）：
```
clarify: req.clarifier_*（C，仅provider/model）→ config.lifecycle.clarify（A，全字段）→ CLARIFIER_DEFAULTS（代码）→ providers.<p>.default_model
extract/author: config.lifecycle.<n> → CLARIFIER_DEFAULTS + 各自 system_prompt 兜底
fix:     config.lifecycle.fix → FIXER_AGENT（代码）
```

**全字段而非只 provider/model**：痛点正是配不了 clarifier，system_prompt（提问风格/深度）+ permission_mode（要不要放开 git 探索）才是高价值维度。

## 4. 消费方改造（architect）

新增 `src/daemon/lifecycle-agents.ts`：`loadLifecycleAgentConfig(name)`（读 config + 字段级 merge 代码兜底）+ `buildLifecycleAgent(name, override?)`。各消费方：
- `clarifier-agent.buildClarifierAgent`：起底从 CLARIFIER_DEFAULTS 改 `loadLifecycleAgentConfig("clarify")`，再叠 req override；签名不变（clarifier.ts 零改）
- `requirement-extract` / `workflow-author`：改 `buildLifecycleAgent("extract"/"author")`，各自 system_prompt 作兜底（⚠ extract/author 的输出格式契约在 system_prompt 里，用户覆盖须警示保留格式约定）
- `fix-revision-runner.buildFixWorkflow`：`agent: FIXER_AGENT` → `loadLifecycleAgentConfig("fix")`，FIXER_AGENT 降兜底常量；`agentForPhase` 链路不动
- `clarifier_provider/model` 两列：保留作 clarify per-req 兜底（C），注释从过期的 `agents.clarifier` 更新为 `lifecycle.clarify`

## 5. 存储 + RPC

- **纯 config.yaml，零 DB 迁移、零新表**。config.ts 加 `loadLifecycleConfig` / `saveLifecycleAgent`（section=`lifecycle`，复用 structured writer，merge-safe）。016 两列不动。
- **新 RPC**：`lifecycle.list`（返回 4 agent 的 effective 配置 + userConfig + defaults + reqOverridable）、`lifecycle.setAgent({name, config|null})`（null=删段回退默认，emit config:updated）、（P2）`lifecycle.dryRun`。
- **CLI**：`autopilot lifecycle list/set/reset`；`autopilot req clarify <id> [--provider --model]`（重跑/换模型澄清）。
- **Web**：设置页新增「生命周期 agent」分区（P1 只放 clarify 一卡，复用 phase 内联 agent 编辑器组件）；需求页失败卡（P0）。

## 6. 分期（合 pm 的 P0 止血 + architect 的全量解析器）

### P0 — 澄清失败可达性 + 恢复出口（止血，多数件已存在）
- 需求页**显式呈现澄清失败**（失败卡，露 `clarifier_error`）
- 失败卡给「换模型重试」：复用已有 override 两列 + ClarifierDialog 逻辑，保存即重跑澄清（写覆盖 → transition→clarifying 触发 runClarifierRound）
- **把需求级「模型设置」入口从澄清卡解耦**，drafting/clarifying/失败态均可达（去掉 `questions.length>0` 闸门）
- CLI 对等：`autopilot req clarify <id> [--provider --model]`
- 价值：用户已踩、阻断主流程、绝大部分能力已存在（两列+Dialog+RPC），只差摆对入口 + 接上失败重试。投入小、止血直接。

### P1 — 全局生命周期 agent 配置 + 解析器接通
- `lifecycle-agents.ts` 解析器 + config.ts loader/saver + 4 消费方接通（零配置等价）
- `lifecycle.list/setAgent` RPC + CLI `lifecycle set/reset` + 设置页「生命周期 agent」分区
- **UI 只暴露 clarify**（extract 寄生于 clarify、不单列；fix/author 后端能配但 UI 不放，避免设置页爆炸）
- 满足「全局换 kimi/省钱模型」+ 补 CLI 一等公民

### P2 — 按需
- fix agent 可配（需求级覆盖优先，对齐 clarify 两层）—— 等真有人抱怨修复轮模型
- clarify per-req **全字段** override（迁移 048 加 `requirements.clarifier_overrides JSON`）—— 等验证「不同需求要不同澄清风格」
- `lifecycle.dryRun` 试跑；extract/author system_prompt 格式片段保护；TUI 只读展示

### 不做（YAGNI）
extract 单独旋钮；workflow-author 暴露；工作流编辑器加「生命周期区」（越界数据层/逻辑层）

## 7. 回归风险（P0/P1 必测）
- **零配置等价性**（最高）：无 lifecycle 段时 4 agent 每字段等于现状；快照锁 effective 配置（clarify 保 bypassPermissions、fix 保 max_turns 40）
- clarify 的 req override 必须叠在 config 之上（C 优先 A）；覆盖「req列 + config段」同时存在的合并
- extract/author system_prompt 覆盖可能破坏输出格式契约——有 fallback 不硬崩，UI/文档警示（P1 不做格式守卫）
- `__fix` workflow 热重建读 config 时序：改 lifecycle 配置需 daemon restart 生效（与 host/port 同级，文档写明）
- 改 016 注释（过期的 `agents.clarifier` → `lifecycle.clarify`）

## 8. 待实现复核
- 迁移号：P1 无迁移；P2 若做 per-req 全字段取当时最大+1（当前 047，防撞号）
- config 写入收口 config.ts（非 db.ts single-writer，那是 SQL 收口）
- Web/CLI 同时覆盖（红线）
