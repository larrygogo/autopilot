# 逐 phase 工具能力授权（细粒度工具接口）

> 状态：设计 spec（已据 architect 方案定稿决策），第一刀实现中。
> 日期：2026-06-14

## 目标

把现在开放给 agent 的工具能力拆成**可逐个授予的细接口**，让工作流精确控制每道 phase 的 agent 能碰哪些工具。典型：`review` 阶段只读（read/search/fetch，禁 write/bash/delete）、`develop` 全开。

## 现状（两套世界 + 粗粒度）

- **API agent**（`src/agents/providers/api/tools.ts`，autopilot 自定义工具）：10 工具，控制粒度只有 3 档 `permission_mode`（唯一逐工具区分=cautious 关 bash），无 web_search（只有 fetch_url 抓指定 URL）。
- **CLI agent**（claude/codex/gemini，工具来自 CLI 本身）：仅靠 `--allowed-tools` flag，目前只放行 MCP；工作流作者控制不了；各 CLI 工具名不同，codex/gemini **无逐工具开关**（只有 read-only / read-write 粗档）。

## 定稿决策

1. **统一能力词汇表（9 名）**：`read / list / search / write / edit / delete / bash / web_fetch / web_search`。框架级常量，零业务语义。
2. **声明位置 = agent 块内 `tools: [...]`**（白名单）。**偏离 architect 的「phase 顶层」建议**，理由：`permission_mode`（同类的"能力控制"维度）本就在 agent 块，`tools` 是它的正交邻居，co-locate 一致 + 接线零绕路（直接随 `config` 流进 `createApiAgentLoop`，无需单独把 phase.tools 穿透）。缺省（不写）= 全集 = 现状（兼容红线）；`tools: []` = 只剩控制通道（纯思考 phase）。
3. **正交于 permission_mode**：`tools` 管"给哪些工具"，`permission_mode` 管"危险操作防护强度"，叠加不替代。例：`permission_mode: default + tools: [read, search]` = 只读+搜且仍有危险防护。
4. **控制通道工具永久豁免**：`task_complete`（API）/ `mcp__autopilot__*`（CLI）是引擎↔agent 协议通道，**永不受 tools 授权约束**（否则 review 配 `tools:[read]` 会把"完成"工具滤掉 → loop 永不终止）。**最大坑点，测试必覆盖。**
5. **web_search 本期不做 API 实现**（用户拍板）：CLI agent（claude/gemini）的 web_search 是 vendor 烤进自己 CLI+服务器的，autopilot 只能放行/禁用；API 模式无搜索（自接 Brave/Serper 是另一坨基础设施）。本期 `web_search` 能力名占位，API 模式 degrade-silent，CLI 第二刀放行。
6. **后端能力差异（如实声明，不给精确控制的错觉）**：API + claude CLI 能精确逐工具；codex/gemini CLI **无逐工具开关**，只能塌缩成 read-only/read-write 粗档 + warn。

## 落地顺序

- **第一刀（本期，API 模式，风险最小、全在自有代码）**：
  - 新增 `src/agents/tool-capabilities.ts`（纯模块）：`CAPABILITIES` 词汇表、`expandToApiTools(caps)→Set<API工具名>`（永含控制通道）、`unknownCapabilities(caps)`、`isKnownCapability`。
  - `tools.ts`：`getToolDefinitions(mode, allowedApiTools?)` 加白名单交集；`ToolExecutor` 持 `allowedTools` + `fromConfig(sandboxRoot, mode, toolCaps?)`；`_dispatch` 拒未授权工具（双保险，防 LLM 幻觉调用被 filter 掉的工具）。
  - `InlineAgentConfig` + `AgentConfig` 加 `tools?: string[]`。
  - `registry.createApiAgentLoop`：`config.tools` → `ToolExecutor.fromConfig(..., config.tools)`；未知能力名 log.warn。
  - 测试：能力展开 + 控制通道豁免 + 未知名忽略 + getToolDefinitions 白名单过滤 + 缺省=全集（兼容）。
  - **只影响 API agent**；CLI agent（dev 默认走 claude）第一刀不受影响。
- **第二刀（后续，CLI claude 映射）**：anthropic.ts 接 `--allowed-tools`/`--disallowed-tools`（强度需真机实测，单独 PR + dogfood）；codex/gemini 粗档回退 + warn。
- **follow-up（不做）**：API 模式真 web_search（自接搜索后端）；codex/gemini 精确逐工具（待上游 CLI 支持）。

## 能力 → API 工具映射（第一刀）

| 能力 | API 内部工具 |
|------|-------------|
| read | read_file |
| list | list_directory |
| search | search_files |
| write | write_file, create_directory |
| edit | write_file |
| delete | delete_file, move_file |
| bash | bash |
| web_fetch | fetch_url |
| web_search | （无，degrade-silent） |
| （控制通道，永久） | task_complete |

## 兼容 & 回归

- `tools` 缺省 = 全集，老 4 个工作流副本零改动、行为不变。
- 第一刀回归面极小：全在自有 API loop，permission_mode 旧逻辑一行不动，新逻辑仅在 `tools !== undefined` 时介入。
- 旁注：`AgentConfig.max_budget_usd` 字段已存在但未接线（供未来"预算护栏 / 烧钱止损"用，见监督层讨论的第 0 刀）。
