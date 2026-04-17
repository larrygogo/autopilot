import React, { useEffect, useState } from "react";
import { api } from "../hooks/useApi";
import { Modal } from "./Modal";
import { useToast } from "./Toast";

interface Workflow {
  name: string;
  description?: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated?: (taskId: string) => void;
}

export function NewTaskDialog({ open, onClose, onCreated }: Props) {
  const toast = useToast();
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [loadingWf, setLoadingWf] = useState(false);
  const [workflow, setWorkflow] = useState("");
  const [reqId, setReqId] = useState("");
  const [title, setTitle] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setReqId("");
    setTitle("");
    setLoadingWf(true);
    api.listWorkflows()
      .then((list) => {
        setWorkflows(list);
        // 自动选中：单一工作流 / 第一个
        if (list.length > 0 && !workflow) setWorkflow(list[0].name);
      })
      .catch((e) => toast.error("加载工作流失败", e?.message ?? String(e)))
      .finally(() => setLoadingWf(false));
  }, [open]);

  const canSubmit = !!workflow && !!reqId.trim() && !submitting;

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const task = await api.startTask({
        reqId: reqId.trim(),
        title: title.trim() || undefined,
        workflow,
      });
      toast.success(`任务已创建：${task.id}`);
      onCreated?.(task.id);
      onClose();
    } catch (e: any) {
      toast.error("创建任务失败", e?.message ?? String(e));
    } finally {
      setSubmitting(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
  };

  return (
    <Modal
      open={open}
      onClose={() => !submitting && onClose()}
      title="新建任务"
      size="md"
      dismissable={!submitting}
      actions={
        <>
          <button className="btn btn-secondary" onClick={onClose} disabled={submitting}>取消</button>
          <button className="btn btn-primary" onClick={submit} disabled={!canSubmit}>
            {submitting ? "创建中..." : "创建"}
          </button>
        </>
      }
    >
      <div className="form-grid" onKeyDown={handleKeyDown}>
        <label className="col-span-2">
          <span>工作流 <span className="required">*</span></span>
          {loadingWf ? (
            <p className="muted" style={{ fontSize: "0.82rem" }}>加载中...</p>
          ) : workflows.length === 0 ? (
            <p style={{ color: "var(--red)", fontSize: "0.82rem" }}>
              未发现工作流。请先在 AUTOPILOT_HOME/workflows/ 下添加工作流。
            </p>
          ) : (
            <select
              className="wf-select"
              value={workflow}
              onChange={(e) => setWorkflow(e.target.value)}
            >
              {workflows.map((wf) => (
                <option key={wf.name} value={wf.name}>
                  {wf.name}{wf.description ? ` — ${wf.description}` : ""}
                </option>
              ))}
            </select>
          )}
        </label>

        <label className="col-span-2">
          <span>请求 ID <span className="required">*</span></span>
          <input
            type="text"
            className="text-input mono"
            placeholder="例如：req-20260417-001"
            value={reqId}
            onChange={(e) => setReqId(e.target.value)}
            autoFocus
          />
          <small className="muted">唯一标识本次任务；前 8 字符作为 task ID</small>
        </label>

        <label className="col-span-2">
          <span>标题（可选）</span>
          <input
            type="text"
            className="text-input"
            placeholder="不填则使用 req ID 作为标题"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
      </div>
      <p className="muted" style={{ marginTop: "0.75rem", fontSize: "0.78rem" }}>
        提示：<kbd>Ctrl/Cmd + Enter</kbd> 快速提交
      </p>
    </Modal>
  );
}
