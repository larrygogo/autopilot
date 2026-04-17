import React, { useState } from "react";
import { Modal } from "./Modal";

export interface NewPhaseData {
  name: string;
  timeout: number;
  insertAfter: number; // -1 = head, otherwise 0-based index
}

const PHASE_NAME_RE = /^[a-z][a-z0-9_]*$/;

interface Props {
  open: boolean;
  onClose: () => void;
  onConfirm: (data: NewPhaseData) => void | Promise<void>;
  existingNames: string[];
  /** 当前阶段列表长度，用于插入位置选项 */
  count: number;
}

export function AddPhaseDialog({ open, onClose, onConfirm, existingNames, count }: Props) {
  const [name, setName] = useState("");
  const [timeout, setTimeout] = useState(900);
  const [insertAfter, setInsertAfter] = useState<number>(count - 1);
  const [busy, setBusy] = useState(false);

  const reset = () => { setName(""); setTimeout(900); setInsertAfter(count - 1); };

  const close = () => {
    if (busy) return;
    reset();
    onClose();
  };

  const nameValid = PHASE_NAME_RE.test(name);
  const nameUnique = !existingNames.includes(name);
  const canSubmit = nameValid && nameUnique && timeout > 0 && !busy;

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    try {
      await onConfirm({ name, timeout, insertAfter });
      reset();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title="新增阶段"
      size="sm"
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
          <span>阶段名 <span className="required">*</span></span>
          <input
            type="text"
            className="text-input mono"
            placeholder="例如：review"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
          {name && !nameValid && (
            <small style={{ color: "var(--red)" }}>须以小写字母开头，仅含小写字母 / 数字 / _</small>
          )}
          {name && nameValid && !nameUnique && (
            <small style={{ color: "var(--red)" }}>该阶段名已存在</small>
          )}
          {!name && <small className="muted">将自动生成 run_&lt;阶段名&gt; 函数</small>}
        </label>

        <label className="col-span-2">
          <span>超时（秒）</span>
          <input
            type="number"
            className="text-input"
            min={1}
            value={timeout}
            onChange={(e) => setTimeout(parseInt(e.target.value, 10) || 0)}
          />
        </label>

        <label className="col-span-2">
          <span>插入位置</span>
          <select
            className="wf-select"
            value={insertAfter}
            onChange={(e) => setInsertAfter(parseInt(e.target.value, 10))}
          >
            <option value={-1}>插入到开头</option>
            {existingNames.map((n, i) => (
              <option key={n} value={i}>在「{n}」之后</option>
            ))}
          </select>
        </label>
      </div>
    </Modal>
  );
}
