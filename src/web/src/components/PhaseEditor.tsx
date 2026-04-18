import React, { useMemo, useState } from "react";
import {
  Plus,
  Trash2,
  ArrowUp,
  ArrowDown,
  GripVertical,
  AlertTriangle,
  Layers,
  Ungroup,
  ArrowUpFromLine,
} from "lucide-react";
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
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

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

export function PhaseEditor({
  workflowName,
  initialPhases,
  onSaved,
  hoveredPhase,
  onHoverPhase,
}: Props) {
  const toast = useToast();
  const [items, setItems] = useState<Item[]>(() => normalize(initialPhases));
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [addPhaseOpen, setAddPhaseOpen] = useState(false);
  const [addParallelOpen, setAddParallelOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<DeleteTarget | null>(null);
  const [orphans, setOrphans] = useState<string[]>([]);
  const [pruneConfirm, setPruneConfirm] = useState(false);
  // 拖拽状态：{ kind:"top", idx }（顶层）或 { kind:"child", pIdx, cIdx }（并行块子项）
  const [dragSource, setDragSource] = useState<
    | { kind: "top"; idx: number }
    | { kind: "child"; parallelIdx: number; childIdx: number }
    | null
  >(null);
  const [dragOverTopIdx, setDragOverTopIdx] = useState<number | null>(null);
  const [dragOverChild, setDragOverChild] = useState<{
    parallelIdx: number;
    childIdx: number;
  } | null>(null);

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
    () =>
      items
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
        if (v === oldName) {
          sourceKey = k;
          break;
        }
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
      const oldName =
        old?.kind === "phase" ? old.name : old?.kind === "parallel" ? old.name : null;
      const newName =
        next?.kind === "phase" ? next.name : next?.kind === "parallel" ? next.name : null;
      if (oldName && newName && oldName !== newName)
        return applyRename(mapped, oldName, newName);
      return mapped;
    });
    mark();
  };

  const updateChildPhase = (
    parallelIdx: number,
    childIdx: number,
    fn: (p: PhaseItem) => PhaseItem,
  ) => {
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
      if (oldName && newName && oldName !== newName)
        return applyRename(mapped, oldName, newName);
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

  /** 拖拽：把顶层 from 项移到 to 位置（to 是插入后的目标 index） */
  const reorderTop = (from: number, to: number) => {
    if (from === to) return;
    setItems((prev) => {
      if (from < 0 || from >= prev.length || to < 0 || to >= prev.length) return prev;
      const copy = [...prev];
      const [moved] = copy.splice(from, 1);
      copy.splice(to, 0, moved);
      return copy;
    });
    mark();
  };

  /** 拖拽：并行块内子阶段重排 */
  const reorderChild = (parallelIdx: number, from: number, to: number) => {
    if (from === to) return;
    setItems((prev) =>
      prev.map((it, i) => {
        if (i !== parallelIdx || it.kind !== "parallel") return it;
        if (from < 0 || from >= it.phases.length || to < 0 || to >= it.phases.length) return it;
        const phases = [...it.phases];
        const [moved] = phases.splice(from, 1);
        phases.splice(to, 0, moved);
        return { ...it, phases };
      }),
    );
    mark();
  };

  const moveChild = (parallelIdx: number, childIdx: number, delta: number) => {
    setItems((prev) =>
      prev.map((it, i) => {
        if (i !== parallelIdx || it.kind !== "parallel") return it;
        const target = childIdx + delta;
        if (target < 0 || target >= it.phases.length) return it;
        const phases = [...it.phases];
        [phases[childIdx], phases[target]] = [phases[target], phases[childIdx]];
        return { ...it, phases };
      }),
    );
    mark();
  };

  // ── 新增 ──

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
    newlyAddedRef.current.add(data.name);
    mark();
    setAddPhaseOpen(false);
  };

  const addParallel = (data: NewParallelData) => {
    const newPar: ParallelItem = {
      kind: "parallel",
      name: data.name,
      fail_strategy: data.failStrategy,
      phases: [
        {
          kind: "phase",
          name: data.firstChild,
          timeout: data.firstChildTimeout,
          reject: null,
          extras: {},
        },
      ],
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
    if (!/^[a-z][a-z0-9_]*$/.test(rawName)) {
      toast.warning("名称格式非法");
      return;
    }
    if (allNames.includes(rawName)) {
      toast.warning("名称已被占用");
      return;
    }
    setItems((prev) =>
      prev.map((it, i) => {
        if (i !== parallelIdx || it.kind !== "parallel") return it;
        const phases = [
          ...it.phases,
          {
            kind: "phase" as const,
            name: rawName,
            timeout: 900,
            reject: null,
            extras: {},
          },
        ];
        return { ...it, phases };
      }),
    );
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
        const filtered = mapped.filter(
          (it) => it.kind !== "parallel" || (it as ParallelItem).phases.length > 0,
        );
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
      if (renamed.length > 0)
        parts.push(`重命名 ${renamed.length} 个函数：${renamed.join(", ")}`);
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
      if (res.modified)
        toast.success(`已追加 ${res.added.length} 个函数：${res.added.join(", ")}`);
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
      toast.success(
        `已清理 ${res.removed.length} 个孤儿函数：${res.removed.join(", ")}（.bak 已备份）`,
      );
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
    <Card className="mt-3 p-4">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold">阶段</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {items.length === 0 ? "暂无阶段" : `${items.length} 个顶层节点`}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            onClick={syncTs}
            title="扫描 workflow.ts 并为缺失阶段追加 run_xxx 函数"
          >
            校准 TS
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setAddParallelOpen(true)}>
            <Layers className="h-3.5 w-3.5" />
            并行块
          </Button>
          <Button size="sm" onClick={() => setAddPhaseOpen(true)}>
            <Plus className="h-3.5 w-3.5" />
            新增阶段
          </Button>
        </div>
      </div>

      {orphans.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-500/40 bg-amber-500/5 px-3.5 py-2.5 text-sm">
          <span className="flex flex-wrap items-center gap-1.5">
            <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
            <span>workflow.ts 中存在 {orphans.length} 个孤儿函数：</span>
            {orphans.map((n) => (
              <code
                key={n}
                className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground"
              >
                run_{n}
              </code>
            ))}
          </span>
          <Button size="sm" variant="destructive" onClick={() => setPruneConfirm(true)}>
            <Trash2 className="h-3.5 w-3.5" />
            清理孤儿
          </Button>
        </div>
      )}

      {items.length === 0 ? (
        <div className="rounded-lg border border-dashed bg-card/50 px-6 py-10 text-center text-sm text-muted-foreground">
          暂无阶段，点击右上角「新增阶段」开始
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {items.map((it, idx) => {
            const dragHandlers: DragHandlers = {
              draggable: true,
              isDragging: dragSource?.kind === "top" && dragSource.idx === idx,
              isDropTarget:
                dragOverTopIdx === idx &&
                dragSource?.kind === "top" &&
                dragSource.idx !== idx,
              onDragStart: () => setDragSource({ kind: "top", idx }),
              onDragOver: (e: React.DragEvent) => {
                if (dragSource?.kind !== "top") return;
                e.preventDefault();
                setDragOverTopIdx(idx);
              },
              onDragLeave: () =>
                setDragOverTopIdx((prev) => (prev === idx ? null : prev)),
              onDrop: (e: React.DragEvent) => {
                e.preventDefault();
                if (dragSource?.kind === "top") reorderTop(dragSource.idx, idx);
                setDragSource(null);
                setDragOverTopIdx(null);
              },
              onDragEnd: () => {
                setDragSource(null);
                setDragOverTopIdx(null);
              },
            };
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
                  dragHandlers={dragHandlers}
                  onReorderChild={(from, to) => reorderChild(idx, from, to)}
                  dragOverChildState={
                    dragOverChild?.parallelIdx === idx ? dragOverChild : null
                  }
                  dragSourceForParallel={
                    dragSource?.kind === "child" && dragSource.parallelIdx === idx
                      ? dragSource
                      : null
                  }
                  setChildDragSource={(src) => setDragSource(src)}
                  setChildDragOver={setDragOverChild}
                  onMoveUp={() => moveTop(idx, -1)}
                  onMoveDown={() => moveTop(idx, 1)}
                  onDelete={() => setPendingDelete({ kind: "top", idx, name: it.name })}
                  onUngroup={() => ungroupParallel(idx)}
                  onUpdateStrategy={(s) =>
                    updateTopItem(idx, (old) =>
                      old.kind === "parallel" ? { ...old, fail_strategy: s } : old,
                    )
                  }
                  onUpdateName={(newName) =>
                    updateTopItem(idx, (old) => ({ ...old, name: newName }))
                  }
                  onAddChild={() => addChildToParallel(idx)}
                  onChildUpdate={(childIdx, p) =>
                    updateChildPhase(idx, childIdx, () => p)
                  }
                  onChildDelete={(childIdx, name) =>
                    setPendingDelete({
                      kind: "child",
                      parallelIdx: idx,
                      childIdx,
                      name,
                    })
                  }
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
                dragHandlers={dragHandlers}
                hoveredPhase={hoveredPhase ?? null}
                onHoverPhase={onHoverPhase}
                onMoveUp={() => moveTop(idx, -1)}
                onMoveDown={() => moveTop(idx, 1)}
                onDelete={() => setPendingDelete({ kind: "top", idx, name: it.name })}
                onUpdate={(next) => updateTopItem(idx, () => next)}
                onMoveIntoParallel={(parallelIdx) =>
                  moveTopPhaseInto(idx, parallelIdx)
                }
              />
            );
          })}
        </div>
      )}

      {dirty && (
        <div className="mt-4 flex flex-col gap-2.5 border-t pt-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              onClick={save}
              disabled={saving || hasErrors}
              title={
                hasErrors
                  ? `有 ${issues.length} 处校验错误，修复后才能保存`
                  : undefined
              }
            >
              {saving ? "保存中…" : "保存更改"}
            </Button>
            <Button variant="secondary" onClick={reset} disabled={saving}>
              撤销
            </Button>
            {!hasErrors && (
              <span className="text-xs text-muted-foreground">
                保存将写入 workflow.yaml 并自动追加缺失的 run_ 函数
              </span>
            )}
          </div>
          {hasErrors && (
            <div className="rounded-lg border border-destructive/40 bg-destructive/5 px-3.5 py-2.5 text-sm">
              <div className="flex items-center gap-1.5 text-destructive">
                <AlertTriangle className="h-4 w-4" />
                <strong className="font-semibold">
                  {issues.length} 处错误需修复：
                </strong>
              </div>
              <ul className="mt-1.5 space-y-0.5 pl-5 text-xs">
                {issues.map((iss, i) => (
                  <li key={i} className="list-disc">
                    <code className="rounded bg-muted px-1 font-mono text-foreground">
                      {iss.path}
                    </code>
                    <span className="mx-1.5 text-muted-foreground">·</span>
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
          <div className="space-y-2">
            <p>将从 workflow.ts 中删除以下 {orphans.length} 个函数：</p>
            <ul className="space-y-0.5 rounded-md border bg-muted/40 p-2 pl-5 font-mono text-xs">
              {orphans.map((n) => (
                <li key={n} className="list-disc">
                  run_{n}
                </li>
              ))}
            </ul>
            <p className="text-xs text-muted-foreground">
              仅删除函数声明和函数体，字符串 / 注释中的同名字面量不受影响。
              <br />
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
        title={
          pendingDelete?.kind === "top" &&
          items[pendingDelete.idx]?.kind === "parallel"
            ? "删除并行块"
            : "删除阶段"
        }
        message={
          <span>
            确认删除{" "}
            <code className="rounded bg-muted px-1 font-mono">
              {pendingDelete?.name}
            </code>
            ？
            <br />
            <span className="text-xs text-muted-foreground">
              workflow.ts 中的 run_ 函数不会自动删除；若为并行块，其子阶段也会一并移除。
            </span>
          </span>
        }
        confirmText="删除"
        danger
        onConfirm={doDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </Card>
  );
}

// ──────────────────────────────────────────────
// 行容器：统一拖拽视觉
// ──────────────────────────────────────────────

interface DragHandlers {
  draggable: boolean;
  isDragging: boolean;
  isDropTarget: boolean;
  onDragStart: () => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (e: React.DragEvent) => void;
  onDragEnd: () => void;
}

/** 序号 chip，承担 drag handle 角色 */
function IndexHandle({
  label,
  size = "md",
  dragHandlers,
}: {
  label: React.ReactNode;
  size?: "md" | "sm";
  dragHandlers: DragHandlers;
}) {
  return (
    <span
      draggable={dragHandlers.draggable}
      onDragStart={dragHandlers.onDragStart}
      onDragEnd={dragHandlers.onDragEnd}
      title="拖动以重排"
      className={cn(
        "inline-flex shrink-0 cursor-grab items-center justify-center gap-0.5 rounded-full bg-muted font-mono text-muted-foreground transition-colors hover:text-foreground active:cursor-grabbing",
        size === "md" ? "size-7 text-xs" : "h-5 px-1.5 text-[10px]",
      )}
    >
      <GripVertical
        className={cn("opacity-60", size === "md" ? "h-3 w-3" : "h-2.5 w-2.5")}
      />
      <span>{label}</span>
    </span>
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
  dragHandlers: DragHandlers;
  hoveredPhase: string | null;
  onHoverPhase?: (name: string | null) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onDelete: () => void;
  onUpdate: (next: PhaseItem) => void;
  onMoveIntoParallel: (parallelIdx: number) => void;
}

function PhaseRow({
  item,
  idx,
  total,
  rejectCandidates,
  parallelTargets,
  issues,
  dragHandlers,
  hoveredPhase,
  onHoverPhase,
  onMoveUp,
  onMoveDown,
  onDelete,
  onUpdate,
  onMoveIntoParallel,
}: PhaseRowProps) {
  const nameIssue = fieldIssue(issues, "name");
  const timeoutIssue = fieldIssue(issues, "timeout");
  const rejectIssue = fieldIssue(issues, "reject");
  const isHighlight = hoveredPhase === item.name;
  const [nameDraft, setNameDraft] = React.useState(item.name);
  React.useEffect(() => {
    setNameDraft(item.name);
  }, [item.name]);

  const commitName = () => {
    const trimmed = nameDraft.trim();
    if (trimmed === item.name) return;
    // 非法值也提交到 state；validatePhases 会标红 + 禁用保存，用户自己修
    onUpdate({ ...item, name: trimmed });
  };

  return (
    <div
      className={cn(
        "rounded-lg border bg-card px-3 py-2.5 shadow-sm transition-colors",
        isHighlight && "border-primary/40 ring-1 ring-primary/20",
        dragHandlers.isDragging && "opacity-40",
        dragHandlers.isDropTarget && "border-primary ring-2 ring-primary",
      )}
      onMouseEnter={() => onHoverPhase?.(item.name)}
      onMouseLeave={() => onHoverPhase?.(null)}
      onDragOver={dragHandlers.onDragOver}
      onDragLeave={dragHandlers.onDragLeave}
      onDrop={dragHandlers.onDrop}
    >
      <div className="flex items-start gap-3">
        <IndexHandle label={idx + 1} dragHandlers={dragHandlers} />
        <div className="min-w-0 flex-1 space-y-2.5">
          <div>
            <Input
              type="text"
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onBlur={commitName}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              }}
              title={nameIssue?.message ?? "阶段名"}
              aria-invalid={!!nameIssue}
              className={cn(
                "h-8 max-w-xs font-mono text-sm",
                nameIssue && "border-destructive focus-visible:ring-destructive",
              )}
            />
            {nameIssue && (
              <p className="mt-1 text-xs text-destructive">{nameIssue.message}</p>
            )}
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">超时(秒)</Label>
              <Input
                type="number"
                min={1}
                value={item.timeout ?? ""}
                placeholder="900"
                onChange={(e) => {
                  const v = e.target.value;
                  onUpdate({
                    ...item,
                    timeout: v === "" ? undefined : Number(v),
                  });
                }}
                aria-invalid={!!timeoutIssue}
                className={cn(
                  "h-8 w-24 font-mono text-sm",
                  timeoutIssue &&
                    "border-destructive focus-visible:ring-destructive",
                )}
              />
              {timeoutIssue && (
                <p className="text-xs text-destructive">{timeoutIssue.message}</p>
              )}
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">驳回到</Label>
              <Select
                value={item.reject ?? "__none__"}
                onValueChange={(v) =>
                  onUpdate({ ...item, reject: v === "__none__" ? null : v })
                }
                disabled={rejectCandidates.length === 0}
              >
                <SelectTrigger
                  aria-invalid={!!rejectIssue}
                  className={cn(
                    "h-8 w-44 text-sm",
                    rejectIssue &&
                      "border-destructive focus-visible:ring-destructive",
                  )}
                >
                  <SelectValue placeholder="（不驳回）" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">（不驳回）</SelectItem>
                  {rejectCandidates.map((n) => (
                    <SelectItem key={n} value={n} className="font-mono">
                      {n}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {rejectIssue && (
                <p className="text-xs text-destructive">{rejectIssue.message}</p>
              )}
            </div>
            {parallelTargets.length > 0 && (
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">移入并行块</Label>
                <Select
                  value="__none__"
                  onValueChange={(v) => {
                    if (v !== "__none__") onMoveIntoParallel(parseInt(v, 10));
                  }}
                >
                  <SelectTrigger className="h-8 w-44 text-sm">
                    <SelectValue placeholder="（不移动）" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">（不移动）</SelectItem>
                    {parallelTargets.map((p) => (
                      <SelectItem
                        key={p.idx}
                        value={String(p.idx)}
                        className="font-mono"
                      >
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
        </div>
        <RowActions
          onMoveUp={onMoveUp}
          onMoveDown={onMoveDown}
          onDelete={onDelete}
          canUp={idx > 0}
          canDown={idx < total - 1}
        />
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────
// 行操作按钮（上移 / 下移 / 删除）
// ──────────────────────────────────────────────

function RowActions({
  onMoveUp,
  onMoveDown,
  onDelete,
  canUp,
  canDown,
  extras,
}: {
  onMoveUp: () => void;
  onMoveDown: () => void;
  onDelete: () => void;
  canUp: boolean;
  canDown: boolean;
  extras?: React.ReactNode;
}) {
  return (
    <div className="flex shrink-0 items-center gap-0.5">
      <Button
        size="icon"
        variant="ghost"
        className="size-7"
        title="上移"
        onClick={onMoveUp}
        disabled={!canUp}
      >
        <ArrowUp className="h-3.5 w-3.5" />
      </Button>
      <Button
        size="icon"
        variant="ghost"
        className="size-7"
        title="下移"
        onClick={onMoveDown}
        disabled={!canDown}
      >
        <ArrowDown className="h-3.5 w-3.5" />
      </Button>
      {extras}
      <Button
        size="icon"
        variant="ghost"
        className="size-7 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
        title="删除"
        onClick={onDelete}
      >
        <Trash2 className="h-3.5 w-3.5" />
      </Button>
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
  dragHandlers: DragHandlers;
  onReorderChild: (from: number, to: number) => void;
  dragOverChildState: { parallelIdx: number; childIdx: number } | null;
  dragSourceForParallel: {
    kind: "child";
    parallelIdx: number;
    childIdx: number;
  } | null;
  setChildDragSource: (
    src: { kind: "child"; parallelIdx: number; childIdx: number } | null,
  ) => void;
  setChildDragOver: (s: { parallelIdx: number; childIdx: number } | null) => void;
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
  const {
    item,
    idx,
    total,
    issues,
    hoveredPhase,
    onHoverPhase,
    dragHandlers,
    onReorderChild,
    dragOverChildState,
    dragSourceForParallel,
    setChildDragSource,
    setChildDragOver,
    onMoveUp,
    onMoveDown,
    onDelete,
    onUngroup,
    onUpdateStrategy,
    onUpdateName,
    onAddChild,
    onChildUpdate,
    onChildDelete,
    onChildMoveUp,
    onChildMoveDown,
    onChildLift,
  } = props;
  const headHighlight = hoveredPhase === item.name;
  const ownIssues = issuesForTop(issues, idx);
  const nameIssue = fieldIssue(ownIssues, "name");
  const strategyIssue = fieldIssue(ownIssues, "fail_strategy");
  const phasesIssue = fieldIssue(ownIssues, "phases");
  const [nameDraft, setNameDraft] = React.useState(item.name);
  React.useEffect(() => {
    setNameDraft(item.name);
  }, [item.name]);
  const commitName = () => {
    const trimmed = nameDraft.trim();
    if (trimmed === item.name) return;
    onUpdateName(trimmed);
  };

  return (
    <div
      className={cn(
        "rounded-lg border border-primary/30 bg-primary/5 px-3 py-2.5 shadow-sm transition-colors",
        headHighlight && "border-primary/60 ring-1 ring-primary/20",
        dragHandlers.isDragging && "opacity-40",
        dragHandlers.isDropTarget && "border-primary ring-2 ring-primary",
      )}
      onDragOver={dragHandlers.onDragOver}
      onDragLeave={dragHandlers.onDragLeave}
      onDrop={dragHandlers.onDrop}
    >
      <div
        className="flex items-start gap-3"
        onMouseEnter={() => onHoverPhase?.(item.name)}
        onMouseLeave={() => onHoverPhase?.(null)}
      >
        <IndexHandle label={idx + 1} dragHandlers={dragHandlers} />
        <div className="min-w-0 flex-1 space-y-2.5">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge
                variant="default"
                className="bg-primary/15 text-primary hover:bg-primary/20"
              >
                <Layers className="h-3 w-3" />
                并行
              </Badge>
              <Input
                type="text"
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                onBlur={commitName}
                onKeyDown={(e) => {
                  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                }}
                title={nameIssue?.message}
                aria-invalid={!!nameIssue}
                className={cn(
                  "h-8 max-w-xs font-mono text-sm",
                  nameIssue && "border-destructive focus-visible:ring-destructive",
                )}
              />
            </div>
            {nameIssue && (
              <p className="mt-1 text-xs text-destructive">{nameIssue.message}</p>
            )}
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">失败策略</Label>
              <Select
                value={item.fail_strategy ?? "cancel_all"}
                onValueChange={(v) => onUpdateStrategy(v)}
              >
                <SelectTrigger
                  aria-invalid={!!strategyIssue}
                  className={cn(
                    "h-8 w-36 text-sm",
                    strategyIssue &&
                      "border-destructive focus-visible:ring-destructive",
                  )}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STRATEGIES.map((s) => (
                    <SelectItem key={s} value={s} className="font-mono">
                      {s}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {strategyIssue && (
                <p className="text-xs text-destructive">{strategyIssue.message}</p>
              )}
            </div>
          </div>
          {phasesIssue && (
            <p className="text-xs text-destructive">{phasesIssue.message}</p>
          )}
        </div>
        <RowActions
          onMoveUp={onMoveUp}
          onMoveDown={onMoveDown}
          onDelete={onDelete}
          canUp={idx > 0}
          canDown={idx < total - 1}
          extras={
            <Button
              size="icon"
              variant="ghost"
              className="size-7"
              title="拆解为顺序阶段"
              onClick={onUngroup}
            >
              <Ungroup className="h-3.5 w-3.5" />
            </Button>
          }
        />
      </div>

      <div className="mt-3 flex flex-col gap-2 border-l-2 border-primary/30 pl-3">
        {item.phases.map((sub, j) => {
          const childDrag: DragHandlers = {
            draggable: true,
            isDragging: dragSourceForParallel?.childIdx === j,
            isDropTarget:
              dragOverChildState?.childIdx === j &&
              dragSourceForParallel !== null &&
              dragSourceForParallel.childIdx !== j,
            onDragStart: () =>
              setChildDragSource({
                kind: "child",
                parallelIdx: idx,
                childIdx: j,
              }),
            onDragOver: (e) => {
              if (!dragSourceForParallel) return;
              e.preventDefault();
              setChildDragOver({ parallelIdx: idx, childIdx: j });
            },
            onDragLeave: () => setChildDragOver(null),
            onDrop: (e) => {
              e.preventDefault();
              if (dragSourceForParallel)
                onReorderChild(dragSourceForParallel.childIdx, j);
              setChildDragSource(null);
              setChildDragOver(null);
            },
            onDragEnd: () => {
              setChildDragSource(null);
              setChildDragOver(null);
            },
          };
          return (
            <ParallelChildRow
              key={j}
              sub={sub}
              outerIdx={idx}
              innerIdx={j}
              total={item.phases.length}
              issues={issuesForChild(issues, idx, j)}
              isHighlight={hoveredPhase === sub.name}
              dragHandlers={childDrag}
              onHoverPhase={onHoverPhase}
              onUpdate={(next) => onChildUpdate(j, next)}
              onDelete={() => onChildDelete(j, sub.name)}
              onMoveUp={() => onChildMoveUp(j)}
              onMoveDown={() => onChildMoveDown(j)}
              onLift={() => onChildLift(j)}
            />
          );
        })}
        <Button
          size="sm"
          variant="ghost"
          className="self-start text-muted-foreground hover:text-foreground"
          onClick={onAddChild}
        >
          <Plus className="h-3.5 w-3.5" />
          添加子阶段
        </Button>
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
  dragHandlers: DragHandlers;
  onHoverPhase?: (name: string | null) => void;
  onUpdate: (next: PhaseItem) => void;
  onDelete: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onLift: () => void;
}

function ParallelChildRow({
  sub,
  outerIdx,
  innerIdx,
  total,
  issues,
  isHighlight,
  dragHandlers,
  onHoverPhase,
  onUpdate,
  onDelete,
  onMoveUp,
  onMoveDown,
  onLift,
}: ParallelChildRowProps) {
  const nameIssue = fieldIssue(issues, "name");
  const timeoutIssue = fieldIssue(issues, "timeout");
  const [nameDraft, setNameDraft] = React.useState(sub.name);
  React.useEffect(() => {
    setNameDraft(sub.name);
  }, [sub.name]);

  const commitName = () => {
    const trimmed = nameDraft.trim();
    if (trimmed === sub.name) return;
    onUpdate({ ...sub, name: trimmed });
  };

  return (
    <div
      className={cn(
        "rounded-md border bg-card px-2.5 py-2 shadow-sm transition-colors",
        isHighlight && "border-primary/40 ring-1 ring-primary/20",
        dragHandlers.isDragging && "opacity-40",
        dragHandlers.isDropTarget && "border-primary ring-2 ring-primary",
      )}
      onMouseEnter={() => onHoverPhase?.(sub.name)}
      onMouseLeave={() => onHoverPhase?.(null)}
      onDragOver={dragHandlers.onDragOver}
      onDragLeave={dragHandlers.onDragLeave}
      onDrop={dragHandlers.onDrop}
    >
      <div className="flex items-start gap-2.5">
        <IndexHandle
          label={`${outerIdx + 1}.${innerIdx + 1}`}
          size="sm"
          dragHandlers={dragHandlers}
        />
        <div className="min-w-0 flex-1 space-y-2">
          <div>
            <Input
              type="text"
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onBlur={commitName}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              }}
              title={nameIssue?.message}
              aria-invalid={!!nameIssue}
              className={cn(
                "h-8 max-w-xs font-mono text-sm",
                nameIssue && "border-destructive focus-visible:ring-destructive",
              )}
            />
            {nameIssue && (
              <p className="mt-1 text-xs text-destructive">{nameIssue.message}</p>
            )}
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">超时(秒)</Label>
              <Input
                type="number"
                min={1}
                value={sub.timeout ?? ""}
                placeholder="900"
                onChange={(e) => {
                  const v = e.target.value;
                  onUpdate({
                    ...sub,
                    timeout: v === "" ? undefined : Number(v),
                  });
                }}
                aria-invalid={!!timeoutIssue}
                className={cn(
                  "h-8 w-24 font-mono text-sm",
                  timeoutIssue &&
                    "border-destructive focus-visible:ring-destructive",
                )}
              />
              {timeoutIssue && (
                <p className="text-xs text-destructive">{timeoutIssue.message}</p>
              )}
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <Button
            size="icon"
            variant="ghost"
            className="size-7"
            title="块内上移"
            onClick={onMoveUp}
            disabled={innerIdx === 0}
          >
            <ArrowUp className="h-3.5 w-3.5" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="size-7"
            title="块内下移"
            onClick={onMoveDown}
            disabled={innerIdx === total - 1}
          >
            <ArrowDown className="h-3.5 w-3.5" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="size-7"
            title="移出到顶级"
            onClick={onLift}
          >
            <ArrowUpFromLine className="h-3.5 w-3.5" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="size-7 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
            title="删除子阶段"
            onClick={onDelete}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    </div>
  );
}
