// 需求卡片按状态特义化的纯逻辑：每个状态露什么信息、给什么行内动作。
// UI 解释（按钮/handler/toast）在 PipelineList.tsx 的 RequirementRow；
// 动作语义与需求详情页同源（approve=enqueue、reject=回 drafting、retry=重新入队）。

export interface ReqCardInput {
  status: string;
  spec_md: string;
  task_id: string | null;
  pr_url: string | null;
  active_question_id: string | null;
  clarifier_error: string | null;
  schedule_error: string | null;
}

export type ReqCardActionKey =
  | "approve"      // 审批通过 → api.enqueueRequirement
  | "reject"       // 驳回 → api.transitionRequirement(id, "drafting")
  | "retry"        // 失败/调度失败重新入队 → api.enqueueRequirement
  | "retryClarify" // 澄清失败重试 → POST /api/requirements/{id}/retry-clarify
  | "answer"       // 去回答（进详情页澄清步）
  | "openPr"       // 打开 PR（外链）
  | "viewTask";    // 看执行（跳 /tasks/{task_id}）

export interface ReqCardAction { key: ReqCardActionKey; label: string; }

export interface ReqCardSpec {
  /** 卡片 preview 槽内容（spec 摘要） */
  preview: string | null;
  /** 状态提示条（错误红 / 信息灰） */
  notice: { text: string; tone: "error" | "info" } | null;
  actions: ReqCardAction[];
}

/** spec_md → 单行摘要：去 markdown 标题符、合并空白、截断 120 字符 */
export function specPreview(specMd: string): string | null {
  const flat = specMd
    .replace(/^#+\s*/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!flat) return null;
  return flat.length > 120 ? `${flat.slice(0, 120)}…` : flat;
}

export function reqCardSpec(req: ReqCardInput): ReqCardSpec {
  const s = req.status;

  if (s === "drafting") {
    return { preview: specPreview(req.spec_md), notice: null, actions: [] };
  }

  if (s === "clarifying") {
    if (req.clarifier_error) {
      return {
        preview: null,
        notice: { text: `澄清失败：${req.clarifier_error}`, tone: "error" },
        actions: [{ key: "retryClarify", label: "↻ 重试澄清" }],
      };
    }
    if (req.active_question_id) {
      return {
        preview: null,
        notice: { text: "AI 有问题等你回答", tone: "info" },
        actions: [{ key: "answer", label: "去回答 →" }],
      };
    }
    return { preview: null, notice: null, actions: [] };
  }

  if (s === "ready") {
    if (req.schedule_error) {
      return {
        preview: null,
        notice: { text: `调度失败：${req.schedule_error}`, tone: "error" },
        actions: [{ key: "retry", label: "↻ 重新入队" }],
      };
    }
    return { preview: null, notice: null, actions: [] };
  }

  if (s === "awaiting_approval") {
    return {
      preview: specPreview(req.spec_md),
      notice: null,
      actions: [
        { key: "approve", label: "✓ 通过" },
        { key: "reject", label: "× 驳回" },
      ],
    };
  }

  if (s === "queued") {
    return { preview: null, notice: { text: "排队中 · 等调度器起任务", tone: "info" }, actions: [] };
  }

  if (s === "running" || s === "fix_revision") {
    return {
      preview: null,
      notice: null,
      actions: req.task_id ? [{ key: "viewTask", label: "看执行 →" }] : [],
    };
  }

  if (s === "awaiting_review" || s === "done") {
    return {
      preview: null,
      notice: null,
      actions: req.pr_url ? [{ key: "openPr", label: "打开 PR ↗" }] : [],
    };
  }

  if (s === "failed") {
    const reason = req.schedule_error ?? req.clarifier_error;
    return {
      preview: null,
      notice: { text: reason ? `失败：${reason}` : "执行失败", tone: "error" },
      actions: [{ key: "retry", label: "↻ 重试" }],
    };
  }

  // cancelled 及未知状态：无特化
  return { preview: null, notice: null, actions: [] };
}
