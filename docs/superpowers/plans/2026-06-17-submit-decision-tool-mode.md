# submit_decision 工具模式（mode: tool）落地计划

> **第一性对齐**：框架给能力/工具/轨道/保证，决策（何时 pass/reject、判据、人设）归用户工作流定义，AI 执行。`mode: tool` 让做 review 的 agent **自己**出裁决（由用户 prompt 判据驱动），框架只读 + 驱动状态机——比 judge（框架另起一次 LLM 替判）更彻底。

**Goal**：新增 decision `mode: "tool"`——能用 MCP 工具的 provider（claude CLI）走 `submit_decision(verdict, reason)` 工具硬契约；其余 provider 自动降级到等价的「输出结构化 JSON 裁决块」文本契约。三道闸（形状锁/必经锁/轨道锁）落在 prompt-runner，复用现有 `planDecisionActionFromVerdict`。

**已拍板的 3 个决策**：① 地基走 A（per-task mcp-config 带 taskId）② 非 claude 走文本 JSON 块降级 ③ judge 在 P2 dogfood 稳定后退役。

---

## 承重墙：已实证的地基坑（必须先修）

**实证结论**（`bun` 跑最小 repro 坐实）：`AsyncLocalStorage` 不跨 HTTP 请求边界——即便同进程、client 在 ALS 内发请求，inbound handler 的 `getTaskContext()` 仍返回 `null`。真实场景 claude 是独立子进程，更不可能传过来。

**推论**：`ask_user`（及任何工作流 MCP 工具）的 handler 里 `getTaskContext()` **永远 undefined** → ask_user 现在每次都走 `return err("必须在 phase 上下文中调用")`，**从不真正把问题交给人**。daemon 默认单并发只是让它「不崩」。`submit_decision` 必须先补这个地基，并顺手修好 ask_user。

**修法 A**：per-task mcp-config 把 taskId/phase 经 HTTP header 透传，inbound 侧用 `runWithTaskContext` 重建上下文（→ ask_user 现有代码零改动即被修复）。

---

## P0（不碰 dev，可独立交付可回退）

### P0-1 地基：per-task MCP taskId 透传（同时修复 ask_user）
- `src/agents/providers/anthropic.ts`：`resolveMcpConfigPath()` 改为——有 task 上下文时读全局 config、注入 `X-Autopilot-Task`/`X-Autopilot-Phase` header、写 `runtime/mcp-task-configs/<taskId>.json` 返回其路径；无上下文（chat agent）回退全局 config。抽出可测的 `writePerTaskMcpConfig(basePath, taskId, phase)` 导出。
- `src/agents/mcp-server.ts`：`McpServerOptions` 加 `wrapCall?: <T>(fn:()=>Promise<T>)=>Promise<T>`；`tools/call` 用它包 `tool.handler(args)`（保持 mcp-server 通用，不耦合 task 模型）。
- `src/daemon/routes.ts`：`/mcp` 解析两个 header → `wrapCall = (fn)=>runWithTaskContext({taskId, phase}, fn)`（taskId 缺省时不包）。
- `src/daemon/mcp-runtime.ts`：`initMcpRuntime`/`disposeMcpRuntime` 清 `runtime/mcp-task-configs/`（含 token，0o600）。
- 测试：`writePerTaskMcpConfig` 注入 header；mcp-server `wrapCall` 让 fake handler 内 `getTaskContext()` 拿到 taskId。
- ⚠ header 是否被 claude CLI 透传 = 运行期风险点，P0-6 实跑坐实（不行则回退 query 或自定义 token 反查）。

### P0-2 submit_decision 工具 + 捕获位
- `src/agents/pending-decisions.ts`（新）：`captureDecision(taskId, {verdict, reason})` / `takeDecision(taskId)`（读后删）/ `clearDecision(taskId)`。纯进程内存，不入 DB（窗口极短，agent.run 一返回即 take）。
- `src/agents/tools.ts`：`WORKFLOW_TOOL_NAMES` 加 `submit_decision`；handler = `getTaskContext()` 取 taskId（地基修好后有效）→ reject 强制 reason → `captureDecision` + emit `task:decision`。
- 测试：捕获位 roundtrip；handler 在上下文内捕获、reject 无 reason 报错、无上下文报错。

### P0-3 prompt-runner 三道闸（tool 模式分支，main loop 后追加，不动现有流）
- 闸1 形状锁：zod enum 白送（工具）/ `parseVerdictBlock` 解析末尾 `{"verdict","reason"}`（文本）。
- 闸2 必经锁：main loop 后 `takeDecisionVerdict`（工具）或 `parseVerdictBlock(finalText)`（文本）；拿不到 → 框架固定话术 NUDGE 再跑一轮，独立预算 `DECISION_FOLLOWUP_MAX=2`；触顶仍无 → `{verdict:"ambiguous"}`。
- 闸3 轨道锁：verdict → `planDecisionActionFromVerdict` → 复用现有 retry/fail/ambiguous/misconfigured I/O（一字不改）。
- phase 起始 `clearDecision(taskId)` 防 retry 残留。
- `providerSupportsMcpTools(agent)` = `agent.mode==="cli"` 且 `resolveEffectiveProvider(config.provider, config.mode).subtype==="claude"`。
- 测试：tool 模式 pass/reject 驱动；文本路径解析 + nudge 触顶 ambiguous；工具路径 capture 命中 0 nudge。

### P0-4 registry lint 扩 tool
- `registry.ts:284` mode 枚举加 `"tool"`；`:288` `mode !== "judge"` 改 `mode===undefined || mode==="marker"`（tool 不强制 pass/reject）；仍要 jump_target、与 gate 互斥不变。
- 测试：`{mode:"tool"}` 无 pass/reject 但有 jump_target 通过；缺 jump_target 仍拒；未知 mode 拒。

### P0-5 demo 工作流 + 实跑坐实
- `examples/workflows/tool_decision_demo/`：一个 tool 模式 decision phase（claude 路径）+（可选）一个非 claude phase 验文本路径。
- 实跑一条真任务坐实：header 透传到位、claude 真调到 submit_decision、capture 命中、状态机驱动正确。

---

## P1（dev dogfood）
- `${CRITERIA}` 注入：`mode:tool` 时把 `decision.criteria` 自动追加成 review agent 的 prompt 判据尾段（判据从 judge 私有搬回 agent 可见）。
- dev `review`/`code_review`：`mode:judge`→`mode:tool`（去 judge_provider/judge_model，criteria 保留）；先克隆工作流验稳再切 dev；`workflow sync dev --apply` 文档。
- `task:decision` 事件落执行视图（决策时刻看到 agent 自己判了什么）。

## P2（确认稳定后单独 PR）
- 退役 judge：删 `judge.ts` + prompt-runner judge 分支 + lint judge 校验；examples 全量无 judge。

---

## 风险
- R1 header 透传未坐实（P0-6 实跑验，失败回退 query/token）。
- R2 daemon 重启丢捕获位（窗口极短，runner 恢复机制接管，可接受）。
- R3 文本路径解析脆性（compat 不守 JSON → nudge 触顶 ambiguous 停下报人，方向正确，不静默假 pass）。
- R4 nudge 预算与用户 pending_prompts 预算分离（独立 `DECISION_FOLLOWUP_MAX`，不共享 `MAX_PROMPT_TURNS`）。

## 不做（YAGNI）
- 给 codex/gemini CLI、API 模式硬塞 MCP 工具（文本路径已覆盖）。
- 捕获位落 DB / 入 single-writer 白名单。
- verdict 扩 pass/reject 之外语义。
- 立刻删 judge（先并存 dogfood）。
