import React, { useState } from "react";
import { api } from "../hooks/useApi";
import { Modal } from "./Modal";
import { useToast } from "./Toast";

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated?: (name: string) => void;
}

const NAME_RE = /^[a-z][a-z0-9_\-]{0,39}$/;
const PHASE_RE = /^[a-z][a-z0-9_]*$/;

export function NewWorkflowDialog({ open, onClose, onCreated }: Props) {
  const toast = useToast();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [firstPhase, setFirstPhase] = useState("step1");
  const [submitting, setSubmitting] = useState(false);

  const reset = () => { setName(""); setDescription(""); setFirstPhase("step1"); };

  const close = () => {
    if (submitting) return;
    reset();
    onClose();
  };

  const nameValid = NAME_RE.test(name);
  const phaseValid = PHASE_RE.test(firstPhase);
  const canSubmit = nameValid && phaseValid && !submitting;

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      await api.createWorkflow({
        name,
        description: description.trim() || undefined,
        firstPhase,
      });
      toast.success(`工作流 ${name} 已创建`);
      onCreated?.(name);
      reset();
      onClose();
    } catch (e: any) {
      toast.error("创建失败", e?.message ?? String(e));
    } finally {
      setSubmitting(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title="新建工作流"
      size="md"
      dismissable={!submitting}
      actions={
        <>
          <button className="btn btn-secondary" onClick={close} disabled={submitting}>取消</button>
          <button className="btn btn-primary" onClick={submit} disabled={!canSubmit}>
            {submitting ? "创建中..." : "创建"}
          </button>
        </>
      }
    >
      <div className="form-grid" onKeyDown={onKeyDown}>
        <label className="col-span-2">
          <span>名称 <span className="required">*</span></span>
          <input
            type="text"
            className="text-input mono"
            placeholder="例如：code_review"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
          <small className={name && !nameValid ? "" : "muted"} style={name && !nameValid ? { color: "var(--red)" } : undefined}>
            {name && !nameValid
              ? "需以小写字母开头，仅含小写字母 / 数字 / _ / -，长度 ≤ 40"
              : "工作流目录名，将创建 AUTOPILOT_HOME/workflows/<name>/"}
          </small>
        </label>

        <label className="col-span-2">
          <span>描述（可选）</span>
          <input
            type="text"
            className="text-input"
            placeholder="一句话说明这个工作流的用途"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>

        <label className="col-span-2">
          <span>首阶段名</span>
          <input
            type="text"
            className="text-input mono"
            value={firstPhase}
            onChange={(e) => setFirstPhase(e.target.value)}
          />
          <small className={firstPhase && !phaseValid ? "" : "muted"} style={firstPhase && !phaseValid ? { color: "var(--red)" } : undefined}>
            {firstPhase && !phaseValid
              ? "需以小写字母开头，仅含小写字母 / 数字 / _"
              : "脚手架会生成对应的 run_<name> 阶段函数"}
          </small>
        </label>
      </div>

      <div className="card" style={{ marginTop: "1rem", background: "var(--bg0)", padding: "0.8rem 1rem" }}>
        <p className="muted" style={{ fontSize: "0.78rem", marginBottom: "0.4rem" }}>将生成文件：</p>
        <ul className="mono" style={{ listStyle: "none", fontSize: "0.78rem", lineHeight: 1.8 }}>
          <li>AUTOPILOT_HOME/workflows/<span style={{ color: "var(--cyan)" }}>{name || "<name>"}</span>/workflow.yaml</li>
          <li>AUTOPILOT_HOME/workflows/<span style={{ color: "var(--cyan)" }}>{name || "<name>"}</span>/workflow.ts</li>
        </ul>
      </div>

      <p className="muted" style={{ marginTop: "0.75rem", fontSize: "0.76rem" }}>
        提示：<kbd>Ctrl/Cmd + Enter</kbd> 快速提交。创建后可在「高级 (YAML)」中继续编辑。
      </p>
    </Modal>
  );
}
