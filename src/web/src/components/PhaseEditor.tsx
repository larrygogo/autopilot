import React, { useMemo, useState } from "react";
import { api } from "../hooks/useApi";
import { useToast } from "./Toast";
import { ConfirmDialog } from "./Modal";
import { AddPhaseDialog, type NewPhaseData } from "./AddPhaseDialog";
import { AddParallelDialog, type NewParallelData } from "./AddParallelDialog";
import {
  validatePhases,
  issuesForTop,
  issuesForChild,
  fieldIssue,
  type Issue,
  type PhaseItem,
  type ParallelItem,
  type Item,
} from "./phaseValidation";

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
  /** 由父组件提供的联动 hover 信号（pipeline / state graph 共享） */
  hoveredPhase?: string | null;
  onHoverPhase?: (name: string | null) => void;
}

type DeleteTarget =
  | { kind: "top"; idx: number; name: string }
  | { kind: "child"; parallelIdx: number; childIdx: number; name: string };

export function PhaseEditor({ workflowName, initialPhases, onSaved, hoveredPhase, onHoverPhase }: Props) {
  const toast = useToast();
  const [items, setItems] = useState<Item[]>(() => normalize(initialPhases));
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [addPhaseOpen, setAddPhaseOpen] = useState(false);
  const [addParallelOpen, setAddParallelOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<DeleteTarget | null>(null);
  const [orphans, setOrphans] = useState<string[]>([]);
  const [pruneConfirm, setPruneConfirm] = useState(false);

  // 追踪"原始阶段改名"的映射：oldName -> newName。
  // 保存时随 phases 一起发给后端，后端会把 workflow.ts 里的
  // run_<old> 重命名为 run_<new>（保留函数体），避免产生孤儿。
  const renamesRef = React.useRef<Map<string, string>>(new Map());
  // 本次编辑新建的阶段名（改名时不纳入 renames — 因为后端不存在 run_<oldName>）
  const newlyAddedRef = React.useRef<Set<string>>(new Set());

  const resetDraftTracking = () => {
    renamesRef.current = new Map();
    newlyAddedRef.current = new Set();
  };

  React.useEffect(() => {
    setItems(normalize(initialPhases));
    setDirty(false);
    resetDraftTracking();
  }, [JSON.stringify(initialPhases), workflowName]);

  const allNames = useMemo(() => flatNames(items), [items]);
  const issues = useMemo(() => validatePhases(items), [items]);
  const hasErrors = issues.length > 0;
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

  /** 重命名阶段 / 并行块：全表同步更新所有指向旧名的 reject 引用；记录 rename 映射 */
  const applyRename = (items: Item[], oldName: string, newName: string): Item[] => {
    if (oldName === newName) return items;

    // 维护 renamesRef
    const newlyAdded = newlyAddedRef.current;
    if (newlyAdded.has(oldName)) {
      // 新建后改名：只更新 newlyAdded，不记录 rename
      newlyAdded.delete(oldName);
      newlyAdded.add(newName);
    } else {
      const renames = renamesRef.current;
      // 查 renames 里 value === oldName 的 key（链式改名：source → oldName → newName）
      let sourceKey: string | null = null;
      for (const [k, v] of renames.entries()) {
        if (v === oldName) { sourceKey = k; break; }
      }
      if (sourceKey !== null) {
        if (sourceKey === newName) renames.delete(sourceKey); // 反向回到原名，抵消
        else renames.set(sourceKey, newName);
      } else {
        renames.set(oldName, newName);
      }
    }

    // 更新 reject 引用
    return items.map((it) => {
      if (it.kind === "phase" && it.reject === oldName) {
        return { ...it, reject: newName };
      }
      return it;
    });
  };

  const updateTopItem = (idx: number, fn: (it: Item) => Item) => {
    setItems((prev) => {
      const old = prev[idx];
      const next = fn(old);
      const mapped = prev.map((it, i) => (i === idx ? next : it));
      const oldName = old?.kind === "phase" ? old.name : old?.kind === "parallel" ? old.name : null;
      const newName = next?.kind === "phase" ? next.name : next?.kind === "parallel" ? next.name : null;
      if (oldName && newName && oldName !== newName) return applyRename(mapped, oldName, newName);
      return mapped;
    });
    mark();
  };

  const updateChildPhase = (parallelIdx: number, childIdx: number, fn: (p: PhaseItem) => PhaseItem) => {
    setItems((prev) => {
      let oldName: string | null = null;
      let newName: string | null = null;
      const mapped = prev.map((it, i) => {
        if (i !== parallelIdx || it.kind !== "parallel") return it;
        const phases = it.phases.map((p, j) => {
          if (j !== childIdx) return p;
          oldName = p.name;
          const updated = fn(p);
          newName = updated.name;
          return updated;
        });
        return { ...it, phases };
      });
      if (oldName && newName && oldName !== newName) return applyRename(mapped, oldName, newName);
      return mapped;
    });
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
    newlyAddedRef.current.add(data.name);
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
    newlyAddedRef.current.add(data.name);
    newlyAddedRef.current.add(data.firstChild);
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
    newlyAddedRef.current.add(rawName);
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
      // renamesRef 里可能有些 key 是"初始时存在但现在已被删除"的阶段。后端只需要处理仍然存在的改名映射。
      const currentNames = new Set(flatNames(items));
      const validRenames: Record<string, string> = {};
      for (const [oldName, newName] of renamesRef.current.entries()) {
        if (currentNames.has(newName)) validRenames[oldName] = newName;
      }
      const renamesToSend = Object.keys(validRenames).length > 0 ? validRenames : undefined;

      const res = await api.setWorkflowPhases(workflowName, payload, true, renamesToSend);
      const added = res.ts?.added ?? [];
      const renamed = res.renamed ?? [];
      const parts: string[] = [];
      if (renamed.length > 0) parts.push(`重命名 ${renamed.length} 个函数：${renamed.join(", ")}`);
      if (added.length > 0) parts.push(`新增 ${added.length} 个函数：${added.join(", ")}`);
      toast.success(parts.length > 0 ? `已保存（${parts.join("；")}）` : "已保存");

      if (res.ts_error) {
        toast.error("TS 同步失败（YAML 已保存）", res.ts_error);
      }
      if ((res.ts?.legacy_signature ?? []).length > 0) {
        toast.error(
          `检测到旧签名：${res.ts!.legacy_signature!.join(", ")}`,
          `这些函数使用 ctx: { task, log } 形式，但 runner 实际只传 taskId 字符串，会导致运行时 "task.id undefined" 报错。\n\n请改为：\nexport async function run_xxx(taskId: string): Promise<void> { ... }`,
        );
      }
      setOrphans(res.ts?.orphans ?? []);
      setDirty(false);
      resetDraftTracking();
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
    resetDraftTracking();
  };

  const syncTs = async () => {
    try {
      const res = await api.syncWorkflowTs(workflowName);
      if (res.modified) toast.success(`已追加 ${res.added.length} 个函数：${res.added.join(", ")}`);
      else toast.info("TS 已是最新");
      setOrphans(res.orphans);
      if ((res.legacy_signature ?? []).length > 0) {
        toast.error(
          `检测到旧签名：${res.legacy_signature!.join(", ")}`,
          `这些函数使用 ctx: { task, log } 形式，但 runner 实际只传 taskId 字符串，会导致运行时 "task.id undefined" 报错。\n\n请改为：\nexport async function run_xxx(taskId: string): Promise<void> { ... }`,
        );
      }
    } catch (e: any) {
      toast.error("校准失败", e?.message ?? String(e));
    }
  };

  const doPrune = async () => {
    try {
      const res = await api.pruneOrphans(workflowName, orphans);
      toast.success(`已清理 ${res.removed.length} 个孤儿函数：${res.removed.join(", ")}（.bak 已备份）`);
      setOrphans([]);
      onSaved?.();
    } catch (e: any) {
      toast.error("清理失败", e?.message ?? String(e));
    } finally {
      setPruneConfirm(false);
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

      {orphans.length > 0 && (
        <div className="orphan-alert">
          <span>
            ⚠ workflow.ts 中存在 {orphans.length} 个孤儿函数：
            {orphans.map((n) => <code key={n} className="mono" style={{ margin: "0 0.3rem" }}>run_{n}</code>)}
          </span>
          <button className="btn btn-danger" onClick={() => setPruneConfirm(true)}>
            清理孤儿
          </button>
        </div>
      )}

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
                  allNames={allNames}
                  issues={issues}
                  hoveredPhase={hoveredPhase ?? null}
                  onHoverPhase={onHoverPhase}
                  onMoveUp={() => moveTop(idx, -1)}
                  onMoveDown={() => moveTop(idx, 1)}
                  onDelete={() => setPendingDelete({ kind: "top", idx, name: it.name })}
                  onUngroup={() => ungroupParallel(idx)}
                  onUpdateStrategy={(s) => updateTopItem(idx, (old) => (old.kind === "parallel" ? { ...old, fail_strategy: s } : old))}
                  onUpdateName={(newName) => updateTopItem(idx, (old) => ({ ...old, name: newName }))}
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
                issues={issuesForTop(issues, idx)}
                hoveredPhase={hoveredPhase ?? null}
                onHoverPhase={onHoverPhase}
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
        <div className="card-actions" style={{ borderTop: "1px solid var(--border)", paddingTop: "0.75rem", marginTop: "0.75rem", flexDirection: "column", alignItems: "flex-start", gap: "0.6rem" }}>
          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
            <button
              className="btn btn-primary"
              onClick={save}
              disabled={saving || hasErrors}
              title={hasErrors ? `有 ${issues.length} 处校验错误，修复后才能保存` : undefined}
            >
              {saving ? "保存中..." : "保存更改"}
            </button>
            <button className="btn btn-secondary" onClick={reset} disabled={saving}>撤销</button>
            {!hasErrors && (
              <span className="muted" style={{ fontSize: "0.78rem", alignSelf: "center" }}>
                保存将写入 workflow.yaml 并自动追加缺失的 run_ 函数
              </span>
            )}
          </div>
          {hasErrors && (
            <div className="validation-summary">
              <strong>⚠ {issues.length} 处错误需修复：</strong>
              <ul>
                {issues.map((iss, i) => (
                  <li key={i}>
                    <code className="mono">{iss.path}</code>
                    <span className="muted" style={{ margin: "0 0.4rem" }}>·</span>
                    {iss.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
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
        open={pruneConfirm}
        title="清理孤儿函数"
        message={
          <div>
            <p>将从 workflow.ts 中删除以下 {orphans.length} 个函数：</p>
            <ul style={{ marginTop: "0.5rem", marginLeft: "1rem", fontFamily: "var(--mono)", fontSize: "0.85rem" }}>
              {orphans.map((n) => <li key={n}>run_{n}</li>)}
            </ul>
            <p className="muted" style={{ marginTop: "0.5rem", fontSize: "0.82rem" }}>
              仅删除函数声明和函数体，字符串 / 注释中的同名字面量不受影响。<br />
              写入前会备份到 workflow.ts.bak。
            </p>
          </div>
        }
        confirmText="清理"
        danger
        onConfirm={doPrune}
        onCancel={() => setPruneConfirm(false)}
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
  issues: Issue[];
  hoveredPhase: string | null;
  onHoverPhase?: (name: string | null) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onDelete: () => void;
  onUpdate: (next: PhaseItem) => void;
  onMoveIntoParallel: (parallelIdx: number) => void;
}

function PhaseRow({ item, idx, total, rejectCandidates, parallelTargets, issues, hoveredPhase, onHoverPhase, onMoveUp, onMoveDown, onDelete, onUpdate, onMoveIntoParallel }: PhaseRowProps) {
  const nameIssue = fieldIssue(issues, "name");
  const timeoutIssue = fieldIssue(issues, "timeout");
  const rejectIssue = fieldIssue(issues, "reject");
  const isHighlight = hoveredPhase === item.name;
  const [nameDraft, setNameDraft] = React.useState(item.name);
  React.useEffect(() => { setNameDraft(item.name); }, [item.name]);

  const commitName = () => {
    const trimmed = nameDraft.trim();
    if (trimmed === item.name) return;
    // 非法值也提交到 state；validatePhases 会标红 + 禁用保存，用户自己修
    onUpdate({ ...item, name: trimmed });
  };

  return (
    <div
      className={`phase-row ${isHighlight ? "highlight" : ""}`}
      onMouseEnter={() => onHoverPhase?.(item.name)}
      onMouseLeave={() => onHoverPhase?.(null)}
    >
      <div className="phase-row-main">
        <span className="phase-idx">{idx + 1}</span>
        <div className="phase-body">
          <div className="phase-title">
            <input
              type="text"
              className={`text-input phase-name-input mono ${nameIssue ? "field-error" : ""}`}
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onBlur={commitName}
              onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
              title={nameIssue?.message ?? "阶段名"}
            />
            {nameIssue && <small className="field-error-msg">{nameIssue.message}</small>}
          </div>
          <div className="phase-fields">
            <label>
              <span className="muted">超时(秒)</span>
              <input
                type="number"
                className={`text-input phase-input ${timeoutIssue ? "field-error" : ""}`}
                min={1}
                value={item.timeout ?? ""}
                placeholder="900"
                onChange={(e) => {
                  const v = e.target.value;
                  onUpdate({ ...item, timeout: v === "" ? undefined : Number(v) });
                }}
              />
              {timeoutIssue && <small className="field-error-msg">{timeoutIssue.message}</small>}
            </label>
            <label>
              <span className="muted">驳回到</span>
              <select
                className={`wf-select phase-input ${rejectIssue ? "field-error" : ""}`}
                value={item.reject ?? ""}
                onChange={(e) => onUpdate({ ...item, reject: e.target.value || null })}
                disabled={rejectCandidates.length === 0}
              >
                <option value="">（不驳回）</option>
                {rejectCandidates.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
              {rejectIssue && <small className="field-error-msg">{rejectIssue.message}</small>}
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
  allNames: string[];
  issues: Issue[];
  hoveredPhase: string | null;
  onHoverPhase?: (name: string | null) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onDelete: () => void;
  onUngroup: () => void;
  onUpdateStrategy: (s: string) => void;
  onUpdateName: (newName: string) => void;
  onAddChild: () => void;
  onChildUpdate: (childIdx: number, p: PhaseItem) => void;
  onChildDelete: (childIdx: number, name: string) => void;
  onChildMoveUp: (childIdx: number) => void;
  onChildMoveDown: (childIdx: number) => void;
  onChildLift: (childIdx: number) => void;
}

function ParallelRow(props: ParallelRowProps) {
  const { item, idx, total, allNames, issues, hoveredPhase, onHoverPhase, onMoveUp, onMoveDown, onDelete, onUngroup, onUpdateStrategy, onUpdateName, onAddChild,
    onChildUpdate, onChildDelete, onChildMoveUp, onChildMoveDown, onChildLift } = props;
  const headHighlight = hoveredPhase === item.name;
  const ownIssues = issuesForTop(issues, idx);
  const nameIssue = fieldIssue(ownIssues, "name");
  const strategyIssue = fieldIssue(ownIssues, "fail_strategy");
  const phasesIssue = fieldIssue(ownIssues, "phases");
  const [nameDraft, setNameDraft] = React.useState(item.name);
  React.useEffect(() => { setNameDraft(item.name); }, [item.name]);
  const commitName = () => {
    const trimmed = nameDraft.trim();
    if (trimmed === item.name) return;
    onUpdateName(trimmed);
  };

  return (
    <div className={`phase-row phase-row-parallel ${headHighlight ? "highlight" : ""}`}>
      <div className="phase-row-main" style={{ flexDirection: "column", alignItems: "stretch" }}>
        <div
          style={{ display: "flex", gap: "0.75rem", alignItems: "flex-start", width: "100%" }}
          onMouseEnter={() => onHoverPhase?.(item.name)}
          onMouseLeave={() => onHoverPhase?.(null)}
        >
          <span className="phase-idx">{idx + 1}</span>
          <div className="phase-body">
            <div className="phase-title">
              <span className="pill pill-accent" style={{ marginRight: "0.5rem" }}>并行</span>
              <input
                type="text"
                className={`text-input phase-name-input mono ${nameIssue ? "field-error" : ""}`}
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                onBlur={commitName}
                onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                title={nameIssue?.message}
              />
              {nameIssue && <small className="field-error-msg">{nameIssue.message}</small>}
            </div>
            <div className="phase-fields">
              <label>
                <span className="muted">失败策略</span>
                <select
                  className={`wf-select phase-input ${strategyIssue ? "field-error" : ""}`}
                  value={item.fail_strategy ?? "cancel_all"}
                  onChange={(e) => onUpdateStrategy(e.target.value)}
                >
                  {STRATEGIES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
                {strategyIssue && <small className="field-error-msg">{strategyIssue.message}</small>}
              </label>
            </div>
            {phasesIssue && (
              <small className="field-error-msg" style={{ display: "block", marginTop: "0.3rem" }}>
                {phasesIssue.message}
              </small>
            )}
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
            <ParallelChildRow
              key={j}
              sub={sub}
              outerIdx={idx}
              innerIdx={j}
              total={item.phases.length}
              issues={issuesForChild(issues, idx, j)}
              isHighlight={hoveredPhase === sub.name}
              onHoverPhase={onHoverPhase}
              onUpdate={(next) => onChildUpdate(j, next)}
              onDelete={() => onChildDelete(j, sub.name)}
              onMoveUp={() => onChildMoveUp(j)}
              onMoveDown={() => onChildMoveDown(j)}
              onLift={() => onChildLift(j)}
            />
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

// ──────────────────────────────────────────────
// 并行子阶段行（名字可编辑）
// ──────────────────────────────────────────────

interface ParallelChildRowProps {
  sub: PhaseItem;
  outerIdx: number;
  innerIdx: number;
  total: number;
  issues: Issue[];
  isHighlight: boolean;
  onHoverPhase?: (name: string | null) => void;
  onUpdate: (next: PhaseItem) => void;
  onDelete: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onLift: () => void;
}

function ParallelChildRow({ sub, outerIdx, innerIdx, total, issues, isHighlight, onHoverPhase, onUpdate, onDelete, onMoveUp, onMoveDown, onLift }: ParallelChildRowProps) {
  const nameIssue = fieldIssue(issues, "name");
  const timeoutIssue = fieldIssue(issues, "timeout");
  const [nameDraft, setNameDraft] = React.useState(sub.name);
  React.useEffect(() => { setNameDraft(sub.name); }, [sub.name]);

  const commitName = () => {
    const trimmed = nameDraft.trim();
    if (trimmed === sub.name) return;
    onUpdate({ ...sub, name: trimmed });
  };

  return (
    <div
      className={`phase-row parallel-child ${isHighlight ? "highlight" : ""}`}
      onMouseEnter={() => onHoverPhase?.(sub.name)}
      onMouseLeave={() => onHoverPhase?.(null)}
    >
      <div className="phase-row-main">
        <span className="phase-idx-small mono muted">{outerIdx + 1}.{innerIdx + 1}</span>
        <div className="phase-body">
          <div className="phase-title">
            <input
              type="text"
              className={`text-input phase-name-input mono ${nameIssue ? "field-error" : ""}`}
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onBlur={commitName}
              onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
              title={nameIssue?.message}
            />
            {nameIssue && <small className="field-error-msg">{nameIssue.message}</small>}
          </div>
          <div className="phase-fields">
            <label>
              <span className="muted">超时(秒)</span>
              <input
                type="number"
                className={`text-input phase-input ${timeoutIssue ? "field-error" : ""}`}
                min={1}
                value={sub.timeout ?? ""}
                placeholder="900"
                onChange={(e) => {
                  const v = e.target.value;
                  onUpdate({ ...sub, timeout: v === "" ? undefined : Number(v) });
                }}
              />
              {timeoutIssue && <small className="field-error-msg">{timeoutIssue.message}</small>}
            </label>
          </div>
        </div>
      </div>
      <div className="phase-actions">
        <button className="btn-icon" title="块内上移" onClick={onMoveUp} disabled={innerIdx === 0}>↑</button>
        <button className="btn-icon" title="块内下移" onClick={onMoveDown} disabled={innerIdx === total - 1}>↓</button>
        <button className="btn-icon" title="移出到顶级" onClick={onLift}>⇱</button>
        <button className="btn-icon btn-icon-danger" title="删除子阶段" onClick={onDelete}>✕</button>
      </div>
    </div>
  );
}
