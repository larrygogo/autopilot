import React, { useEffect, useState } from "react";
import { Modal } from "./Modal";

export interface WorkflowAgentDraft {
  name: string;
  extends?: string;
  provider?: string;
  model?: string;
  max_turns?: number;
  permission_mode?: string;
  system_prompt?: string;
}

const NAME_RE = /^[\w.\-]+$/;
const PROVIDERS = ["", "anthropic", "openai", "google"] as const;
const PERMISSION_MODES = ["", "auto", "ask", "readonly", "deny"] as const;

interface Props {
  open: boolean;
  onClose: () => void;
  onSubmit: (value: WorkflowAgentDraft) => void | Promise<void>;
  /** 编辑时传入原值；新建时不传 */
  initial?: WorkflowAgentDraft;
  /** 全局 agent 名称列表，extends 下拉用 */
  globalAgentNames: string[];
  /** 当前工作流其他 agent 的 name（用于重名校验） */
  existingOtherNames: string[];
}

export function WorkflowAgentDialog({ open, onClose, onSubmit, initial, globalAgentNames, existingOtherNames }: Props) {
  const [draft, setDraft] = useState<WorkflowAgentDraft>(initial ?? { name: "" });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) setDraft(initial ?? { name: "" });
  }, [open, initial]);

  const nameValid = NAME_RE.test(draft.name);
  const nameUnique = !existingOtherNames.includes(draft.name);
  const canSubmit = nameValid && nameUnique && !busy;

  const update = <K extends keyof WorkflowAgentDraft>(key: K, value: WorkflowAgentDraft[K]) => {
    setDraft((d) => ({ ...d, [key]: value }));
  };

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    try {
      // 清空字符串字段以便忽略
      const cleaned: WorkflowAgentDraft = { name: draft.name };
      if (draft.extends) cleaned.extends = draft.extends;
      if (draft.provider) cleaned.provider = draft.provider;
      if (draft.model) cleaned.model = draft.model;
      if (typeof draft.max_turns === "number" && draft.max_turns > 0) cleaned.max_turns = draft.max_turns;
      if (draft.permission_mode) cleaned.permission_mode = draft.permission_mode;
      if (draft.system_prompt) cleaned.system_prompt = draft.system_prompt;
      await onSubmit(cleaned);
    } finally {
      setBusy(false);
    }
  };

  const extendsDescribed = draft.extends
    ? `继承全局 agent "${draft.extends}"，未填字段走该基底`
    : draft.name && globalAgentNames.includes(draft.name)
      ? `默认继承同名全局 agent "${draft.name}"（可在下方填 extends 指定别的基底）`
      : "无继承基底，必须填 provider（否则运行时报错）";

  return (
    <Modal
      open={open}
      onClose={() => !busy && onClose()}
      title={initial ? `编辑智能体：${initial.name}` : "添加智能体"}
      size="md"
      dismissable={!busy}
      actions={
        <>
          <button className="btn btn-secondary" onClick={onClose} disabled={busy}>取消</button>
          <button className="btn btn-primary" onClick={submit} disabled={!canSubmit}>
            {busy ? "保存中..." : "保存"}
          </button>
        </>
      }
    >
      <div className="form-grid">
        <label className="col-span-2">
          <span>名称 <span className="required">*</span></span>
          <input
            type="text"
            className="text-input mono"
            placeholder="coder"
            value={draft.name}
            onChange={(e) => update("name", e.target.value)}
            disabled={!!initial}
            autoFocus={!initial}
          />
          {initial && <small className="muted">改名请删除后重建</small>}
          {draft.name && !nameValid && !initial && (
            <small style={{ color: "var(--red)" }}>仅允许字母、数字、._-</small>
          )}
          {draft.name && nameValid && !nameUnique && !initial && (
            <small style={{ color: "var(--red)" }}>该名称已在当前工作流中使用</small>
          )}
        </label>

        <label className="col-span-2">
          <span>继承自（extends）</span>
          <select
            className="wf-select"
            value={draft.extends ?? ""}
            onChange={(e) => update("extends", e.target.value || undefined)}
          >
            <option value="">（默认同名继承 / 留空）</option>
            {globalAgentNames.map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
          <small className="muted">{extendsDescribed}</small>
        </label>

        <label>
          <span>提供商（仅在无继承时必填）</span>
          <select
            className="wf-select"
            value={draft.provider ?? ""}
            onChange={(e) => update("provider", e.target.value || undefined)}
          >
            {PROVIDERS.map((p) => <option key={p} value={p}>{p || "（继承）"}</option>)}
          </select>
        </label>

        <label>
          <span>最大轮数</span>
          <input
            type="number"
            className="text-input"
            min={1}
            placeholder="留空继承"
            value={draft.max_turns ?? ""}
            onChange={(e) => update("max_turns", e.target.value ? parseInt(e.target.value, 10) : undefined)}
          />
        </label>

        <label>
          <span>模型（留空继承）</span>
          <input
            type="text"
            className="text-input mono"
            placeholder="claude-sonnet-4-6"
            value={draft.model ?? ""}
            onChange={(e) => update("model", e.target.value || undefined)}
          />
        </label>

        <label>
          <span>权限模式</span>
          <select
            className="wf-select"
            value={draft.permission_mode ?? ""}
            onChange={(e) => update("permission_mode", e.target.value || undefined)}
          >
            {PERMISSION_MODES.map((p) => <option key={p} value={p}>{p || "（继承）"}</option>)}
          </select>
        </label>

        <label className="col-span-2">
          <span>系统提示词（留空继承）</span>
          <textarea
            className="yaml-editor"
            style={{ minHeight: 160 }}
            placeholder="工作流内特化提示词。留空则沿用全局同名 agent 的 system_prompt。"
            value={draft.system_prompt ?? ""}
            onChange={(e) => update("system_prompt", e.target.value || undefined)}
          />
        </label>
      </div>
    </Modal>
  );
}
