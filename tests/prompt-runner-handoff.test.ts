/**
 * Phase 6 — prompt phase handoff 协议测试（spec §3.10）
 *
 * 覆盖：
 *   - parseHandoffSections 4 段正常解析
 *   - parseHandoffSections 逐段独立：缺一段不影响其他段
 *   - parseHandoffSections 全缺 → 4 段都占位 + missing 列表完整
 *   - collectUpstreamHandoffs 按顺序拼接 + 跳过缺 handoff.md 的 phase
 *   - collectUpstreamHandoffs 全无 → 降级提示
 *   - expandPromptTemplate 解析 ${HANDOFF} / ${HANDOFF_<NAME>}
 *   - readPhaseHandoff 单 phase 读取
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  parseHandoffSections,
  collectUpstreamHandoffs,
  readPhaseHandoff,
  expandPromptTemplate,
} from "../src/core/workflow/prompt-runner";
import type { WorkflowDefinition, PhaseDefinition } from "../src/core/workflow/registry";

let tmpHome: string;

beforeEach(() => {
  tmpHome = join(tmpdir(), `autopilot-handoff-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(tmpHome, "runtime", "tasks"), { recursive: true });
  process.env.AUTOPILOT_HOME_OVERRIDE = tmpHome;
});

afterEach(() => {
  delete process.env.AUTOPILOT_HOME_OVERRIDE;
  if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
});

// ──────────────────────────────────────────────
// parseHandoffSections — 解析 4 段
// ──────────────────────────────────────────────

describe("parseHandoffSections", () => {
  it("4 段正常解析", () => {
    const out = `
我做完了，下面是 handoff：

## Decided
选了方案 A，理由是 X。

## Files
- src/foo.ts
- src/bar.ts

## Risks
方案 A 对老用户有影响。

## Remaining
还要补单元测试。
`;
    const { sections, missing } = parseHandoffSections(out);
    expect(missing).toEqual([]);
    expect(sections.Decided).toContain("方案 A");
    expect(sections.Files).toContain("src/foo.ts");
    expect(sections.Risks).toContain("老用户");
    expect(sections.Remaining).toContain("单元测试");
  });

  it("逐段独立：缺 Risks，其他 3 段仍正常", () => {
    const out = `
## Decided
done

## Files
file.ts

## Remaining
xxx
`;
    const { sections, missing } = parseHandoffSections(out);
    expect(missing).toEqual(["Risks"]);
    expect(sections.Decided).toBe("done");
    expect(sections.Files).toBe("file.ts");
    expect(sections.Risks).toBe("无（agent 未输出）");
    expect(sections.Remaining).toBe("xxx");
  });

  it("全缺 → 4 段全占位 + missing 完整", () => {
    const { sections, missing } = parseHandoffSections("agent 没按格式输出，是一段散文。");
    expect(missing).toEqual(["Decided", "Files", "Risks", "Remaining"]);
    expect(sections.Decided).toBe("无（agent 未输出）");
    expect(sections.Files).toBe("无（agent 未输出）");
    expect(sections.Risks).toBe("无（agent 未输出）");
    expect(sections.Remaining).toBe("无（agent 未输出）");
  });

  it("段内容为空（只有标题）→ 视为缺段填占位", () => {
    const out = `
## Decided

## Files
file.ts

## Risks

## Remaining
ok
`;
    const { sections, missing } = parseHandoffSections(out);
    expect(missing).toContain("Decided");
    expect(missing).toContain("Risks");
    expect(sections.Files).toBe("file.ts");
    expect(sections.Remaining).toBe("ok");
  });

  it("标题前后有额外空格也能匹配", () => {
    const out = `##   Decided   \nbody`;
    const { sections } = parseHandoffSections(out);
    expect(sections.Decided).toBe("body");
  });
});

// ──────────────────────────────────────────────
// collectUpstreamHandoffs / readPhaseHandoff
// ──────────────────────────────────────────────

function buildWorkflow(phases: Array<{ name: string; label?: string }>): WorkflowDefinition {
  return {
    name: "wf",
    phases: phases.map((p) => ({
      name: p.name,
      label: p.label ?? p.name.toUpperCase(),
      pending_state: `pending_${p.name}`,
      running_state: `running_${p.name}`,
      trigger: `start_${p.name}`,
      complete_trigger: `${p.name}_complete`,
      fail_trigger: `${p.name}_fail`,
    })) as PhaseDefinition[],
    initial_state: `pending_${phases[0].name}`,
    terminal_states: ["done", "cancelled"],
  };
}

// 用 wsRoot 显式参数注入 task workspace 路径，绕开 AUTOPILOT_HOME 全局常量
function wsRootFor(taskId: string): string {
  return join(tmpHome, "runtime", "tasks", taskId, "workspace");
}

function writeHandoff(taskId: string, phaseIdx: number, phaseName: string, body: string): void {
  const dir = join(wsRootFor(taskId), `${String(phaseIdx).padStart(2, "0")}-${phaseName}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "handoff.md"), body, "utf-8");
}

describe("collectUpstreamHandoffs + readPhaseHandoff", () => {
  it("按 phase 顺序拼接前序 handoff", () => {
    const wf = buildWorkflow([
      { name: "draft", label: "撰稿" },
      { name: "polish", label: "润色" },
      { name: "final", label: "终审" },
    ]);
    writeHandoff("t-1", 0, "draft", "DRAFT 决策");
    writeHandoff("t-1", 1, "polish", "POLISH 决策");

    const result = collectUpstreamHandoffs("t-1", wf, "final", wsRootFor("t-1"));
    expect(result).toContain("## 撰稿");
    expect(result).toContain("DRAFT 决策");
    expect(result).toContain("## 润色");
    expect(result).toContain("POLISH 决策");
    expect(result.indexOf("DRAFT 决策")).toBeLessThan(result.indexOf("POLISH 决策"));
  });

  it("中间某 phase 缺 handoff.md → 跳过该段，其他段保留", () => {
    const wf = buildWorkflow([
      { name: "draft" },
      { name: "polish" },
      { name: "final" },
    ]);
    writeHandoff("t-2", 0, "draft", "DRAFT");
    const result = collectUpstreamHandoffs("t-2", wf, "final", wsRootFor("t-2"));
    expect(result).toContain("DRAFT");
    expect(result).not.toContain("POLISH");
  });

  it("当前 phase 之后的 handoff 不被拼入（unreachable 防护）", () => {
    const wf = buildWorkflow([{ name: "draft" }, { name: "polish" }]);
    writeHandoff("t-3", 0, "draft", "DRAFT");
    writeHandoff("t-3", 1, "polish", "POLISH");

    const result = collectUpstreamHandoffs("t-3", wf, "draft", wsRootFor("t-3"));
    expect(result).not.toContain("POLISH");
  });

  it("全无 handoff 时返回降级提示", () => {
    const wf = buildWorkflow([{ name: "draft" }, { name: "polish" }]);
    const result = collectUpstreamHandoffs("t-4", wf, "polish", wsRootFor("t-4"));
    expect(result).toContain("未提供 handoff");
    // 降级提示不再叫 agent 去读文件（prompt 模式：只依据提示判断，文件 I/O 框架包办）
    expect(result).toContain("不要去读取任何文件");
  });

  it("readPhaseHandoff 单 phase 读取", () => {
    const wf = buildWorkflow([{ name: "draft" }]);
    writeHandoff("t-5", 0, "draft", "X");
    expect(readPhaseHandoff("t-5", wf, "draft", wsRootFor("t-5"))).toBe("X");
    expect(readPhaseHandoff("t-5", wf, "notexist", wsRootFor("t-5"))).toBeNull();
  });
});

describe("expandPromptTemplate ${HANDOFF}", () => {
  it("${HANDOFF} 展开为拼接的上游 handoff", () => {
    const wf = buildWorkflow([{ name: "draft", label: "撰稿" }, { name: "polish", label: "润色" }]);
    writeHandoff("t-6", 0, "draft", "DRAFT_BODY");

    const out = expandPromptTemplate("基于上一阶段：\n${HANDOFF}\n继续。", {
      taskId: "t-6",
      phase: "polish",
      task: { title: "x", requirement: "y" },
      workflow: wf,
      workspaceRoot: wsRootFor("t-6"),
    });
    expect(out).toContain("## 撰稿");
    expect(out).toContain("DRAFT_BODY");
  });

  it("${HANDOFF_DRAFT} 单独取某 phase", () => {
    const wf = buildWorkflow([{ name: "draft" }, { name: "polish" }]);
    writeHandoff("t-7", 0, "draft", "ONLY_DRAFT");

    const out = expandPromptTemplate("只看 draft：\n${HANDOFF_DRAFT}\n", {
      taskId: "t-7",
      phase: "polish",
      task: {},
      workflow: wf,
      workspaceRoot: wsRootFor("t-7"),
    });
    expect(out).toContain("ONLY_DRAFT");
  });

  it("${HANDOFF_design} 小写 phase 后缀也能取（历史 bug：通用 ${VAR} 正则只认大写、整体漏掉）", () => {
    const wf = buildWorkflow([{ name: "design" }, { name: "review" }]);
    writeHandoff("t-9", 0, "design", "DESIGN_PLAN");

    const out = expandPromptTemplate("评审：\n${HANDOFF_design}\n", {
      taskId: "t-9",
      phase: "review",
      task: {},
      workflow: wf,
      workspaceRoot: wsRootFor("t-9"),
    });
    expect(out).toContain("DESIGN_PLAN");
    expect(out).not.toContain("${HANDOFF_design}"); // 字面占位符必须消失
  });

  it("无 workflow 时 ${HANDOFF} 留空（防 ctx 退化）", () => {
    const out = expandPromptTemplate("${HANDOFF}", {
      taskId: "t-8",
      phase: "x",
      task: {},
      workspaceRoot: wsRootFor("t-8"),
    });
    expect(out).toBe("");
  });
});
