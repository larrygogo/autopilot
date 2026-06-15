# artifact 探针工作流实施计划

> **状态（2026-06-12 晚）：已升级为正式形态（v2 R5）**——produce gate hack 与 `AUTOPILOT_HOME/deliverables/` 归档已废弃，交付改 `deliverArtifacts` promote 到需求 `deliveries/round-<N>/` 落表、验收改需求级 awaiting_review（Web 验收卡 / CLI `req accept|reject`）。本文仅存档探针期实施过程。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 零内核改动的 artifact 交付探针工作流——agent 产出文件到沙盒 `deliverables/`，人工 gate 验收，deliver 阶段归档到 `AUTOPILOT_HOME/deliverables/<reqId>/<taskId>/`，用真实设计图 / 网页 demo 需求收集交付物抽象 P0 的实测痛点。

**Architecture:** 纯用户空间工作流（examples 模板 + 安装到 `~/.autopilot/workflows/`），不改 src/ 任何文件。两阶段：`produce`（agent 产出，`gate: true` 挂起人工验收，驳回理由经 `task.last_user_decision` 喂回重做）→ `deliver`（无 agent 的机械归档 + 显式 transition 收尾）。设计基准见 `docs/superpowers/specs/2026-06-12-deliverable-abstraction-design.md`。

**Tech Stack:** Bun + TypeScript，autopilot YAML 工作流（gate 机制、`@autopilot/*` 路径别名）。

**测试策略说明：** 本探针是「workflow 配置 + 围绕 agent 调用的胶水」，无可提取的纯逻辑（文件归档直接用 `cpSync`），不写单元测试；验证 = `bun run typecheck`（examples 在 tsconfig 覆盖内）+ 安装冒烟（workflow list/show）+ 真实 dogfood 跑通（Task 6 清单）。

**已验证的机制事实**（执行者不必重查）：
- gate 流转：runner 在 phase 函数完成后自动触发 `await_<phase>` 挂到 `awaiting_<phase>`（src/core/runner.ts ~:221）；用户 pass → `<phase>_pass` 进下一 pending，reject → `<phase>_reject_user` 回 `pending_<phase>` 重做（src/core/registry.ts :574-603）；驳回必填理由，落 `task.last_user_decision`（src/daemon/task-actions.ts :249-300）。
- **gate phase 函数末尾不要主动 transition**（否则绕过 gate）；非 gate 的末段 phase 要显式 `transition(taskId, "<phase>_complete")`（dev 的 submit_pr 模式，examples/workflows/dev/workflow.ts :522）。
- 沙盒根 = `getCurrentSandboxDir()`（`@autopilot/core/task-context`），回退 `task["repo_path"]`。
- `AUTOPILOT_HOME` 从 `@autopilot/index` 导入（src/core/sandbox.ts:3 同款）。
- ⚠ 归档目录**不能**放 `runtime/requirements/<reqId>/`——需求 done/cancelled 时整目录被 `deleteRequirementClone` 删除（src/daemon/requirement-clarifier.ts ~:752）。也不能留任务沙盒（done 即清 workspace）。所以放 `AUTOPILOT_HOME/deliverables/`。

---

### Task 1: 创建 workflow.yaml

**Files:**
- Create: `examples/workflows/artifact/workflow.yaml`

- [ ] **Step 1: 写 workflow.yaml**

```yaml
name: artifact
label: "产物交付（探针）"
description: "非 PR 交付探针：agent 产出文件到 deliverables/，人工 gate 验收后归档到 AUTOPILOT_HOME/deliverables/<reqId>/<taskId>/。单库需求用。dogfood 数据回填 docs/superpowers/specs/2026-06-12-deliverable-abstraction-design.md"
setup_func: setup_artifact_task

sandbox:
  git: true   # 需求挂了 workspace 就 clone 作只读参考；agent 不 push、不开 PR

phases:
  # produce：agent 产出交付物到沙盒 deliverables/，跑完 gate 挂起等人工验收。
  # 驳回理由经 task.last_user_decision 喂给下一轮重做（见 workflow.ts）。
  - name: produce
    label: "制作"
    timeout: 1800
    gate: true
    gate_message: "产物在任务沙盒 workspace/deliverables/ 目录（先看 SUMMARY.md）。通过 = 归档交付；驳回请写明修改意见，会喂给下一轮重做。"
    agent:
      label: "制作者"
      provider: anthropic
      permission_mode: bypassPermissions

  # deliver：无 agent 的机械归档。把 deliverables/ 抄出沙盒（沙盒在需求 done 后会被清）。
  - name: deliver
    label: "归档"
    timeout: 300
```

