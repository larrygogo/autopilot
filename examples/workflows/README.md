[中文](README.md) | [English](README.en.md)

# 示例工作流

本目录是 autopilot 的工作流模板库（`autopilot workflow create` 从这里克隆模板），分两档：

- **产品模板** —— PR 交付形态。接入平台完整增值服务：需求澄清、按仓库调度、PR 验收、fix_revision 修复回路、CI 自动修复。bridge 按「有无交付 PR」泛化判断（不认 phase 名），所以从这档派生的自定义变体（加阶段 / 换 phase agent / 调驳回 / 加并行块）只要最终交付 PR，全套增值服务照拿。**自定义工作流请从这档起步。**
- **引擎能力演示** —— 教学 fixture，展示状态机 / YAML 的引擎特性（手写 transitions、前向跳转、多终态、并行、hooks、零代码 prompt），是 `docs/state-machine.md` 等文档的活教材。**只依赖引擎契约，不接入需求闭环的增值服务**，跑起来在 Web 决策台上也没有对应的决策环节——参考其写法即可，不建议直接拿来干活。

> 产品定位见根目录 `CLAUDE.md`「产品分层定位」：工作流自定义当前的产品支持范围 = PR 交付管线的定制轴，不是任意流程编排平台。

## 安装

`autopilot init` 自动安装 **dev** 和 **ad-hoc** 两个产品工作流。其余模板按需克隆：

```bash
autopilot workflow create <name>      # 交互式从模板派生

# 或手动复制
cp -r examples/workflows/doc_gen/ ~/.autopilot/workflows/doc_gen/
```

老用户同步 repo 内模板的 bug fix：`autopilot workflow sync dev`（dry-run 看 diff，加 `--apply` 真覆盖）。

## 产品模板（PR 交付形态）

### dev — 完整开发流程（init 自动安装）

5 个阶段：方案设计 → 方案评审 → 开发 → 代码审查 → PR 提交

- `workflow.yaml` — 工作流定义（自动推导 + reject 语法糖 + phase 内联 agent）
- `workflow.ts` — 阶段函数实现
- `config.example.yaml` — 配置模板

**展示特性**：完整需求闭环（澄清 → 执行 → submit_pr 交付 → pr-poller 验收 → fix_revision 修复）、reject 驳回机制、驳回触顶停下报人、多库需求各自交付 PR

### ad-hoc — 即兴任务（init 自动安装）

单阶段零代码工作流，`autopilot run "<prompt>"` 的默认 workflow：跳过项目/需求重流程，直接跑一个 agent prompt。传 workspace 时在其上建沙盒，不传则退化空目录（适合写文档、生成脚本、实验）。

### req_dev — 需求开发（dev 的简化变体起点）

design → review → develop → code_review → submit_pr，每个 phase 就地内联 agent 配置。适合作为派生自定义 PR 交付管线的精简起点。

### artifact — 产物交付（v2 R5 正式形态）

produce（agent 产出到沙盒 `deliverables/`）→ deliver（`deliverArtifacts` promote 到需求 `runtime/requirements/<reqId>/deliveries/round-<N>/` 并落 `requirement_deliveries` 表）。验收在需求级：run 完成后需求转 awaiting_review，Web 验收卡 / CLI `req accept|reject` 人工通过或驳回（驳回 → fix_revision 修复轮重做产物 promote round+1）。声明层 `requires: {git: "optional"}` + `delivers: artifacts` —— 无代码库需求也能走完整闭环。
（探针期的 produce gate hack 与 `AUTOPILOT_HOME/deliverables/` 归档已废弃；老用户同步：`autopilot workflow sync artifact --apply`。设计基准见 `docs/superpowers/specs/2026-06-12-deliverable-abstraction-design.md`。）

## 引擎能力演示（教学 fixture）

### prompt_quick — 提示词速写

2 阶段零代码：仅在 yaml 里写 `prompt:`，框架内置 prompt-runner 自动调 agent 执行，无需任何 ts。**展示特性**：零代码工作流、handoff 协议（`${HANDOFF}` 跨阶段传递）、phase 内联 agent

### doc_gen — 文档生成与评审

2 阶段最小结构示例。**展示特性**：最小 YAML、reject 语法糖、零手写 transitions、状态全自动推导

### parallel_build — 并行构建流程

准备 → 前端构建 + 后端构建（并行）→ 集成测试。**展示特性**：parallel fork/join、hooks（before_phase/after_phase）、fail_strategy

### data_pipeline — 数据处理流水线

数据抽取 → 校验 → 转换 → 加载。**展示特性**：前向跳转（validate_skip → load）、多终态（completed/completed_partial/cancelled）、retry_policy、手写 transitions——这些字段的唯一完整范例

### req_review — 需求评审流程

需求分析 → 需求评审。**展示特性**：极简 2 阶段 + reject 驳回

### with_human — 人机交互示例

plan（`gate: true` 人工审批）→ review。**注意**：gate 和 ask_user 这两个机制本身是产品级的（dev 系工作流同样可用），本工作流只是它们的最小演示。

**展示特性**：
- **Gate**（人工审批）：`gate: true` + `gate_message`，UI 弹审批 banner [通过 / 驳回 / 取消]，驳回理由通过 `task.last_user_decision` 喂给下一轮
- **ask_user**（agent 中途提问）：框架自动注入 `mcp__autopilot_workflow__ask_user` 工具，agent 调用后任务保持 `running_<phase>` 但写入 `pending_question`；UI 弹提问 banner，options 模式渲染按钮
- **关键陷阱**：用 gate 时 phase 函数末尾**不要**主动 `transition('xxx_complete')` + `runInBackground('next')`，否则会绕过 gate

完整文档见 `docs/workflow-development.md` 的「人机交互（Gate 与 ask_user）」一节。

## 开发自定义工作流

参考 `docs/workflow-development.md` 获取完整的工作流开发指南。
