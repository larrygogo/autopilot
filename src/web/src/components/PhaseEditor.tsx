import React, { useMemo, useState } from "react";
import { api } from "../hooks/useApi";
import { useToast } from "./Toast";
import { ConfirmDialog } from "./Modal";
import { AddPhaseDialog, type NewPhaseData } from "./AddPhaseDialog";

type PhaseItem = {
  kind: "phase";
  name: string;
  timeout?: number;
  reject?: string | null;
  extras: Record<string, unknown>;
};
type ParallelItem = {
  kind: "parallel";
  name: string;
  fail_strategy?: string;
  phases: PhaseItem[];
  raw: Record<string, unknown>;
};
type Item = PhaseItem | ParallelItem;

function normalize(raw: any[]): Item[] {
  return raw.map((p) => {
    if (p && p.parallel) {
      const par = p.parallel;
      return {
        kind: "parallel" as const,
        name: par.name,
        fail_strategy: par.fail_strategy,
        phases: (par.phases ?? []).map((sub: any) => toPhase(sub)),
        raw: par,
      };
    }
    return toPhase(p);
  });
}

function toPhase(p: any): PhaseItem {
  const { name, timeout, reject, ...extras } = p ?? {};
  return { kind: "phase", name, timeout, reject: reject ?? null, extras };
}

function serialize(items: Item[]): unknown[] {
  return items.map((it) => {
    if (it.kind === "parallel") {
      return {
        parallel: {
          name: it.name,
          fail_strategy: it.fail_strategy,
          phases: it.phases.map(serializePhase),
        },
      };
    }
    return serializePhase(it);
  });
}

function serializePhase(p: PhaseItem): Record<string, unknown> {
  const out: Record<string, unknown> = { name: p.name, ...p.extras };
  if (typeof p.timeout === "number" && p.timeout > 0) out.timeout = p.timeout;
  if (p.reject) out.reject = p.reject;
  return out;
}

function flatNames(items: Item[]): string[] {
  const names: string[] = [];
  for (const it of items) {
    if (it.kind === "parallel") {
      for (const sub of it.phases) names.push(sub.name);
    } else {
      names.push(it.name);
    }
  }
  return names;
}

interface Props {
  workflowName: string;
  /** 工作流详情里拿到的原始 phases 数组 */
  initialPhases: any[];
  /** 保存成功后通知父组件刷新详情 */
  onSaved?: () => void;
}

