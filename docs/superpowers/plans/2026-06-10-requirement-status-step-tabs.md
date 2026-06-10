# 需求详情页「状态步骤 Tab」改造 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把需求详情页的进度可视化改成可点击的 6 步步骤 tab，默认显示当前步骤，已走过只读、未到达占位。

**Architecture:** 纯前端。新增一个纯函数模块（status→6 步映射 + 位置判定）和一个展示型步骤条组件 `StepBar`，再改造 `RequirementDetail.tsx`：用 `StepBar` 替换 `StageRail`，主区内容从「按当前 stage 渲染」改为「按选中步骤渲染」，并处理默认选中 / WebSocket 跟随 / 回到当前。无后端 / RPC / DB 改动。

**Tech Stack:** React 19 + TypeScript + Vite + Tailwind；测试用 `bun:test` + `react-dom/server` 的 `renderToStaticMarkup`（SSR 成 HTML 串断言，项目既有模式，见 `src/web/src/components/Term.test.tsx`）。

设计依据：`docs/superpowers/specs/2026-06-10-requirement-status-step-tabs-design.md`。

---

## 文件结构

| 文件 | 责任 | 动作 |
|---|---|---|
| `src/web/src/lib/requirement-steps.ts` | 6 步元数据 + `statusToStep` 映射 + `stepPosition` 位置判定（纯函数） | 创建 |
| `src/web/src/lib/requirement-steps.test.ts` | 上述纯函数单测 | 创建 |
| `src/web/src/components/StepBar.tsx` | 展示型可点击步骤条（圆圈数字 + 连接线 + 选中态），复用 StageRail 视觉 | 创建 |
| `src/web/src/components/StepBar.test.tsx` | StepBar SSR 渲染测试 | 创建 |
| `src/web/src/pages/RequirementDetail.tsx` | 集成 StepBar + 选中步骤状态 + 默认/跟随 + 内容区按步骤渲染 | 修改 |

测试运行命令（全程一致）：`bun test <文件路径>`；类型检查：`bunx tsc --noEmit`。

注意：`StageRail.tsx` 的 `statusToStage` **保留不动**（侧栏 `specInMain` 仍用它）；本次只是不再在 RequirementDetail 用 `StageRail` 组件本身。

---

## Task 1: status→6 步纯函数模块

**Files:**
- Create: `src/web/src/lib/requirement-steps.ts`
- Test: `src/web/src/lib/requirement-steps.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `src/web/src/lib/requirement-steps.test.ts`：

```tsx
import { test, expect } from "bun:test";
import { statusToStep, stepPosition, STEP_ORDER } from "./requirement-steps";

test("statusToStep: 11 个 status 映射到 6 步", () => {
  expect(statusToStep("drafting")).toBe("clarify");
  expect(statusToStep("clarifying")).toBe("clarify");
  expect(statusToStep("ready")).toBe("approve");
  expect(statusToStep("awaiting_approval")).toBe("approve");
  expect(statusToStep("queued")).toBe("queue");
  expect(statusToStep("running")).toBe("execute");
  expect(statusToStep("fix_revision")).toBe("execute");
  expect(statusToStep("awaiting_review")).toBe("review");
  expect(statusToStep("done")).toBe("done");
  expect(statusToStep("failed")).toBe("done");
  expect(statusToStep("cancelled")).toBe("done");
});

test("statusToStep: 未知 status 落到 done", () => {
  expect(statusToStep("weird-unknown")).toBe("done");
});

test("STEP_ORDER 是 6 步固定顺序", () => {
  expect(STEP_ORDER).toEqual(["clarify", "approve", "queue", "execute", "review", "done"]);
});

