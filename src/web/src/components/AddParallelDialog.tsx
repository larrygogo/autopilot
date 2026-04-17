import React, { useState } from "react";
import { Modal } from "./Modal";

export interface NewParallelData {
  name: string;
  failStrategy: string;
  firstChild: string;
  firstChildTimeout: number;
  insertAfter: number; // -1 = head, otherwise 0-based index of top-level
}

const NAME_RE = /^[a-z][a-z0-9_]*$/;
const STRATEGIES = ["cancel_all", "continue"] as const;

interface Props {
  open: boolean;
  onClose: () => void;
  onConfirm: (data: NewParallelData) => void | Promise<void>;
  /** 所有已有阶段名（含并行块内），防重名 */
  existingNames: string[];
  /** 顶层条目数量 */
  topCount: number;
  /** 顶层条目显示名（用于"在 X 之后"） */
  topLabels: string[];
}

export function AddParallelDialog({ open, onClose, onConfirm, existingNames, topCount, topLabels }: Props) {
  const [name, setName] = useState("");
  const [failStrategy, setFailStrategy] = useState<string>("cancel_all");
  const [firstChild, setFirstChild] = useState("");
  const [firstChildTimeout, setFirstChildTimeout] = useState(900);
  const [insertAfter, setInsertAfter] = useState(topCount - 1);
  const [busy, setBusy] = useState(false);

  const reset = () => {
    setName(""); setFailStrategy("cancel_all");
    setFirstChild(""); setFirstChildTimeout(900);
    setInsertAfter(topCount - 1);
  };

  const close = () => { if (busy) return; reset(); onClose(); };

  const nameValid = NAME_RE.test(name);
  const nameUnique = !existingNames.includes(name);
  const childValid = NAME_RE.test(firstChild);
  const childUnique = firstChild !== name && !existingNames.includes(firstChild);
  const canSubmit = nameValid && nameUnique && childValid && childUnique && firstChildTimeout > 0 && !busy;

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    try {
      await onConfirm({ name, failStrategy, firstChild, firstChildTimeout, insertAfter });
      reset();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title="新增并行块"
      size="md"
      dismissable={!busy}
      actions={
        <>
          <button className="btn btn-secondary" onClick={close} disabled={busy}>取消</button>
          <button className="btn btn-primary" onClick={submit} disabled={!canSubmit}>
            {busy ? "保存中..." : "添加"}
          </button>
        </>
      }
    >
      <div className="form-grid">
        <label className="col-span-2">
          <span>并行块名 <span className="required">*</span></span>
          <input
            type="text"
            className="text-input mono"
            placeholder="例如：development"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
          {name && !nameValid && <small style={{ color: "var(--red)" }}>须以小写字母开头，仅含小写字母 / 数字 / _</small>}
          {name && nameValid && !nameUnique && <small style={{ color: "var(--red)" }}>名称已被占用</small>}
          {!name && <small className="muted">在状态图中作为分叉节点名；不会生成 run_ 函数</small>}
        </label>

        <label className="col-span-2">
          <span>失败策略</span>
          <select className="wf-select" value={failStrategy} onChange={(e) => setFailStrategy(e.target.value)}>
            {STRATEGIES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <small className="muted">
            <strong>cancel_all</strong>：任一子阶段失败则全部中止；
            <strong>continue</strong>：失败后其他子阶段继续运行
          </small>
        </label>

        <label className="col-span-2">
          <span>插入位置</span>
          <select className="wf-select" value={insertAfter} onChange={(e) => setInsertAfter(parseInt(e.target.value, 10))}>
            <option value={-1}>插入到开头</option>
            {topLabels.map((l, i) => <option key={i} value={i}>在「{l}」之后</option>)}
          </select>
        </label>

        <div className="col-span-2" style={{ borderTop: "1px solid var(--border)", paddingTop: "0.75rem" }}>
          <p className="muted" style={{ fontSize: "0.78rem", marginBottom: "0.75rem" }}>
            并行块必须至少包含 1 个子阶段。请填写第一个子阶段：
          </p>
        </div>

        <label>
          <span>子阶段名 <span className="required">*</span></span>
          <input
            type="text"
            className="text-input mono"
            placeholder="例如：frontend"
            value={firstChild}
            onChange={(e) => setFirstChild(e.target.value)}
          />
          {firstChild && !childValid && <small style={{ color: "var(--red)" }}>格式非法</small>}
          {firstChild && childValid && !childUnique && <small style={{ color: "var(--red)" }}>名称已被占用</small>}
        </label>

        <label>
          <span>超时（秒）</span>
          <input
            type="number"
            className="text-input"
            min={1}
            value={firstChildTimeout}
            onChange={(e) => setFirstChildTimeout(parseInt(e.target.value, 10) || 0)}
          />
        </label>
      </div>
    </Modal>
  );
}