- [ ] **Step 2: 确认 yaml 语法合法**

Run: `bun -e "const y = await import('js-yaml').catch(() => null); const t = await Bun.file('examples/workflows/artifact/workflow.yaml').text(); console.log(y ? Object.keys(y.load(t)).join(',') : 'js-yaml 不可用，跳过'); "`
Expected: 输出 `name,label,description,setup_func,sandbox,phases`（或「js-yaml 不可用」——则靠 Task 3 安装冒烟兜底）

---

### Task 2: 创建 workflow.ts

**Files:**
- Create: `examples/workflows/artifact/workflow.ts`

- [ ] **Step 1: 写 workflow.ts（完整内容如下）**

```typescript
/**
 * artifact 探针工作流：非 PR 交付的最小闭环（零内核改动）。
 *
 * produce（gate 人工验收，驳回重做）→ deliver（归档出沙盒）。
 * 归档目录 AUTOPILOT_HOME/deliverables/<reqId>/<taskId>/ ——
 * 不能放 runtime/requirements/<reqId>/（需求 done 时整目录被清），
 * 也不能留任务沙盒（done 即清 workspace）。
 *
 * 设计基准：docs/superpowers/specs/2026-06-12-deliverable-abstraction-design.md
 */

import { cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "fs";
import { join } from "path";
import { AUTOPILOT_HOME } from "@autopilot/index";
import { getTask } from "@autopilot/core/db";
import { transition } from "@autopilot/core/state-machine";
import { getWorkflow, buildTransitions } from "@autopilot/core/registry";
import { agentForPhase } from "@autopilot/agents/registry";
import { getCurrentSandboxDir } from "@autopilot/core/task-context";
import { getTaskArtifactsDir } from "@autopilot/core/sandbox";
import { getPhaseIndex } from "@autopilot/core/artifacts";

const DELIVERABLES_DIR = "deliverables";

export function setup_artifact_task(args: { title?: string; requirement?: string }): Record<string, unknown> {
  return {
    title: args.title ?? "untitled",
    requirement: args.requirement ?? "",
  };
}

function sandboxRoot(task: NonNullable<ReturnType<typeof getTask>>): string {
  const root = getCurrentSandboxDir() ?? (task["repo_path"] as string | undefined);
  if (!root) throw new Error("拿不到沙盒目录（getCurrentSandboxDir 与 repo_path 都为空）");
  return root;
}

function readLastUserDecision(task: ReturnType<typeof getTask>): {
  phase: string;
  decision: string;
  note: string;
  ts: string;
} | null {
  const raw = task?.["last_user_decision"] as string | undefined;
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function phaseDir(taskId: string, workflowName: string, phaseName: string): string {
  const wf = getWorkflow(workflowName);
  if (!wf) throw new Error(`workflow not found: ${workflowName}`);
  const idx = getPhaseIndex(wf, phaseName);
  if (idx < 0) throw new Error(`phase not found in workflow: ${phaseName}`);
  const dir = join(getTaskArtifactsDir(taskId), `${String(idx).padStart(2, "0")}-${phaseName}`);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

// ──────────────────────────────────────────────
// produce：agent 产出交付物，gate 挂起等人工验收
// ──────────────────────────────────────────────
//
// 末尾不主动 transition——runner 检测到 gate:true 自动挂到 awaiting_produce。

export async function run_produce(taskId: string): Promise<void> {
  const task = getTask(taskId);
  if (!task) throw new Error(`任务不存在：${taskId}`);

  const root = sandboxRoot(task);
  const requirement = ((task["requirement"] as string | undefined) ?? "").trim();
  if (!requirement) throw new Error("任务 requirement 字段为空，请在创建任务时提供需求描述");

  // 人工 gate 驳回后重做：把驳回意见喂回 prompt
  let rejectionHistory = "";
  const decision = readLastUserDecision(task);
  if (decision?.phase === "produce" && decision.decision === "reject" && decision.note) {
    rejectionHistory =
      `\n\n## 上一轮人工驳回意见（${decision.ts}）\n${decision.note}\n\n` +
      `沙盒里 ${DELIVERABLES_DIR}/ 还保留着上一轮产物。请针对意见增量修改，不要推倒重来（除非意见明确要求）。`;
  }

  const prompt =
    `你是一位多面手创作者（设计 / 前端 / 文档均可）。请根据需求产出交付物。\n\n` +
    `## 需求\n${requirement}\n\n` +
    `## 工作目录\n当前目录是参考仓库的克隆，仅供阅读参考。**不要修改仓库已有文件，不要 git commit / push。**\n\n` +
    `## 交付规则\n` +
    `1. 所有交付物写入 \`${DELIVERABLES_DIR}/\` 目录（不存在则创建）\n` +
    `2. 网页 demo = 自包含静态文件（单 html 或 html+css+js），双击可开，不依赖构建工具或服务器\n` +
    `3. 设计图 = svg，或可在浏览器直接打开的 html 画布\n` +
    `4. 最后写 \`${DELIVERABLES_DIR}/SUMMARY.md\`：交付了什么、每个文件是什么、怎么打开查看\n` +
    `5. 完成前自查：SUMMARY.md 列出的每个文件都真实存在且可打开` +
    rejectionHistory;

  const agent = agentForPhase(task.workflow, "produce");
  const result = await agent.run(prompt, { cwd: root, timeout: 1_800_000 });

  // agent 收尾自述落 artifacts，便于 Web 时间线排查
  writeFileSync(
    join(phaseDir(taskId, task.workflow, "produce"), "produce-notes.md"),
    `<!-- generated:${new Date().toISOString()} -->\n${result.text}`,
    "utf-8",
  );

  if (!existsSync(join(root, DELIVERABLES_DIR))) {
    throw new Error(`produce 完成但沙盒里没有 ${DELIVERABLES_DIR}/ 目录——agent 未按约定产出`);
  }
  // ↓ 不 transition：runner 自动 await_produce → awaiting_produce 等人工决断
}