test("stepPosition: past/current/future", () => {
  expect(stepPosition("clarify", "execute")).toBe("past");
  expect(stepPosition("execute", "execute")).toBe("current");
  expect(stepPosition("review", "execute")).toBe("future");
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test src/web/src/lib/requirement-steps.test.ts`
Expected: FAIL（`Cannot find module './requirement-steps'`）

- [ ] **Step 3: 写实现**

创建 `src/web/src/lib/requirement-steps.ts`：

```tsx
// 需求生命周期的 6 个步骤。status（细粒度状态机）→ step（步骤）的归并是这一页
// 信息架构的核心。真理来源：src/core/requirements.ts ALLOWED_TRANSITIONS。
export type ReqStep = "clarify" | "approve" | "queue" | "execute" | "review" | "done";

export const STEPS: { key: ReqStep; label: string }[] = [
  { key: "clarify", label: "澄清" },
  { key: "approve", label: "审批" },
  { key: "queue", label: "排队" },
  { key: "execute", label: "执行" },
  { key: "review", label: "验收" },
  { key: "done", label: "完成" },
];

export const STEP_ORDER: ReqStep[] = STEPS.map((s) => s.key);

/** 细粒度 status → 6 步骤。 */
export function statusToStep(status: string): ReqStep {
  switch (status) {
    case "drafting":
    case "clarifying":
      return "clarify";
    case "ready":
    case "awaiting_approval":
      return "approve";
    case "queued":
      return "queue";
    case "running":
    case "fix_revision":
      return "execute";
    case "awaiting_review":
      return "review";
    case "done":
    case "failed":
    case "cancelled":
    default:
      return "done";
  }
}

export type StepPosition = "past" | "current" | "future";

/** selected 相对 current 的时间位置，决定只读 / 可操作 / 占位。 */
export function stepPosition(selected: ReqStep, current: ReqStep): StepPosition {
  const si = STEP_ORDER.indexOf(selected);
  const ci = STEP_ORDER.indexOf(current);
  if (si < ci) return "past";
  if (si > ci) return "future";
  return "current";
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test src/web/src/lib/requirement-steps.test.ts`
Expected: PASS（5 个 test 全绿）

- [ ] **Step 5: 提交**

```bash
git add src/web/src/lib/requirement-steps.ts src/web/src/lib/requirement-steps.test.ts
git commit -m "feat(web): 需求 status→6 步骤映射 + 位置判定纯函数"
```

---

## Task 2: StepBar 展示型步骤条组件

**Files:**
- Create: `src/web/src/components/StepBar.tsx`
- Test: `src/web/src/components/StepBar.test.tsx`

- [ ] **Step 1: 写失败测试**

创建 `src/web/src/components/StepBar.test.tsx`：

```tsx
import { test, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { StepBar } from "./StepBar";

test("渲染 6 个步骤标签", () => {
  const html = renderToStaticMarkup(<StepBar status="running" selected="execute" onSelect={() => {}} />);
  for (const label of ["澄清", "审批", "排队", "执行", "验收", "完成"]) {
    expect(html).toContain(label);
  }
});

test("每个步骤都是可点击 button（含未到达，共 6 个）", () => {
  const html = renderToStaticMarkup(<StepBar status="drafting" selected="clarify" onSelect={() => {}} />);
  expect((html.match(/<button/g) || []).length).toBe(6);
});

test("当前步骤之前的步骤是 done 态（success 配色）", () => {
  // running → current=execute(idx 3)，前 3 步 done
  const html = renderToStaticMarkup(<StepBar status="running" selected="execute" onSelect={() => {}} />);
  expect(html).toContain("bg-success/15");
});

test("选中步骤有下划线高亮", () => {
  const html = renderToStaticMarkup(<StepBar status="running" selected="clarify" onSelect={() => {}} />);
  expect(html).toContain("underline");
});

test("failed 时完成步标红", () => {
  const html = renderToStaticMarkup(<StepBar status="failed" selected="done" onSelect={() => {}} />);
  expect(html).toContain("bg-destructive");
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test src/web/src/components/StepBar.test.tsx`
Expected: FAIL（`Cannot find module './StepBar'`）

- [ ] **Step 3: 写实现**

创建 `src/web/src/components/StepBar.tsx`（视觉沿用 `StageRail.tsx`，叠加可点击 button + 选中下划线）：

```tsx
import { Check, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { STEPS, STEP_ORDER, statusToStep, type ReqStep } from "@/lib/requirement-steps";

// 可点击的步骤进度条：6 步圆圈数字 + 连接线，当前步高亮、已走过打勾、未到达浅灰。
// 选中步加下划线。所有步骤（含未到达）均可点击，点击回调 onSelect。
export function StepBar({
  status,
  selected,
  onSelect,
}: {
  status: string;
  selected: ReqStep;
  onSelect: (step: ReqStep) => void;
}) {
  const current = statusToStep(status);
  const currentIdx = STEP_ORDER.indexOf(current);
  const aborted = status === "failed" || status === "cancelled";

  return (
    <ol className="flex items-center gap-1.5">
      {STEPS.map((s, i) => {
        const done = i < currentIdx;
        const active = i === currentIdx;
        const isSelected = s.key === selected;
        const isAbortedTail = active && s.key === "done" && aborted;
        return (
          <li key={s.key} className="flex flex-1 items-center gap-1.5 last:flex-none">
            <button
              type="button"
              onClick={() => onSelect(s.key)}
              aria-current={isSelected ? "step" : undefined}
              className={cn(
                "flex items-center gap-2 rounded-md px-1 py-0.5 transition-colors hover:bg-muted/50",
                isSelected && "bg-muted/60",
              )}
            >
              <span
                className={cn(
                  "flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-[11px] font-medium transition-colors",
                  isAbortedTail
                    ? "border-destructive bg-destructive text-destructive-foreground"
                    : done
                      ? "border-success/40 bg-success/15 text-success"
                      : active
                        ? "border-accent bg-accent text-accent-foreground"
                        : "border-border bg-card text-muted-foreground",
                )}
              >
                {isAbortedTail ? <X className="h-3.5 w-3.5" /> : done ? <Check className="h-3.5 w-3.5" /> : i + 1}
              </span>
              <span
                className={cn(
                  "whitespace-nowrap text-xs transition-colors",
                  isSelected
                    ? "font-semibold text-foreground underline underline-offset-4"
                    : isAbortedTail
                      ? "font-medium text-destructive"
                      : active
                        ? "font-medium text-foreground"
                        : done
                          ? "text-muted-foreground"
                          : "text-muted-foreground/60",
                )}
              >
                {s.label}
              </span>
            </button>
            {i < STEPS.length - 1 && (
              <span
                className={cn("h-px flex-1 transition-colors", i < currentIdx ? "bg-success/40" : "bg-border")}
                aria-hidden="true"
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test src/web/src/components/StepBar.test.tsx`
Expected: PASS（5 个 test 全绿）

- [ ] **Step 5: 提交**

```bash
git add src/web/src/components/StepBar.tsx src/web/src/components/StepBar.test.tsx
git commit -m "feat(web): StepBar 可点击步骤进度条组件"
```

---

## Task 3: RequirementDetail 集成步骤 tab

**Files:**
- Modify: `src/web/src/pages/RequirementDetail.tsx`（import 区第 12 行；StageRail 块 1261–1264；内容区 1279–1458；并在组件内新增状态/effect）

> 说明：本任务把「按当前 stage 一次性渲染」改为「按选中步骤渲染」。所有卡片变量
> （`clarifierStatus` / `chatCard` / `specCard` / `subPrCard` / `taskRecord` / `feedbackCard`）
> 与 handler（`markReady` / `recallToReady` / `rejectApproval` / `inject` / `markDone`
> / `requestFix`）均已在组件内定义，直接复用。侧栏与 `NextStepCTA` 不动。

- [ ] **Step 1: 改 import，引入 StepBar 与步骤工具**

修改第 12 行（保留 `statusToStage` 给侧栏，新增 StepBar/步骤工具）：

```tsx
import { statusToStage } from "@/components/StageRail";
import { StepBar } from "@/components/StepBar";
import { statusToStep, stepPosition, STEPS, type ReqStep } from "@/lib/requirement-steps";
```

（原第 12 行 `import { StageRail, statusToStage } from "@/components/StageRail";` 拆成上面两行——去掉 `StageRail`。）

- [ ] **Step 2: 新增选中步骤状态 + 当前步 + 跟随 effect**

在组件内（已有 `const stage = statusToStage(req.status);` 之类计算附近；`req` 已加载、非空的作用域内）新增。先在 hooks 区加状态与 ref（与其它 `useState` 并列，放在组件顶部 hooks group）：

```tsx
const [selectedStep, setSelectedStep] = useState<ReqStep | null>(null);
const prevStatusRef = useRef<string | undefined>(undefined);
```

在 `req` 可用后计算当前步与生效步（放在 `stage` 计算附近）：

```tsx
const currentStep = statusToStep(req.status);
const activeStep: ReqStep = selectedStep ?? currentStep;
```

新增跟随 effect（与其它 `useEffect` 并列）：

```tsx
// 默认选中当前步；status 变化时，若用户没手动切走则跟随到新当前步，否则不打断。
useEffect(() => {
  if (!req) return;
  const cur = statusToStep(req.status);
  const prev = prevStatusRef.current;
  prevStatusRef.current = req.status;
  if (prev === undefined) {
    setSelectedStep(cur); // 初次加载：默认当前步
    return;
  }
  if (prev !== req.status) {
    const prevStep = statusToStep(prev);
    setSelectedStep((sel) => (sel === null || sel === prevStep ? cur : sel));
  }
}, [req?.status]);
```

> 注：若文件里 `req` 在加载中是可空的且有 early return，则上面计算 `currentStep`/`activeStep`
> 必须在确认 `req` 非空之后；`useState`/`useRef`/`useEffect` 三个 hook 仍放组件顶层无条件调用。

- [ ] **Step 3: 用 StepBar 替换 StageRail 块**

把 1261–1264 整块替换为（StepBar + 顶部「回到当前」提示）：

```tsx
{/* 步骤进度条：6 步可点击，默认当前步 */}
<div className="mb-5 rounded-lg border border-border bg-card/40 px-4 py-3">
  <StepBar status={req.status} selected={activeStep} onSelect={setSelectedStep} />
</div>
```

- [ ] **Step 4: 内容区改为按选中步骤渲染**

把内容区主列（1281–1458，即 `<div className="lg:col-span-2 …">…</div>` 的内部）整体替换为下面结构。新增「回到当前」提示 + 未到达占位 + 按步骤 + 只读开关：

```tsx
{/* 主区：随选中步骤切换；过去步只读，未到达占位 */}
<div className="lg:col-span-2 space-y-4 min-w-0">
  {activeStep !== currentStep && (
    <button
      type="button"
      onClick={() => setSelectedStep(currentStep)}
      className="inline-flex items-center gap-1 text-xs text-accent hover:underline"
    >
      ↩ 回到当前步骤（{STEPS.find((s) => s.key === currentStep)?.label}）
    </button>
  )}

  {(() => {
    const pos = stepPosition(activeStep, currentStep);
    if (pos === "future") {
      const label = STEPS.find((s) => s.key === activeStep)?.label ?? "";
      return (
        <Card className="p-6 text-center text-sm text-muted-foreground">
          「{label}」尚未开始。完成前序步骤后会进入这一步。
        </Card>
      );
    }
    const readonly = pos === "past";

    if (activeStep === "clarify") {
      return (
        <>
          {clarifierStatus}
          {chatCard}
          {!readonly && (
            <Button
              variant="outline"
              className="w-full"
              size="sm"
              onClick={markReady}
              disabled={actionBusy}
              title="跳过 AI 澄清流程，直接标记为已澄清"
            >
              {actionBusy ? "处理中…" : "跳过澄清，标为已澄清"}
            </Button>
          )}
          {specCard}
        </>
      );
    }

    if (activeStep === "approve") {
      return (
        <>
          {req.schedule_error && (
            <Card className="border-l-4 border-l-destructive p-4">
              <div className="flex items-start gap-2">
                <span className="shrink-0 text-destructive">⚠</span>
                <div className="min-w-0 text-sm">
                  <p className="font-medium text-destructive">上次起任务失败，已退回</p>
                  <p className="mt-0.5 break-words text-muted-foreground">{req.schedule_error}</p>
                  <p className="mt-1 text-xs text-muted-foreground">修复后点上方「入队执行」可重试。</p>
                </div>
              </div>
            </Card>
          )}
          {specCard}
          {!readonly && req.status === "awaiting_approval" && (
            <Button
              variant="outline"
              className="w-full"
              size="sm"
              onClick={rejectApproval}
              disabled={actionBusy}
              title="审批通过的主按钮在上方"
            >
              {actionBusy ? "处理中…" : "↩ 驳回，返回草稿"}
            </Button>
          )}
        </>
      );
    }

    if (activeStep === "queue") {
      return (
        <>
          {specCard}
          {taskRecord}
          {!readonly && req.status === "queued" && (
            <Button variant="outline" className="w-full" size="sm" onClick={recallToReady} disabled={actionBusy}>
              {actionBusy ? "处理中…" : "撤回（返回已澄清）"}
            </Button>
          )}
        </>
      );
    }

    if (activeStep === "execute") {
      return (
        <>
          {subPrCard}
          {taskRecord}
          {!readonly && req.status === "fix_revision" && (
            <Card className="p-5">
              <p className="mb-2 text-xs text-muted-foreground">修复阶段反馈（注入后 Agent 会据此修改）：</p>
              <Textarea
                value={feedbackBody}
                onChange={(e) => setFeedbackBody(e.target.value)}
                placeholder="填写修改建议…"
                className="min-h-[80px] text-xs"
                disabled={submittingFeedback}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void inject();
                }}
              />
              <div className="mt-2 flex justify-end">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void inject()}
                  disabled={submittingFeedback || !feedbackBody.trim()}
                >
                  {submittingFeedback ? "提交中…" : "注入反馈"}
                </Button>
              </div>
            </Card>
          )}
          {feedbackCard}
        </>
      );
    }

    if (activeStep === "review") {
      return (
        <>
          {subPrCard}
          {!readonly && (
            <Card className="p-5">
              <p className="mb-2 text-sm font-medium">PR 审查</p>
              <Textarea
                value={feedbackBody}
                onChange={(e) => setFeedbackBody(e.target.value)}
                placeholder="填写审查意见或修改建议…"
                className="min-h-[80px] text-xs"
                disabled={submittingFeedback}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void inject();
                }}
              />
              <div className="mt-2 space-y-2">
                <Button
                  variant="outline"
                  className="w-full"
                  size="sm"
                  onClick={() => void inject()}
                  disabled={submittingFeedback || !feedbackBody.trim()}
                >
                  {submittingFeedback ? "提交中…" : "注入反馈"}
                </Button>
                <div className="flex gap-2">
                  <Button variant="default" className="flex-1 text-xs" size="sm" onClick={() => void markDone()} disabled={actionBusy}>
                    <CheckCircle2 className="mr-1 h-3.5 w-3.5" /> PR 已合并 · 完成
                  </Button>
                  <Button variant="outline" className="flex-1 text-xs" size="sm" onClick={() => void requestFix()} disabled={actionBusy}>
                    ↩ 要求修改
                  </Button>
                </div>
              </div>
            </Card>
          )}
          {taskRecord}
          {feedbackCard}
        </>
      );
    }

    // activeStep === "done"
    return (
      <>
        <Card className="p-5">
          {req.status === "done" && (
            <div className="flex items-center gap-2 text-sm">
              <CheckCircle2 className="h-4 w-4 text-success" />
              <span className="font-medium">需求已完成</span>
              {req.pr_url && (
                <a
                  href={req.pr_url}
                  target="_blank"
                  rel="noreferrer"
                  className="ml-auto inline-flex items-center gap-1 font-mono text-[11px] text-accent hover:underline"
                >
                  PR #{req.pr_number}
                  <ExternalLink className="h-3 w-3" />
                </a>
              )}
            </div>
          )}
          {req.status === "failed" && (
            <div className="space-y-1">
              <p className="text-sm font-medium text-destructive">执行失败</p>
              <p className="text-xs text-muted-foreground">可在上方「重新入队执行」重试，或退回草稿改规约。</p>
            </div>
          )}
          {req.status === "cancelled" && <p className="text-sm text-muted-foreground">需求已取消。</p>}
          {req.status !== "done" && req.status !== "failed" && req.status !== "cancelled" && (
            <p className="text-sm text-muted-foreground">尚未结束。</p>
          )}
        </Card>
        {subPrCard}
        {taskRecord}
        {feedbackCard}
      </>
    );
  })()}
</div>
```

> 关键点：
> - `done` 步在「未到达却被点开」时（理论上 future 已被占位拦截，不会走到），仍给了兜底文案。
> - `queue` 步是新拆出的：内容 = spec + 任务记录 + （当前态时）撤回按钮。
> - 只读（past）一律不渲染操作按钮，仅看历史卡片。

- [ ] **Step 5: 类型检查**

Run: `bunx tsc --noEmit`
Expected: 0 个 `error TS`（忽略既有的 `TS5101` baseUrl deprecation 警告）。

> 若报 `statusToStage` / `stage` 未使用：检查侧栏 `specInMain` 是否仍用 `stage`；保留该用法即可。若报 `StageRail` 未使用：确认 import 已去掉 `StageRail`。

- [ ] **Step 6: 跑相关测试 + 全量回归**

Run: `bun test src/web/src/lib/requirement-steps.test.ts src/web/src/components/StepBar.test.tsx`
Expected: PASS。

Run: `bun test 2>&1 | tail -3`
Expected: 0 fail（与改造前基线一致）。

- [ ] **Step 7: 提交**

```bash
git add src/web/src/pages/RequirementDetail.tsx
git commit -m "feat(web): 需求详情页改为可点击的状态步骤 tab"
```

---

## Task 4: 人工验证（构建 + 跑起来看）

**Files:** 无（验证任务）

- [ ] **Step 1: Web 构建确认无错**

Run: `bun run build:web 2>&1 | tail -8`
Expected: 构建成功，无 TS/Vite 报错。

- [ ] **Step 2: 起 daemon + 打开需求详情页核对**

按 CLAUDE.md：`autopilot daemon run` 后 `autopilot dashboard`（`http://127.0.0.1:6180`），进入任一需求详情页，核对：
- 进页面默认高亮当前步骤，主区显示当前步内容 + 操作按钮。
- 点已走过的步 → 看到历史内容、无操作按钮。
- 点未到达的步 → 看到占位提示。
- 切到非当前步时出现「↩ 回到当前步骤」，点击回到当前。
- （若能制造 status 变化）当前步内未手动切走时，内容自动跟随到新步。

- [ ] **Step 3: 无需提交**（纯验证）

---

## Self-Review（写计划后自查）

**Spec 覆盖：**
- D1 6 步映射 → Task 1 `statusToStep` + Task 2 标签 ✓
- D2 点击三态（current/past/future）→ Task 3 Step 4 的 `stepPosition` 分支 + `readonly` 开关 + 占位 ✓
- D3 默认选中 + 跟随 + 回到当前 → Task 3 Step 2 effect + Step 3/4 的「回到当前」按钮 ✓
- D4 替换 StageRail / 保留 NextStepCTA & 侧栏 → Task 3 Step 3（替换）+ 未触碰 CTA/侧栏 ✓
- D5 视觉（圆圈数字+连接线+三态+选中下划线+failed 标红）→ Task 2 StepBar ✓
- 测试点（statusToStep 单测 / StepBar 渲染 / 跟随逻辑）→ Task 1、Task 2 覆盖；跟随逻辑以纯函数 `stepPosition` + effect 实现，effect 行为在 Task 4 人工验证（SSR 测试无法驱动 effect/事件，故跟随用人工核对，已在计划注明）✓

**占位扫描：** 无 TBD/TODO；所有代码步骤含完整代码。

**类型一致性：** `ReqStep` 类型在 Task 1 定义，Task 2/3 一致引用；`statusToStep`/`stepPosition`/`STEPS`/`STEP_ORDER` 命名跨任务一致；复用的卡片变量/handler 名取自现状代码（已核对行号）。

**已知取舍（非阻断）：** 回看过去步时，侧栏（基于当前 status 的 `specInMain`）与过去步内容可能同时出现 spec，属可接受的轻微重复，本次不动侧栏（在范围外）。
