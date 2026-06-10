# 设计：需求卡片按状态特义化（显示 + 行内快捷操作）

> 2026-06-10 · 已经用户批准。生效范围：项目详情页 + 流水线页（共享 RequirementRow）。

## 背景

项目页/流水线页的需求卡片（`PipelineList.tsx` 的 RequirementRow）对所有状态长一样：图标+标签+ID。用户在 tab 里看到「待审批」「失败」却要点进详情页才能操作，决策密度低。

## 特化矩阵

| 状态 | 特化显示 | 行内操作（动作语义与需求详情页同源） |
|---|---|---|
| drafting | spec 摘要（spec_md 非空时 preview） | — |
| clarifying | `active_question_id` 非空 → 提示「AI 有问题等你回答」；`clarifier_error` → 红色错误摘要 | `[去回答 →]`（进详情页）；出错时 `[↻ 重试澄清]`（POST /api/requirements/{id}/retry-clarify） |
| ready | `schedule_error` → 红色调度失败摘要 | 出错时 `[↻ 重新入队]`（api.enqueueRequirement） |
| awaiting_approval | spec 摘要 preview（拍板要看的东西） | `[✓ 通过]`（api.enqueueRequirement）`[× 驳回]`（api.transitionRequirement → drafting） |
| queued | 「排队中 · 等调度器起任务」 | — |
| running / fix_revision | — | `task_id` 非空时 `[看执行 →]`（跳 /tasks/{task_id}） |
| awaiting_review | — | `pr_url` 非空时 `[打开 PR ↗]`（外链新窗）。标记完成/需修改留在详情页（防行内误触） |
| failed | 失败原因红色摘要（schedule_error ?? clarifier_error） | `[↻ 重试]`（api.enqueueRequirement 重新入队） |
| done | — | `pr_url` 非空时 `[打开 PR ↗]` |
| cancelled | — | — |

## 实现要点

1. **特化逻辑纯函数化**：`src/web/src/lib/requirement-card.ts` 导出 `reqCardSpec(req): { preview: string | null; notice: { text: string; tone: "error" | "info" } | null; actions: ReqCardAction[] }`，`ReqCardAction = { key: "approve"|"reject"|"retry"|"retryClarify"|"answer"|"openPr"|"viewTask"; label: string }`。无 React 依赖，bun:test 单测全状态。
2. **RowCard 加 `extra?: ReactNode` 槽**（preview 之后）：notice 条 + actions 行由 RequirementRow 组装塞入。整卡仍是 Link；按钮 `e.preventDefault() + e.stopPropagation()`。
3. **RequirementRow 解释 action descriptor** → 按钮 + handler（toast 成功/失败；busy 态防双击）。动作不带确认弹窗（与详情页一致；驳回回草稿可逆）。
4. **刷新靠 WS**：动作成功后不手动刷列表——流水线页已订阅 `requirement:*`；**项目页补订阅**（回调只静默重拉 `listProjectRequirements`，不闪 loading）。
5. spec 摘要 = `spec_md` 去 markdown 标题符后截断（RowCard preview 已有 line-clamp-2）。

## 测试

- `tests/web-requirement-card.test.ts`：全状态 × 字段组合（有/无 error、pr_url、task_id、active_question_id）的 reqCardSpec 输出。
- UI 接线靠 typecheck + build + dogfood。