// ──────────────────────────────────────────────
// deliver：机械归档（无 agent），把产物抄出沙盒
// ──────────────────────────────────────────────

export async function run_deliver(taskId: string): Promise<void> {
  const task = getTask(taskId);
  if (!task) throw new Error(`任务不存在：${taskId}`);

  const src = join(sandboxRoot(task), DELIVERABLES_DIR);
  if (!existsSync(src)) throw new Error(`找不到产物目录：${src}`);

  const reqId = (task["requirement_id"] as string | undefined) ?? "no-req";
  const dest = join(AUTOPILOT_HOME, "deliverables", reqId, taskId);
  mkdirSync(dest, { recursive: true });
  cpSync(src, dest, { recursive: true });

  const fileCount = readdirSync(dest, { recursive: true }).length;
  const wf = getWorkflow(task.workflow);
  if (!wf) throw new Error(`工作流不存在：${task.workflow}`);
  transition(taskId, "deliver_complete", {
    transitions: buildTransitions(wf),
    note: `产物已归档：${dest}（${fileCount} 项）`,
  });
}
```

- [ ] **Step 2: typecheck**

Run: `bun run typecheck`
Expected: 0 errors（若报 `@autopilot/index` 别名解析失败，对照 `examples/workflows/dev/workflow.ts` 的 import 写法修正——所有 `@autopilot/*` 别名以 dev workflow 实际可用的为准）

---

### Task 3: 安装到用户空间 + 冒烟验证

**Files:** 无新文件（操作 `~/.autopilot/workflows/`）

- [ ] **Step 1: 安装**

Run: `bun run dev workflow sync artifact --apply`
Expected: 输出覆盖/新增的文件列表。若 sync 不支持本地不存在的工作流，回退手动复制：
`cp -r examples/workflows/artifact/ ~/.autopilot/workflows/artifact/`

- [ ] **Step 2: 注册验证**（需要 daemon 在跑；没跑先 `bun run dev daemon start`）

Run: `bun run dev workflow list`
Expected: 列表含 `artifact`

Run: `bun run dev workflow show artifact`
Expected: 输出与 Task 1 一致的 yaml（gate: true 可见）

---

### Task 4: examples README 补条目

**Files:**
- Modify: `examples/workflows/README.md`（「产品模板」节末尾，req_dev 条目之后）
- Modify: `examples/workflows/README.en.md`（对应位置）

- [ ] **Step 1: README.md 在 req_dev 条目后追加**

```markdown
### artifact — 产物交付（探针，dogfood 中）

produce（`gate: true` 人工验收，驳回意见喂回重做）→ deliver（归档到 `AUTOPILOT_HOME/deliverables/<reqId>/<taskId>/`）。非 PR 交付形态的零内核改动探针，为「交付物抽象」P0 收集实测痛点（设计基准与反馈清单见 `docs/superpowers/specs/2026-06-12-deliverable-abstraction-design.md`）。单库需求用。
```

- [ ] **Step 2: README.en.md 在 req_dev 条目后追加**

```markdown
### artifact — artifact delivery (probe, dogfooding)

produce (`gate: true` manual acceptance; rejection notes fed back into the redo round) → deliver (archives to `AUTOPILOT_HOME/deliverables/<reqId>/<taskId>/`). A zero-kernel-change probe for the non-PR delivery shape, collecting real-world pain points for the "deliverable abstraction" P0 (design baseline and feedback checklist: `docs/superpowers/specs/2026-06-12-deliverable-abstraction-design.md`). For single-repo requirements.
```

---

### Task 5: 提交

- [ ] **Step 1: commit**

```bash
git add examples/workflows/artifact/ examples/workflows/README.md examples/workflows/README.en.md docs/superpowers/specs/2026-06-12-deliverable-abstraction-design.md docs/superpowers/plans/2026-06-12-artifact-probe-workflow.md
git commit -m "feat(examples): artifact 探针工作流 —— 非 PR 交付零内核改动探针（gate 人工验收 + 归档出沙盒），附交付物抽象设计备忘"
```

---

### Task 6: dogfood 验证清单（人工，跑 2-3 个真实需求）

> 这一步是探针的目的本身，由用户亲自跑；每跑完一个需求，把观察填进
> `docs/superpowers/specs/2026-06-12-deliverable-abstraction-design.md` 的「探针反馈」节。

- [ ] **需求 1**：真实的设计图或网页 demo 需求（挂一个真实 workspace 作参考），
  Web 新建需求 → 选 `artifact` 工作流（或 `bun run dev req set-workflow <id> artifact`）→
  走完澄清 → 审批 → 执行
- [ ] **验收路径验证**：任务挂到 `awaiting_produce` 时，在任务页看到 gate banner；
  浏览沙盒 `workspace/deliverables/` 确认产物可见；先驳回一次（写具体修改意见）→
  确认重做轮拿到了意见且增量修改 → 再通过
- [ ] **归档验证**：通过后 deliver 自动跑完、task done、需求 done；
  确认 `~/.autopilot/deliverables/<reqId>/<taskId>/` 里产物完整、SUMMARY.md 可读；
  确认需求 done 后沙盒被清但归档目录健在
- [ ] **需求 2-3**：换产物类型（demo ↔ 设计图）重复，至少一个不驳回直接通过
- [ ] **回填观察**：澄清违和度 / 验收在任务页 vs 期望需求页 / 沙盒浏览够不够 /
  手动拿文件体验 / 最想跳过的环节 —— 写进 spec「探针反馈」节，决定 P0 是否开工
```
