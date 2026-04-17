import React, { useMemo, useState } from "react";
import { api } from "../hooks/useApi";
import { useToast } from "./Toast";
import { ConfirmDialog } from "./Modal";
import { AddPhaseDialog, type NewPhaseData } from "./AddPhaseDialog";
import { AddParallelDialog, type NewParallelData } from "./AddParallelDialog";

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
};
type Item = PhaseItem | ParallelItem;

const STRATEGIES = ["cancel_all", "continue"] as const;

// ──────────────────────────────────────────────
// 序列化 / 反序列化
// ──────────────────────────────────────────────

function normalize(raw: any[]): Item[] {
  return raw.map((p) => {
    if (p && p.parallel) {
      const par = p.parallel;
      return {
        kind: "parallel" as const,
        name: par.name,
        fail_strategy: par.fail_strategy ?? "cancel_all",
        phases: (par.phases ?? []).map(toPhase),
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
      names.push(it.name); // 并行块 name 也占用命名空间
      for (const sub of it.phases) names.push(sub.name);
    } else {
      names.push(it.name);
    }
  }
  return names;
}

/** 遍历 items，把指向不存在阶段的 reject 全部清空。 */
function sanitizeRejects(items: Item[]): Item[] {
  const valid = new Set(flatNames(items));
  return items.map((it) => {
    if (it.kind === "phase" && it.reject && !valid.has(it.reject)) {
      return { ...it, reject: null };
    }
    return it;
  });
}

// ──────────────────────────────────────────────

interface Props {
  workflowName: string;
  initialPhases: any[];
  onSaved?: () => void;
}

type DeleteTarget =
  | { kind: "top"; idx: number; name: string }
  | { kind: "child"; parallelIdx: number; childIdx: number; name: string };

export function PhaseEditor({ workflowName, initialPhases, onSaved }: Props) {
  const toast = useToast();
  const [items, setItems] = useState<Item[]>(() => normalize(initialPhases));
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [addPhaseOpen, setAddPhaseOpen] = useState(false);
  const [addParallelOpen, setAddParallelOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<DeleteTarget | null>(null);

  React.useEffect(() => {
    setItems(normalize(initialPhases));
    setDirty(false);
  }, [JSON.stringify(initialPhases), workflowName]);

  const allNames = useMemo(() => flatNames(items), [items]);
  const parallelOptions = useMemo(
    () => items
      .map((it, i) => (it.kind === "parallel" ? { idx: i, name: it.name } : null))
      .filter(Boolean) as { idx: number; name: string }[],
    [items],
  );

  // 以某顶层索引位置为界，列出其前面所有可见的普通阶段 name（用于 reject 下拉）
  const namesBeforeTop = (topIdx: number): string[] => {
    const names: string[] = [];
    for (let i = 0; i < topIdx; i++) {
      const it = items[i];
      if (it.kind === "parallel") {
        for (const sub of it.phases) names.push(sub.name);
      } else {
        names.push(it.name);
      }
    }
    return names;
  };

  // ── 修改辅助 ──

  const mark = () => setDirty(true);

  const updateTopItem = (idx: number, fn: (it: Item) => Item) => {
    setItems((prev) => prev.map((it, i) => (i === idx ? fn(it) : it)));
    mark();
  };

  const updateChildPhase = (parallelIdx: number, childIdx: number, fn: (p: PhaseItem) => PhaseItem) => {
    setItems((prev) => prev.map((it, i) => {
      if (i !== parallelIdx || it.kind !== "parallel") return it;
      const phases = it.phases.map((p, j) => (j === childIdx ? fn(p) : p));
      return { ...it, phases };
    }));
    mark();
  };

  const moveTop = (idx: number, delta: number) => {
    setItems((prev) => {
      const target = idx + delta;
      if (target < 0 || target >= prev.length) return prev;
      const copy = [...prev];
      [copy[idx], copy[target]] = [copy[target], copy[idx]];
      return copy;
    });
    mark();
  };

  const moveChild = (parallelIdx: number, childIdx: number, delta: number) => {
    setItems((prev) => prev.map((it, i) => {
      if (i !== parallelIdx || it.kind !== "parallel") return it;
      const target = childIdx + delta;
      if (target < 0 || target >= it.phases.length) return it;
      const phases = [...it.phases];
      [phases[childIdx], phases[target]] = [phases[target], phases[childIdx]];
      return { ...it, phases };
    }));
    mark();
  };

  // ── 新增 ──

  const addPhase = (data: NewPhaseData) => {
    const newPhase: PhaseItem = {
      kind: "phase", name: data.name, timeout: data.timeout, reject: null, extras: {},
    };
    setItems((prev) => {
      const copy = [...prev];
      const pos = Math.max(-1, Math.min(data.insertAfter, copy.length - 1));
      copy.splice(pos + 1, 0, newPhase);
      return copy;
    });
    mark();
    setAddPhaseOpen(false);
  };

  const addParallel = (data: NewParallelData) => {
    const newPar: ParallelItem = {
      kind: "parallel",
      name: data.name,
      fail_strategy: data.failStrategy,
      phases: [{ kind: "phase", name: data.firstChild, timeout: data.firstChildTimeout, reject: null, extras: {} }],
    };
    setItems((prev) => {
      const copy = [...prev];
      const pos = Math.max(-1, Math.min(data.insertAfter, copy.length - 1));
      copy.splice(pos + 1, 0, newPar);
      return copy;
    });
    mark();
    setAddParallelOpen(false);
  };

  const addChildToParallel = (parallelIdx: number) => {
    const rawName = window.prompt("子阶段名（小写字母开头）");
    if (!rawName) return;
    if (!/^[a-z][a-z0-9_]*$/.test(rawName)) { toast.warning("名称格式非法"); return; }
    if (allNames.includes(rawName)) { toast.warning("名称已被占用"); return; }
    setItems((prev) => prev.map((it, i) => {
      if (i !== parallelIdx || it.kind !== "parallel") return it;
      const phases = [...it.phases, { kind: "phase" as const, name: rawName, timeout: 900, reject: null, extras: {} }];
      return { ...it, phases };
    }));
    mark();
  };

  // ── 删除 ──

  const doDelete = () => {
    if (!pendingDelete) return;
    if (pendingDelete.kind === "top") {
      setItems((prev) => sanitizeRejects(prev.filter((_, i) => i !== pendingDelete.idx)));
    } else {
      const { parallelIdx, childIdx } = pendingDelete;
      setItems((prev) => {
        const mapped = prev.map((it, i) => {
          if (i !== parallelIdx || it.kind !== "parallel") return it;
          return { ...it, phases: it.phases.filter((_, j) => j !== childIdx) };
        });
        // 子阶段删空时整个并行块移除
        const filtered = mapped.filter((it) => it.kind !== "parallel" || (it as ParallelItem).phases.length > 0);
        return sanitizeRejects(filtered);
      });
    }
    mark();
    setPendingDelete(null);
  };

  // ── 拆解并行 ──

  const ungroupParallel = (idx: number) => {
    setItems((prev) => {
      const target = prev[idx];
      if (!target || target.kind !== "parallel") return prev;
      const copy = [...prev];
      copy.splice(idx, 1, ...target.phases);
      return copy;
    });
    mark();
  };

  // ── 移入 / 移出 ──

  const moveTopPhaseInto = (topIdx: number, parallelIdx: number) => {
    setItems((prev) => {
      const target = prev[topIdx];
      if (!target || target.kind !== "phase") return prev;
      const parallel = prev[parallelIdx];
      if (!parallel || parallel.kind !== "parallel") return prev;

      // 移除顶层 phase，并清除其自身 reject（顺序可能不再成立）
      const withoutTop = prev.filter((_, i) => i !== topIdx);
      const newPhase: PhaseItem = { ...target, reject: null };
      const adjustedParallel = parallelIdx > topIdx ? parallelIdx - 1 : parallelIdx;
      const withInserted = withoutTop.map((it, i) => {
        if (i !== adjustedParallel || it.kind !== "parallel") return it;
        return { ...it, phases: [...it.phases, newPhase] };
      });
      return sanitizeRejects(withInserted);
    });
    mark();
  };

  const moveChildToTop = (parallelIdx: number, childIdx: number) => {
    setItems((prev) => {
      const parallel = prev[parallelIdx];
      if (!parallel || parallel.kind !== "parallel") return prev;
      const child = parallel.phases[childIdx];
      if (!child) return prev;
      const newPar: ParallelItem = {
        ...parallel,
        phases: parallel.phases.filter((_, j) => j !== childIdx),
      };
      const copy = [...prev];
      if (newPar.phases.length === 0) {
        // 并行块变空，移除它
        copy.splice(parallelIdx, 1, child);
      } else {
        copy[parallelIdx] = newPar;
        copy.splice(parallelIdx + 1, 0, child);
      }
      return copy;
    });
    mark();
  };

  // ── 保存 / 撤销 ──

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
      if (res.modified) toast.success(`已追加 ${res.added.length} 个函数：${res.added.join(", ")}`);
      else toast.info("TS 已是最新");
      if (res.orphans.length > 0) toast.warning(`孤儿函数：${res.orphans.join(", ")}`);
    } catch (e: any) {
      toast.error("校准失败", e?.message ?? String(e));
    }
  };

  // ── 渲染 ──

  return (
    <div className="card" style={{ marginTop: "0.75rem" }}>
      <div className="card-header">
        <h3>阶段</h3>
        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
          <button className="btn btn-secondary" onClick={syncTs} title="扫描 workflow.ts 并为缺失阶段追加 run_xxx 函数">
            校准 TS
          </button>
          <button className="btn btn-secondary" onClick={() => setAddParallelOpen(true)}>
            + 并行块
          </button>
          <button className="btn btn-primary" onClick={() => setAddPhaseOpen(true)}>新增阶段</button>
        </div>
      </div>

      {items.length === 0 ? (
        <p className="muted">暂无阶段</p>
      ) : (
        <div className="phase-list">
          {items.map((it, idx) => {
            if (it.kind === "parallel") {
              return (
                <ParallelRow
                  key={idx}
                  item={it}
                  idx={idx}
                  total={items.length}
                  onMoveUp={() => moveTop(idx, -1)}
                  onMoveDown={() => moveTop(idx, 1)}
                  onDelete={() => setPendingDelete({ kind: "top", idx, name: it.name })}
                  onUngroup={() => ungroupParallel(idx)}
                  onUpdateStrategy={(s) => updateTopItem(idx, (old) => (old.kind === "parallel" ? { ...old, fail_strategy: s } : old))}
                  onAddChild={() => addChildToParallel(idx)}
                  onChildUpdate={(childIdx, p) => updateChildPhase(idx, childIdx, () => p)}
                  onChildDelete={(childIdx, name) => setPendingDelete({ kind: "child", parallelIdx: idx, childIdx, name })}
                  onChildMoveUp={(childIdx) => moveChild(idx, childIdx, -1)}
                  onChildMoveDown={(childIdx) => moveChild(idx, childIdx, 1)}
                  onChildLift={(childIdx) => moveChildToTop(idx, childIdx)}
                />
              );
            }
            return (
              <PhaseRow
                key={idx}
                item={it}
                idx={idx}
                total={items.length}
                rejectCandidates={namesBeforeTop(idx)}
                parallelTargets={parallelOptions}
                onMoveUp={() => moveTop(idx, -1)}
                onMoveDown={() => moveTop(idx, 1)}
                onDelete={() => setPendingDelete({ kind: "top", idx, name: it.name })}
                onUpdate={(next) => updateTopItem(idx, () => next)}
                onMoveIntoParallel={(parallelIdx) => moveTopPhaseInto(idx, parallelIdx)}
              />
            );
          })}
        </div>
      )}

      {dirty && (
        <div className="card-actions" style={{ borderTop: "1px solid var(--border)", paddingTop: "0.75rem", marginTop: "0.75rem" }}>
          <button className="btn btn-primary" onClick={save} disabled={saving}>
            {saving ? "保存中..." : "保存更改"}
          </button>
          <button className="btn btn-secondary" onClick={reset} disabled={saving}>撤销</button>
          <span className="muted" style={{ fontSize: "0.78rem", alignSelf: "center" }}>
            保存将写入 workflow.yaml 并自动追加缺失的 run_ 函数
          </span>
        </div>
      )}

      <AddPhaseDialog
        open={addPhaseOpen}
        onClose={() => setAddPhaseOpen(false)}
        onConfirm={addPhase}
        existingNames={allNames}
        count={items.length}
      />

      <AddParallelDialog
        open={addParallelOpen}
        onClose={() => setAddParallelOpen(false)}
        onConfirm={addParallel}
        existingNames={allNames}
        topCount={items.length}
        topLabels={items.map((it) => it.name)}
      />

      <ConfirmDialog
        open={!!pendingDelete}
        title={pendingDelete?.kind === "top" && items[pendingDelete.idx]?.kind === "parallel" ? "删除并行块" : "删除阶段"}
        message={
          <span>
            确认删除 <code className="mono">{pendingDelete?.name}</code>？
            <br />
            <span className="muted" style={{ fontSize: "0.82rem" }}>
              workflow.ts 中的 run_ 函数不会自动删除；若为并行块，其子阶段也会一并移除。
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
// 普通阶段行
// ──────────────────────────────────────────────

interface PhaseRowProps {
  item: PhaseItem;
  idx: number;
  total: number;
  rejectCandidates: string[];
  parallelTargets: { idx: number; name: string }[];
  onMoveUp: () => void;
  onMoveDown: () => void;
  onDelete: () => void;
  onUpdate: (next: PhaseItem) => void;
  onMoveIntoParallel: (parallelIdx: number) => void;
}

function PhaseRow({ item, idx, total, rejectCandidates, parallelTargets, onMoveUp, onMoveDown, onDelete, onUpdate, onMoveIntoParallel }: PhaseRowProps) {
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
                disabled={rejectCandidates.length === 0}
              >
                <option value="">（不驳回）</option>
                {rejectCandidates.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
            {parallelTargets.length > 0 && (
              <label>
                <span className="muted">移入并行块</span>
                <select
                  className="wf-select phase-input"
                  value=""
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v !== "") onMoveIntoParallel(parseInt(v, 10));
                  }}
                >
                  <option value="">（不移动）</option>
                  {parallelTargets.map((p) => <option key={p.idx} value={p.idx}>{p.name}</option>)}
                </select>
              </label>
            )}
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

// ──────────────────────────────────────────────
// 并行块行
// ──────────────────────────────────────────────

interface ParallelRowProps {
  item: ParallelItem;
  idx: number;
  total: number;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onDelete: () => void;
  onUngroup: () => void;
  onUpdateStrategy: (s: string) => void;
  onAddChild: () => void;
  onChildUpdate: (childIdx: number, p: PhaseItem) => void;
  onChildDelete: (childIdx: number, name: string) => void;
  onChildMoveUp: (childIdx: number) => void;
  onChildMoveDown: (childIdx: number) => void;
  onChildLift: (childIdx: number) => void;
}

function ParallelRow(props: ParallelRowProps) {
  const { item, idx, total, onMoveUp, onMoveDown, onDelete, onUngroup, onUpdateStrategy, onAddChild,
    onChildUpdate, onChildDelete, onChildMoveUp, onChildMoveDown, onChildLift } = props;

  return (
    <div className="phase-row phase-row-parallel">
      <div className="phase-row-main" style={{ flexDirection: "column", alignItems: "stretch" }}>
        <div style={{ display: "flex", gap: "0.75rem", alignItems: "flex-start", width: "100%" }}>
          <span className="phase-idx">{idx + 1}</span>
          <div className="phase-body">
            <div className="phase-title">
              <span className="pill pill-accent" style={{ marginRight: "0.5rem" }}>并行</span>
              <span className="mono" style={{ fontSize: "0.95rem" }}>{item.name}</span>
            </div>
            <div className="phase-fields">
              <label>
                <span className="muted">失败策略</span>
                <select
                  className="wf-select phase-input"
                  value={item.fail_strategy ?? "cancel_all"}
                  onChange={(e) => onUpdateStrategy(e.target.value)}
                >
                  {STRATEGIES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </label>
            </div>
          </div>
          <div className="phase-actions">
            <button className="btn-icon" title="上移" onClick={onMoveUp} disabled={idx === 0}>↑</button>
            <button className="btn-icon" title="下移" onClick={onMoveDown} disabled={idx === total - 1}>↓</button>
            <button className="btn-icon" title="拆解为顺序阶段" onClick={onUngroup}>⇲</button>
            <button className="btn-icon btn-icon-danger" title="删除整个并行块" onClick={onDelete}>✕</button>
          </div>
        </div>

        <div className="parallel-children">
          {item.phases.map((sub, j) => (
            <div key={j} className="phase-row parallel-child">
              <div className="phase-row-main">
                <span className="phase-idx-small mono muted">{idx + 1}.{j + 1}</span>
                <div className="phase-body">
                  <div className="phase-title">
                    <span className="mono" style={{ color: "var(--cyan)" }}>{sub.name}</span>
                  </div>
                  <div className="phase-fields">
                    <label>
                      <span className="muted">超时(秒)</span>
                      <input
                        type="number"
                        className="text-input phase-input"
                        min={1}
                        value={sub.timeout ?? ""}
                        placeholder="900"
                        onChange={(e) => onChildUpdate(j, { ...sub, timeout: parseInt(e.target.value, 10) || undefined })}
                      />
                    </label>
                  </div>
                </div>
              </div>
              <div className="phase-actions">
                <button className="btn-icon" title="块内上移" onClick={() => onChildMoveUp(j)} disabled={j === 0}>↑</button>
                <button className="btn-icon" title="块内下移" onClick={() => onChildMoveDown(j)} disabled={j === item.phases.length - 1}>↓</button>
                <button className="btn-icon" title="移出到顶级" onClick={() => onChildLift(j)}>⇱</button>
                <button className="btn-icon btn-icon-danger" title="删除子阶段" onClick={() => onChildDelete(j, sub.name)}>✕</button>
              </div>
            </div>
          ))}
          <button
            className="btn btn-secondary"
            style={{ alignSelf: "flex-start", marginTop: "0.4rem" }}
            onClick={onAddChild}
          >
            + 添加子阶段
          </button>
        </div>
      </div>
    </div>
  );
}