export function PhaseEditor({ workflowName, initialPhases, onSaved }: Props) {
  const toast = useToast();
  const [items, setItems] = useState<Item[]>(() => normalize(initialPhases));
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<{ idx: number; name: string } | null>(null);

  // initialPhases 变化时重置（例如外部 reload 或切换工作流）
  React.useEffect(() => {
    setItems(normalize(initialPhases));
    setDirty(false);
  }, [JSON.stringify(initialPhases), workflowName]);

  const names = useMemo(() => flatNames(items), [items]);

  const updateItem = (idx: number, mutator: (it: Item) => Item) => {
    setItems((prev) => prev.map((it, i) => (i === idx ? mutator(it) : it)));
    setDirty(true);
  };

  const move = (idx: number, delta: number) => {
    setItems((prev) => {
      const target = idx + delta;
      if (target < 0 || target >= prev.length) return prev;
      const copy = [...prev];
      [copy[idx], copy[target]] = [copy[target], copy[idx]];
      return copy;
    });
    setDirty(true);
  };

  const addPhase = (data: NewPhaseData) => {
    const newPhase: PhaseItem = {
      kind: "phase",
      name: data.name,
      timeout: data.timeout,
      reject: null,
      extras: {},
    };
    setItems((prev) => {
      const copy = [...prev];
      const pos = Math.max(-1, Math.min(data.insertAfter, copy.length - 1));
      copy.splice(pos + 1, 0, newPhase);
      return copy;
    });
    setDirty(true);
    setAddOpen(false);
  };

  const doDelete = () => {
    if (!pendingDelete) return;
    setItems((prev) => {
      const copy = [...prev];
      copy.splice(pendingDelete.idx, 1);
      // 清理引用被删阶段的 reject
      return copy.map((it) => {
        if (it.kind === "phase" && it.reject === pendingDelete.name) {
          return { ...it, reject: null };
        }
        return it;
      });
    });
    setDirty(true);
    setPendingDelete(null);
  };

  const save = async () => {
    setSaving(true);
    try {
      const payload = serialize(items);
      const res = await api.setWorkflowPhases(workflowName, payload, true);
      const added = res.ts?.added ?? [];
      if (added.length > 0) {
        toast.success(`已保存，新增 ${added.length} 个阶段函数：${added.join(", ")}`);
      } else {
        toast.success("已保存");
      }
      if ((res.ts?.orphans ?? []).length > 0) {
        toast.warning(`孤儿函数：${res.ts!.orphans.join(", ")}（在 workflow.ts 中存在但未使用，未自动删除）`);
      }
      setDirty(false);
      onSaved?.();
    } catch (e: any) {
      toast.error("保存失败", e?.message ?? String(e));
    } finally {
      setSaving(false);
    }
  };

  const reset = () => {
    setItems(normalize(initialPhases));
    setDirty(false);
  };

  const syncTs = async () => {
    try {
      const res = await api.syncWorkflowTs(workflowName);
      if (res.modified) {
        toast.success(`已追加 ${res.added.length} 个函数：${res.added.join(", ")}`);
      } else {
        toast.info("TS 已是最新，无需校准");
      }
      if (res.orphans.length > 0) {
        toast.warning(`孤儿函数：${res.orphans.join(", ")}`);
      }
    } catch (e: any) {
      toast.error("校准失败", e?.message ?? String(e));
    }
  };

  return (
    <div className="card" style={{ marginTop: "0.75rem" }}>
      <div className="card-header">
        <h3>阶段</h3>
        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
          <button className="btn btn-secondary" onClick={syncTs} title="扫描 workflow.ts 并为缺失阶段追加 run_xxx 函数">
            校准 TS
          </button>
          <button className="btn btn-primary" onClick={() => setAddOpen(true)}>新增阶段</button>
        </div>
      </div>

      {items.length === 0 ? (
        <p className="muted">暂无阶段</p>
      ) : (
        <div className="phase-list">
          {items.map((it, idx) => (
            <PhaseRow
              key={idx}
              item={it}
              idx={idx}
              total={items.length}
              allNamesBefore={items.slice(0, idx).flatMap((p) => p.kind === "parallel" ? p.phases.map(x => x.name) : [p.name])}
              onMoveUp={() => move(idx, -1)}
              onMoveDown={() => move(idx, 1)}
              onDelete={() => setPendingDelete({ idx, name: it.kind === "parallel" ? it.name : it.name })}
              onUpdate={(next) => updateItem(idx, () => next)}
            />
          ))}
        </div>
      )}

      {dirty && (
        <div className="card-actions" style={{ borderTop: "1px solid var(--border)", paddingTop: "0.75rem", marginTop: "0.75rem" }}>
          <button className="btn btn-primary" onClick={save} disabled={saving}>
            {saving ? "保存中..." : "保存更改"}
          </button>
          <button className="btn btn-secondary" onClick={reset} disabled={saving}>
            撤销
          </button>
          <span className="muted" style={{ fontSize: "0.78rem", alignSelf: "center" }}>
            保存将写入 workflow.yaml 并自动追加缺失的 run_ 函数
          </span>
        </div>
      )}

      <AddPhaseDialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onConfirm={addPhase}
        existingNames={names}
        count={items.length}
      />

      <ConfirmDialog
        open={!!pendingDelete}
        title="删除阶段"
        message={
          <span>
            确认删除阶段 <code className="mono">{pendingDelete?.name}</code>？
            <br />
            <span className="muted" style={{ fontSize: "0.82rem" }}>
              workflow.ts 中的 run_{pendingDelete?.name} 函数不会被自动删除（避免丢失业务代码），可在「高级 (YAML)」中手动清理。
            </span>
          </span>
        }
        confirmText="删除"
        danger
        onConfirm={doDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}

// ──────────────────────────────────────────────
// 单行阶段/并行块
// ──────────────────────────────────────────────

interface RowProps {
  item: Item;
  idx: number;
  total: number;
  allNamesBefore: string[];
  onMoveUp: () => void;
  onMoveDown: () => void;
  onDelete: () => void;
  onUpdate: (next: Item) => void;
}

function PhaseRow({ item, idx, total, allNamesBefore, onMoveUp, onMoveDown, onDelete, onUpdate }: RowProps) {
  if (item.kind === "parallel") {
    return (
      <div className="phase-row phase-row-parallel">
        <div className="phase-row-main">
          <span className="phase-idx">{idx + 1}</span>
          <div className="phase-body">
            <div className="phase-title">
              <span className="pill pill-accent" style={{ marginRight: "0.5rem" }}>并行</span>
              <span className="mono">{item.name}</span>
              {item.fail_strategy && (
                <span className="muted" style={{ marginLeft: "0.5rem", fontSize: "0.76rem" }}>
                  失败策略：{item.fail_strategy}
                </span>
              )}
            </div>
            <div className="phase-subgrid">
              {item.phases.map((sub) => (
                <div key={sub.name} className="phase-sub">
                  <span className="mono">{sub.name}</span>
                  {sub.timeout && <span className="muted" style={{ fontSize: "0.72rem" }}>· {sub.timeout}s</span>}
                </div>
              ))}
            </div>
            <p className="muted" style={{ fontSize: "0.72rem", marginTop: "0.5rem" }}>
              ⚠ 并行块结构编辑请在「高级 (YAML)」中修改
            </p>
          </div>
        </div>
        <div className="phase-actions">
          <button className="btn-icon" title="上移" onClick={onMoveUp} disabled={idx === 0}>↑</button>
          <button className="btn-icon" title="下移" onClick={onMoveDown} disabled={idx === total - 1}>↓</button>
          <button className="btn-icon btn-icon-danger" title="删除" onClick={onDelete}>✕</button>
        </div>
      </div>
    );
  }

  return (
    <div className="phase-row">
      <div className="phase-row-main">
        <span className="phase-idx">{idx + 1}</span>
        <div className="phase-body">
          <div className="phase-title">
            <span className="mono" style={{ fontSize: "0.95rem", color: "var(--cyan)" }}>{item.name}</span>
          </div>
          <div className="phase-fields">
            <label>
              <span className="muted">超时(秒)</span>
              <input
                type="number"
                className="text-input phase-input"
                min={1}
                value={item.timeout ?? ""}
                placeholder="900"
                onChange={(e) => onUpdate({ ...item, timeout: parseInt(e.target.value, 10) || undefined })}
              />
            </label>
            <label>
              <span className="muted">驳回到</span>
              <select
                className="wf-select phase-input"
                value={item.reject ?? ""}
                onChange={(e) => onUpdate({ ...item, reject: e.target.value || null })}
                disabled={allNamesBefore.length === 0}
              >
                <option value="">（不驳回）</option>
                {allNamesBefore.map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
            </label>
          </div>
        </div>
      </div>
      <div className="phase-actions">
        <button className="btn-icon" title="上移" onClick={onMoveUp} disabled={idx === 0}>↑</button>
        <button className="btn-icon" title="下移" onClick={onMoveDown} disabled={idx === total - 1}>↓</button>
        <button className="btn-icon btn-icon-danger" title="删除" onClick={onDelete}>✕</button>
      </div>
    </div>
  );
}
