import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Plus, Save, Trash2, ArrowLeft, ArrowRight, Play, Loader2, Layers, Ungroup, ArrowUpFromLine, ArrowDownToLine } from "lucide-react";
import { api, type InlineAgentConfig } from "@/hooks/useApi";
import { useToast } from "./Toast";
import { ConfirmDialog } from "./Modal";
import { AddPhaseDialog, type NewPhaseData } from "./AddPhaseDialog";
import { AddParallelDialog, type NewParallelData } from "./AddParallelDialog";
import { PhaseAgentEditor } from "./PhaseAgentEditor";
import { PhasePipeline } from "./PhasePipeline";

/** phase.agent 规整成内联配置对象；历史里 agent 曾是字符串名 → 视为无配置（走默认）。 */
function normalizeInlineAgent(raw: unknown): InlineAgentConfig | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const a = raw as Record<string, unknown>;
  const out: InlineAgentConfig = {};
  if (typeof a.provider === "string") out.provider = a.provider;
  if (typeof a.model === "string") out.model = a.model;
  if (typeof a.max_turns === "number") out.max_turns = a.max_turns;
  if (typeof a.permission_mode === "string") out.permission_mode = a.permission_mode;
  if (typeof a.system_prompt === "string") out.system_prompt = a.system_prompt;
  return out;
}
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { extractPhaseFunction } from "@/lib/ts-extract";
import { pickPhaseLabel, userPhaseLabel } from "@/lib/workflow-labels";

// ──────────────────────────────────────────────
// 流水线编辑器：流水线图 + 点击节点弹编辑 drawer + 新增/删除/保存
//
// 仅处理普通 phase 的编辑；并行块作为整体不动（图里仍渲染，但点子节点也走单 phase
// 编辑）。phase name 不可改（避免维护 ts 函数 rename 链路）；其它字段都能改。
// ──────────────────────────────────────────────

type PhaseRaw = Record<string, unknown>;

interface Props {
  workflowName: string;
  initialPhases: any[];
  /** workflow.ts 完整源码；drawer 里只读展示对应 phase 的函数片段 */
  tsSource?: string | null;
  /** 工作流详情数据需要刷新的时候触发 */
  onSaved?: () => void;
}

export function PhasePipelineEditor({
  workflowName,
  initialPhases,
  tsSource,
  onSaved,
}: Props) {
  const toast = useToast();
  const [phases, setPhases] = useState<any[]>(initialPhases);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [drawerPhase, setDrawerPhase] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [addParallelOpen, setAddParallelOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [pendingDeleteParallel, setPendingDeleteParallel] = useState<string | null>(null);
  const [hoveredPhase, setHoveredPhase] = useState<string | null>(null);

  // ── rename 追踪：保存时把 oldName→newName 一起传给后端，让 workflow.ts 里
  //   run_<old> 函数也一并 rename，避免产生孤儿 ──
  const renamesRef = useRef<Map<string, string>>(new Map());
  // 本次编辑会话内新建的阶段名（rename 时不必登记 renames，因为后端没有对应的 run_<old>）
  const newlyAddedRef = useRef<Set<string>>(new Set());

  const resetDraftTracking = useCallback(() => {
    renamesRef.current = new Map();
    newlyAddedRef.current = new Set();
  }, []);

  // initialPhases 变化（保存成功后父级 reload）时重置内部状态
  useEffect(() => {
    setPhases(initialPhases);
    setDirty(false);
    resetDraftTracking();
  }, [initialPhases, workflowName, resetDraftTracking]);

  // 离开页面 / 关闭窗口前提示：有未保存修改时弹原生 confirm
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // 现代浏览器忽略自定义文案，必须设置 returnValue 才会弹提示
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  // Ctrl+S / Cmd+S 保存修改
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        if (dirty && !saving) void saveRef.current?.();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dirty, saving]);
  // save 函数引用 — 给 keydown 闭包用，避免依赖整个 save 函数变更触发 listener 重绑
  const saveRef = useRef<(() => Promise<void>) | null>(null);

  /** 当前所有并行块的 name（drawer 移入并行块的下拉用） */
  const parallelBlockNames = useMemo(() => {
    const names: string[] = [];
    for (const p of phases) {
      if (p?.parallel?.name && typeof p.parallel.name === "string") {
        names.push(p.parallel.name);
      }
    }
    return names;
  }, [phases]);

  /** 顶层普通 phase（非并行块、非并行子节点）的 name 列表 — 给"移入到此并行块"下拉用 */
  const topLevelMovablePhaseNames = useMemo(() => {
    const names: string[] = [];
    for (const p of phases) {
      if (p && !p.parallel && typeof p.name === "string") {
        names.push(p.name);
      }
    }
    return names;
  }, [phases]);

  const allPhaseNames = useMemo(() => {
    const names: string[] = [];
    for (const p of phases) {
      if (!p || typeof p !== "object") continue;
      if ((p as PhaseRaw).parallel) {
        const par = (p as PhaseRaw).parallel as PhaseRaw;
        // 并行块自己也占用 name 命名空间
        if (typeof par.name === "string") names.push(par.name);
        const subs = Array.isArray(par.phases) ? (par.phases as PhaseRaw[]) : [];
        for (const s of subs) {
          if (typeof s.name === "string") names.push(s.name);
        }
      } else if (typeof (p as PhaseRaw).name === "string") {
        names.push((p as PhaseRaw).name as string);
      }
    }
    return names;
  }, [phases]);

  // 当前 drawer 选中阶段的 raw 对象引用 + 在 phases 树中的"路径"。三种情况：
  //   - top: 顶层普通 phase（最常见）
  //   - parallel-child: 并行块内的子 phase
  //   - parallel-block: 并行块"容器"本身（点击并行块 header 触发）
  const drawerPhaseLocation = useMemo(() => {
    if (!drawerPhase) return null;
    for (let i = 0; i < phases.length; i += 1) {
      const p = phases[i];
      if (!p) continue;
      if (p.parallel) {
        // 先看是不是点的并行块本身
        if (p.parallel.name === drawerPhase) {
          return { kind: "parallel-block" as const, idx: i, raw: p.parallel as PhaseRaw };
        }
        const subs: PhaseRaw[] = Array.isArray(p.parallel.phases) ? p.parallel.phases : [];
        for (let j = 0; j < subs.length; j += 1) {
          if (subs[j]?.name === drawerPhase) {
            return { kind: "parallel-child" as const, parallelIdx: i, subIdx: j, raw: subs[j] };
          }
        }
      } else if (p.name === drawerPhase) {
        return { kind: "top" as const, idx: i, raw: p as PhaseRaw };
      }
    }
    return null;
  }, [drawerPhase, phases]);

  const drawerTsCode = useMemo(() => {
    if (!drawerPhase || !tsSource) return null;
    return extractPhaseFunction(tsSource, drawerPhase);
  }, [drawerPhase, tsSource]);

  // ── 更新单个 phase 的某字段 ──
  function updatePhaseField(name: string, patch: Record<string, unknown>) {
    setPhases((prev) => {
      const next = prev.map((p) => {
        if (!p) return p;
        if (p.parallel) {
          const subs: PhaseRaw[] = Array.isArray(p.parallel.phases) ? p.parallel.phases : [];
          const updatedSubs = subs.map((s) =>
            s?.name === name ? { ...s, ...patch } : s,
          );
          return { ...p, parallel: { ...p.parallel, phases: updatedSubs } };
        }
        if (p.name === name) return { ...p, ...patch };
        return p;
      });
      return next;
    });
    setDirty(true);
  }

  // ── 并行块：新增 / 编辑属性 / 拆分（展开成顶层串行）/ 删除（连子节点） ──

  function handleAddParallel(data: NewParallelData) {
    setPhases((prev) => {
      const newBlock: PhaseRaw = {
        parallel: {
          name: data.name,
          fail_strategy: data.failStrategy,
          phases: data.children.map((c) => ({ name: c.name, timeout: c.timeout })),
        },
      };
      const next = [...prev];
      const insertAt = data.insertAfter + 1;
      next.splice(insertAt, 0, newBlock);
      return next;
    });
    // 所有子节点都是新建的；rename 时不必登记 renames
    for (const c of data.children) {
      newlyAddedRef.current.add(c.name);
    }
    setDirty(true);
    setAddParallelOpen(false);
    toast.success(
      `新增并行块 ${data.name}（${data.children.length} 个子阶段，未保存，点保存生效）`,
    );
  }

  function handleUpdateParallelField(blockName: string, patch: Record<string, unknown>) {
    setPhases((prev) =>
      prev.map((p) => {
        if (p?.parallel?.name === blockName) {
          return { ...p, parallel: { ...p.parallel, ...patch } };
        }
        return p;
      }),
    );
    setDirty(true);
  }

  /**
   * 拆分并行块：把它的所有子节点平铺到原位置，并删除并行容器本身。
   * 子节点保留 name / timeout / 其它字段，但失去"并行执行"语义（变为串行）。
   */
  function handleSplitParallel(blockName: string) {
    setPhases((prev) => {
      const next: any[] = [];
      let split = false;
      for (const p of prev) {
        if (!split && p?.parallel?.name === blockName) {
          const subs: PhaseRaw[] = Array.isArray(p.parallel.phases) ? p.parallel.phases : [];
          for (const s of subs) next.push({ ...s });
          split = true;
        } else {
          next.push(p);
        }
      }
      return next;
    });
    setDrawerPhase(null);
    setDirty(true);
    toast.success(`已拆分并行块 ${blockName}：子节点已平铺到顶层`);
  }

  /**
   * 在指定并行块里新增一个子阶段（drawer 编辑面板里直接添加）。
   * 校验 name 合法 + 全表唯一 + timeout 正整数；任何不通过都 toast 提示并保持当前状态。
   */
  function handleAddChildToParallel(parallelName: string, childName: string, timeout: number) {
    const trimmedName = childName.trim();
    if (!/^[a-z][a-z0-9_]*$/.test(trimmedName)) {
      toast.error("子阶段名非法", "需以小写字母开头，仅含 a-z 0-9 _");
      return;
    }
    if (allPhaseNames.includes(trimmedName)) {
      toast.error("名称已被占用", `${trimmedName} 在当前工作流里已存在`);
      return;
    }
    if (!Number.isFinite(timeout) || timeout <= 0) {
      toast.error("timeout 须为正整数", "");
      return;
    }
    let inserted = false;
    setPhases((prev) =>
      prev.map((p) => {
        if (p?.parallel?.name === parallelName) {
          inserted = true;
          const subs: PhaseRaw[] = Array.isArray(p.parallel.phases) ? p.parallel.phases : [];
          return {
            ...p,
            parallel: {
              ...p.parallel,
              phases: [...subs, { name: trimmedName, timeout }],
            },
          };
        }
        return p;
      }),
    );
    if (!inserted) {
      toast.error("找不到并行块", parallelName);
      return;
    }
    // 新建子节点登记 newlyAdded，rename 时不必登记 renames
    newlyAddedRef.current.add(trimmedName);
    setDirty(true);
    toast.success(`已在并行块 ${parallelName} 新增子阶段 ${trimmedName}（未保存，点保存生效）`);
  }

  /**
   * 把顶层普通 phase 移入指定并行块（作为它的最后一个子节点）。
   * 失败原因 — 该 phase 是并行块本身 / 不在顶层 / 目标并行块不存在 —
   * 都静默返回 prev，由调用方校验后再触发。
   */
  function handleMoveIntoParallel(phaseName: string, parallelName: string) {
    setPhases((prev) => {
      let extracted: PhaseRaw | null = null;
      const filtered: any[] = [];
      for (const p of prev) {
        if (p && !p.parallel && p.name === phaseName) {
          extracted = p as PhaseRaw;
        } else {
          filtered.push(p);
        }
      }
      if (!extracted) return prev;
      let found = false;
      const next = filtered.map((p) => {
        if (p?.parallel?.name === parallelName) {
          found = true;
          const subs: PhaseRaw[] = Array.isArray(p.parallel.phases) ? p.parallel.phases : [];
          // 子节点不再需要 reject（并行块内 reject 语义不适用），清掉
          const moved = { ...extracted! };
          delete (moved as Record<string, unknown>).reject;
          return { ...p, parallel: { ...p.parallel, phases: [...subs, moved] } };
        }
        return p;
      });
      if (!found) return prev;
      return next;
    });
    setDirty(true);
    toast.success(`已把 ${phaseName} 移入并行块 ${parallelName}`);
  }

  /**
   * 把并行块子节点移出，紧贴所属并行块之后插入到顶层。
   */
  function handleMoveOutOfParallel(phaseName: string) {
    setPhases((prev) => {
      let extracted: PhaseRaw | null = null;
      let parallelTopIdx = -1;
      const updated = prev.map((p, idx) => {
        if (extracted) return p;
        if (p?.parallel) {
          const subs: PhaseRaw[] = Array.isArray(p.parallel.phases) ? p.parallel.phases : [];
          const newSubs: PhaseRaw[] = [];
          for (const s of subs) {
            if (s?.name === phaseName && !extracted) {
              extracted = s;
              parallelTopIdx = idx;
            } else {
              newSubs.push(s);
            }
          }
          if (extracted) {
            return { ...p, parallel: { ...p.parallel, phases: newSubs } };
          }
        }
        return p;
      });
      if (!extracted || parallelTopIdx < 0) return prev;
      const next = [...updated];
      next.splice(parallelTopIdx + 1, 0, extracted);
      return next;
    });
    setDirty(true);
    toast.success(`已把 ${phaseName} 移出并行块`);
  }

  function handleDeleteParallel(blockName: string) {
    setPhases((prev) => {
      // 收集要被删的子节点名，顺手清掉指向它们的 reject
      const droppedNames = new Set<string>();
      const next: any[] = [];
      for (const p of prev) {
        if (p?.parallel?.name === blockName) {
          const subs: PhaseRaw[] = Array.isArray(p.parallel.phases) ? p.parallel.phases : [];
          for (const s of subs) {
            if (typeof s?.name === "string") droppedNames.add(s.name);
          }
          continue; // 跳过整个并行块
        }
        next.push(p);
      }
      // 清理 reject 指向被删除的子节点
      return next.map((p) => {
        if (!p) return p;
        if (p.parallel) {
          const subs: PhaseRaw[] = Array.isArray(p.parallel.phases) ? p.parallel.phases : [];
          const cleaned = subs.map((s) =>
            typeof s?.reject === "string" && droppedNames.has(s.reject) ? { ...s, reject: undefined } : s,
          );
          return { ...p, parallel: { ...p.parallel, phases: cleaned } };
        }
        if (typeof p.reject === "string" && droppedNames.has(p.reject)) {
          return { ...p, reject: undefined };
        }
        return p;
      });
    });
    // 清理 renames / newlyAdded 里相关条目
    const renames = renamesRef.current;
    for (const [k, v] of Array.from(renames.entries())) {
      if (v === blockName) renames.delete(k);
    }
    setDrawerPhase(null);
    setDirty(true);
    setPendingDeleteParallel(null);
    toast.success(`已删除并行块 ${blockName} 及其所有子阶段`);
  }

  // ── 新增阶段 ──
  function handleAddPhase(data: NewPhaseData) {
    setPhases((prev) => {
      const newPhase: PhaseRaw = { name: data.name, timeout: data.timeout };
      const next = [...prev];
      // insertAfter 是顶层索引；-1 表示插到最前
      const insertAt = data.insertAfter + 1;
      next.splice(insertAt, 0, newPhase);
      return next;
    });
    // 标记为新建：之后改名不必登记 renames
    newlyAddedRef.current.add(data.name);
    setDirty(true);
    setAddOpen(false);
    toast.success(`新增阶段 ${data.name}（未保存，点保存生效）`);
  }

  // ── 改名 ──
  // 单条调用：oldName → newName。失败时返回 false 让表单回滚输入。
  function handleRenamePhase(oldName: string, newName: string): boolean {
    if (oldName === newName) return true;
    if (!/^[a-z][a-z0-9_]*$/.test(newName)) {
      toast.error("名字不合法", "必须以小写字母开头，只允许 a-z 0-9 _");
      return false;
    }
    if (allPhaseNames.includes(newName)) {
      toast.error("名字重复", `已存在阶段 ${newName}`);
      return false;
    }

    // 维护 renames 映射；新建阶段直接换名不进 renames
    const newlyAdded = newlyAddedRef.current;
    if (newlyAdded.has(oldName)) {
      newlyAdded.delete(oldName);
      newlyAdded.add(newName);
    } else {
      const renames = renamesRef.current;
      // 链式：source → oldName → newName 折叠成 source → newName
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

    // 更新 phases：phase.name + 所有指向旧名的 reject
    setPhases((prev) =>
      prev.map((p) => {
        if (!p) return p;
        if (p.parallel) {
          const subs: PhaseRaw[] = Array.isArray(p.parallel.phases) ? p.parallel.phases : [];
          const updated = subs.map((s) => {
            if (s?.name === oldName) return { ...s, name: newName };
            if (s?.reject === oldName) return { ...s, reject: newName };
            return s;
          });
          return { ...p, parallel: { ...p.parallel, phases: updated } };
        }
        if (p.name === oldName) return { ...p, name: newName };
        if (p.reject === oldName) return { ...p, reject: newName };
        return p;
      }),
    );

    // drawer 当前指向的就是被改名的 phase，更新引用
    setDrawerPhase((cur) => (cur === oldName ? newName : cur));
    setDirty(true);
    return true;
  }

  // ── 删除阶段 ──
  // ── 重排：把名为 name 的阶段在顶层往左/右移一格 ──
  // 普通 phase 和并行块本身都视为顶层条目可移；并行块内子项不在此换序
  function handleMovePhase(name: string, dir: "left" | "right") {
    setPhases((prev) => {
      let topIdx = -1;
      let isParallelChild = false;
      for (let i = 0; i < prev.length; i += 1) {
        const p = prev[i];
        if (!p) continue;
        if (p.parallel) {
          // 并行块本身
          if (p.parallel.name === name) {
            topIdx = i;
            break;
          }
          const subs: PhaseRaw[] = Array.isArray(p.parallel.phases) ? p.parallel.phases : [];
          if (subs.some((s) => s?.name === name)) {
            isParallelChild = true;
            topIdx = i;
            break;
          }
        } else if (p.name === name) {
          topIdx = i;
          break;
        }
      }
      if (topIdx < 0 || isParallelChild) return prev; // 子项不动
      const target = dir === "left" ? topIdx - 1 : topIdx + 1;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      [next[topIdx], next[target]] = [next[target], next[topIdx]];
      return next;
    });
    setDirty(true);
  }

  // 当前 drawer 阶段在顶层的位置；用于禁用左右移按钮
  // 三种情况：并行块容器 / 普通顶层 phase 都能移；并行子项不能在此移
  const drawerTopIdx = useMemo(() => {
    if (!drawerPhase) return { idx: -1, total: phases.length, isParallelChild: false };
    for (let i = 0; i < phases.length; i += 1) {
      const p = phases[i];
      if (!p) continue;
      if (p.parallel) {
        if (p.parallel.name === drawerPhase) {
          // 并行块本身 → 可作为顶层条目重排
          return { idx: i, total: phases.length, isParallelChild: false };
        }
        const subs: PhaseRaw[] = Array.isArray(p.parallel.phases) ? p.parallel.phases : [];
        if (subs.some((s) => s?.name === drawerPhase)) {
          return { idx: i, total: phases.length, isParallelChild: true };
        }
      } else if (p.name === drawerPhase) {
        return { idx: i, total: phases.length, isParallelChild: false };
      }
    }
    return { idx: -1, total: phases.length, isParallelChild: false };
  }, [drawerPhase, phases]);

  function handleDeletePhase(name: string) {
    // 清理 renames：若被删的 name 是某条改名的目标，撤销该条；新建后又删除的 name 也清掉
    newlyAddedRef.current.delete(name);
    const renames = renamesRef.current;
    for (const [k, v] of Array.from(renames.entries())) {
      if (v === name) renames.delete(k);
    }
    setPhases((prev) => {
      const next: any[] = [];
      for (const p of prev) {
        if (!p) continue;
        if (p.parallel) {
          const subs: PhaseRaw[] = Array.isArray(p.parallel.phases) ? p.parallel.phases : [];
          const filtered = subs.filter((s) => s?.name !== name);
          // 空并行块也保留（用户删完子项可能还要重加），下次保存校验
          next.push({ ...p, parallel: { ...p.parallel, phases: filtered } });
        } else if (p.name !== name) {
          next.push(p);
        }
      }
      // 顺手清空指向被删阶段的 reject
      return next.map((p) => {
        if (p?.parallel) {
          const subs: PhaseRaw[] = Array.isArray(p.parallel.phases) ? p.parallel.phases : [];
          const cleaned = subs.map((s) =>
            s?.reject === name ? { ...s, reject: undefined } : s,
          );
          return { ...p, parallel: { ...p.parallel, phases: cleaned } };
        }
        if (p?.reject === name) return { ...p, reject: undefined };
        return p;
      });
    });
    setDirty(true);
    setDrawerPhase(null);
    setPendingDelete(null);
  }

  // ── 保存 ──
  async function save() {
    if (!dirty || saving) return;
    setSaving(true);
    try {
      // 只发"目标 newName 仍存在"的 rename（用户可能删过中间产物）
      const currentNames = new Set(allPhaseNames);
      const validRenames: Record<string, string> = {};
      for (const [oldName, newName] of renamesRef.current.entries()) {
        if (currentNames.has(newName)) validRenames[oldName] = newName;
      }
      const renamesToSend =
        Object.keys(validRenames).length > 0 ? validRenames : undefined;

      const res = await api.setWorkflowPhases(workflowName, phases, true, renamesToSend);
      setDirty(false);
      resetDraftTracking();
      const ts = res.ts;
      const renamed = res.renamed ?? [];
      const parts: string[] = [];
      if (renamed.length > 0) parts.push(`已改名 ${renamed.length} 个函数：${renamed.join(", ")}`);
      if (ts?.added?.length) parts.push(`新增 ${ts.added.length} 个函数：${ts.added.join(", ")}`);
      if (ts?.orphans?.length) parts.push(`检测到 ${ts.orphans.length} 个孤儿函数（手工清理或下次保存自动同步）`);
      if (res.ts_error) parts.push(`ts 同步警告：${res.ts_error}`);
      toast.success(parts.length > 0 ? `已保存 · ${parts.join("；")}` : "已保存");
      onSaved?.();
    } catch (e: unknown) {
      toast.error("保存失败", (e as Error)?.message ?? String(e));
    } finally {
      setSaving(false);
    }
  }
  // 暴露 save 给键盘快捷键闭包；每次渲染都更新
  saveRef.current = save;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
          流水线编辑 · 点击节点编辑
          {dirty && <span className="ml-2 text-warning">· 未保存（{navigator.platform.toLowerCase().includes("mac") ? "⌘" : "Ctrl"}+S 快捷保存）</span>}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setAddOpen(true)}>
            <Plus className="h-4 w-4" />
            新增阶段
          </Button>
          <Button variant="outline" size="sm" onClick={() => setAddParallelOpen(true)}>
            <Layers className="h-4 w-4" />
            新增并行块
          </Button>
          <Button size="sm" onClick={save} disabled={!dirty || saving} title="保存修改（Ctrl/Cmd+S）">
            <Save className="h-4 w-4" />
            {saving ? "保存中…" : "保存修改"}
          </Button>
        </div>
      </div>

      <PhasePipeline
        phases={phases}
        highlight={hoveredPhase}
        onHoverPhase={setHoveredPhase}
        onPhaseClick={setDrawerPhase}
      />

      {/* 编辑 drawer */}
      <Sheet open={!!drawerPhase} onOpenChange={(o) => { if (!o) setDrawerPhase(null); }}>
        <SheetContent side="right" className="w-full max-w-md overflow-y-auto sm:max-w-md">
          {drawerPhaseLocation && (() => {
            const phaseName = String(drawerPhaseLocation.raw.name ?? "");
            const rawLabel = typeof drawerPhaseLocation.raw.label === "string"
              ? drawerPhaseLocation.raw.label
              : null;
            const displayName = pickPhaseLabel({ name: phaseName, label: rawLabel });
            return (
            <>
              <SheetHeader>
                <SheetTitle className="flex items-baseline gap-2">
                  <span className="truncate">{displayName}</span>
                  {displayName !== phaseName && (
                    <code className="font-mono text-[11px] text-muted-foreground">{phaseName}</code>
                  )}
                </SheetTitle>
                <SheetDescription>
                  改完点底部「保存修改」生效；改完未保存时关闭只是暂存到表单
                </SheetDescription>
              </SheetHeader>

              {drawerPhaseLocation.kind === "parallel-block" ? (
                <ParallelBlockEditForm
                  raw={drawerPhaseLocation.raw}
                  allPhaseNames={allPhaseNames.filter((n) => n !== phaseName)}
                  movableTopPhases={topLevelMovablePhaseNames}
                  onChange={(patch) => handleUpdateParallelField(phaseName, patch)}
                  onMoveChildIn={(name) => handleMoveIntoParallel(name, phaseName)}
                  onMoveChildOut={(name) => handleMoveOutOfParallel(name)}
                  onAddChild={(name, timeout) => handleAddChildToParallel(phaseName, name, timeout)}
                />
              ) : (
                <>
                  <PhaseEditForm
                    raw={drawerPhaseLocation.raw}
                    workflowName={workflowName}
                    allPhaseNames={allPhaseNames}
                    isTopLevel={drawerPhaseLocation.kind === "top"}
                    parallelBlockNames={parallelBlockNames}
                    onChange={(patch) => updatePhaseField(phaseName, patch)}
                    onRename={(oldName, newName) => handleRenamePhase(oldName, newName)}
                    onMoveIntoParallel={(parName) => handleMoveIntoParallel(phaseName, parName)}
                    onMoveOutOfParallel={() => handleMoveOutOfParallel(phaseName)}
                  />

                  <PhaseTsEditor
                    workflowName={workflowName}
                    phaseName={phaseName}
                    initialCode={drawerTsCode}
                    hasPrompt={typeof drawerPhaseLocation.raw.prompt === "string" && (drawerPhaseLocation.raw.prompt as string).trim() !== ""}
                    onSaved={() => onSaved?.()}
                  />
                </>
              )}

              {/* 位置调整：顶层 phase / 并行块本身支持；并行块内子项不能在此调换 */}
              {!drawerTopIdx.isParallelChild && (
                <section className="mt-4">
                  <div className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                    位置
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleMovePhase(phaseName, "left")}
                      disabled={drawerTopIdx.idx <= 0}
                    >
                      <ArrowLeft className="h-4 w-4" />
                      左移
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleMovePhase(phaseName, "right")}
                      disabled={drawerTopIdx.idx < 0 || drawerTopIdx.idx >= drawerTopIdx.total - 1}
                    >
                      <ArrowRight className="h-4 w-4" />
                      右移
                    </Button>
                    <span className="font-mono text-[10px] text-muted-foreground">
                      第 {drawerTopIdx.idx + 1} / {drawerTopIdx.total} 个
                    </span>
                  </div>
                </section>
              )}
              {drawerTopIdx.isParallelChild && (
                <section className="mt-4">
                  <p className="text-[11px] text-muted-foreground">
                    并行块内的子阶段顺序对执行无影响（并行执行），故不提供排序
                  </p>
                </section>
              )}

              <SheetFooter>
                {drawerPhaseLocation.kind === "parallel-block" ? (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleSplitParallel(phaseName)}
                      title="把并行块的子节点平铺到顶层并删除并行容器（变为串行执行）"
                    >
                      <Ungroup className="h-4 w-4" />
                      拆分（变串行）
                    </Button>
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => setPendingDeleteParallel(phaseName)}
                    >
                      <Trash2 className="h-4 w-4" />
                      删除并行块
                    </Button>
                  </>
                ) : (
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => setPendingDelete(phaseName)}
                  >
                    <Trash2 className="h-4 w-4" />
                    删除阶段
                  </Button>
                )}
                <Button
                  size="sm"
                  onClick={() => {
                    setDrawerPhase(null);
                    if (dirty) void save();
                  }}
                  disabled={saving}
                >
                  <Save className="h-4 w-4" />
                  {dirty ? "保存并关闭" : "关闭"}
                </Button>
              </SheetFooter>
            </>
            );
          })()}
        </SheetContent>
      </Sheet>

      <AddPhaseDialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onConfirm={handleAddPhase}
        existingNames={allPhaseNames}
        count={phases.length}
      />

      <AddParallelDialog
        open={addParallelOpen}
        onClose={() => setAddParallelOpen(false)}
        onConfirm={handleAddParallel}
        existingNames={allPhaseNames}
        topCount={phases.length}
        topLabels={phases.map((p) =>
          p?.parallel ? `[并行] ${p.parallel.name}` : String(p?.name ?? "?"),
        )}
      />

      <ConfirmDialog
        open={!!pendingDelete}
        title="删除阶段"
        message={
          <p>
            确认删除阶段 <code className="rounded bg-muted px-1 font-mono">{pendingDelete}</code>？
            其它阶段指向它的 reject 会被一并清空。删除后需点「保存修改」生效。
          </p>
        }
        confirmText="删除"
        danger
        onConfirm={() => { if (pendingDelete) handleDeletePhase(pendingDelete); }}
        onCancel={() => setPendingDelete(null)}
      />

      <ConfirmDialog
        open={!!pendingDeleteParallel}
        title="删除并行块"
        message={
          <div className="space-y-2">
            <p>
              确认删除并行块 <code className="rounded bg-muted px-1 font-mono">{pendingDeleteParallel}</code>？
            </p>
            <p className="text-xs text-muted-foreground">
              并行块内的所有子阶段会一同删除；其它阶段指向它们的 reject 也会清空。
              如想保留子阶段、只解散并行容器，请用「拆分（变串行）」。
            </p>
          </div>
        }
        confirmText="删除并行块"
        danger
        onConfirm={() => { if (pendingDeleteParallel) handleDeleteParallel(pendingDeleteParallel); }}
        onCancel={() => setPendingDeleteParallel(null)}
      />
    </div>
  );
}

// ──────────────────────────────────────────────
// 子组件：并行块 drawer 编辑表单
// ──────────────────────────────────────────────

function ParallelBlockEditForm({
  raw,
  allPhaseNames,
  movableTopPhases,
  onChange,
  onMoveChildIn,
  onMoveChildOut,
  onAddChild,
}: {
  raw: PhaseRaw;
  /** 已存在的名字（用于重名检测），不含当前并行块自己 */
  allPhaseNames: string[];
  /** 顶层普通 phase 名（可移入此并行块） */
  movableTopPhases: string[];
  onChange: (patch: Record<string, unknown>) => void;
  /** 把顶层 phase 移入此并行块 */
  onMoveChildIn: (phaseName: string) => void;
  /** 把子节点移出回顶层 */
  onMoveChildOut: (phaseName: string) => void;
  /** 凭空新增一个子阶段 */
  onAddChild: (name: string, timeout: number) => void;
}) {
  const blockName = String(raw.name ?? "");
  const failStrategy = (raw.fail_strategy as string | undefined) || "cancel_all";

  // label 输入：用户填的优先；registry 兜底的 name.toUpperCase() 视作"未填"
  const rawLabel = typeof raw.label === "string" ? raw.label : null;
  const realLabel = userPhaseLabel({ name: blockName, label: rawLabel }) ?? "";

  // name 改名：parallel 块的 name 仅作状态机分叉节点，不绑 ts 函数，简化为 onBlur 提交
  const [nameDraft, setNameDraft] = useState(blockName);
  useEffect(() => { setNameDraft(blockName); }, [blockName]);

  function commitName() {
    const trimmed = nameDraft.trim();
    if (trimmed === blockName) return;
    if (!/^[a-z][a-z0-9_]*$/.test(trimmed)) {
      setNameDraft(blockName);
      return;
    }
    if (allPhaseNames.includes(trimmed)) {
      setNameDraft(blockName);
      return;
    }
    onChange({ name: trimmed });
  }

  const subs = Array.isArray(raw.phases) ? (raw.phases as PhaseRaw[]) : [];

  return (
    <div className="space-y-3 pt-3">
      <FormRow label="显示名 (label)">
        <Input
          value={realLabel}
          placeholder={`留空则显示 ${blockName}`}
          onChange={(e) => onChange({ label: e.target.value || undefined })}
          className="h-8 text-sm"
        />
      </FormRow>

      <FormRow label="标识符 (name)">
        <Input
          value={nameDraft}
          onChange={(e) => setNameDraft(e.target.value)}
          onBlur={commitName}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); commitName(); (e.target as HTMLInputElement).blur(); }
            else if (e.key === "Escape") { setNameDraft(blockName); (e.target as HTMLInputElement).blur(); }
          }}
          placeholder="小写字母开头，a-z 0-9 _"
          className="h-8 font-mono text-sm"
        />
        <p className="mt-1 text-[10px] text-muted-foreground">
          作为状态机分叉节点名；并行块不关联 ts 函数，改名无副作用
        </p>
      </FormRow>

      <FormRow label="失败策略 (fail_strategy)">
        <Select
          value={failStrategy}
          onValueChange={(v) => onChange({ fail_strategy: v })}
        >
          <SelectTrigger className="h-8 text-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="cancel_all">cancel_all · 任一子失败 → 全部取消</SelectItem>
            <SelectItem value="continue">continue · 任一子失败 → 其它继续</SelectItem>
          </SelectContent>
        </Select>
      </FormRow>

      <section>
        <div className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
          包含的子阶段（{subs.length}）
        </div>
        <ul className="space-y-1 border-[1.5px] border-foreground/20 bg-muted/30 p-2">
          {subs.length === 0 ? (
            <li className="font-mono text-[10px] text-muted-foreground">（空）</li>
          ) : (
            subs.map((s, i) => {
              const childName = String(s?.name ?? "");
              return (
                <li key={i} className="flex items-center justify-between gap-2 font-mono text-[11px]">
                  <span className="min-w-0 flex-1 truncate">
                    <code>{childName}</code>
                    {typeof s?.timeout === "number" && (
                      <span className="ml-2 text-muted-foreground">timeout: {s.timeout}s</span>
                    )}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onMoveChildOut(childName)}
                    title="移出回顶层"
                    className="h-6 px-1.5"
                  >
                    <ArrowUpFromLine className="h-3 w-3" />
                    移出
                  </Button>
                </li>
              );
            })
          )}
        </ul>
        <p className="mt-1 text-[10px] text-muted-foreground">
          点击流水线图里的子节点可单独编辑；点旁边「移出」把子节点平铺回顶层
        </p>
      </section>

      <ParallelChildAdder onAdd={onAddChild} />

      {movableTopPhases.length > 0 && (
        <section>
          <div className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
            或：移入已有的顶层阶段
          </div>
          <Select
            value="__none__"
            onValueChange={(v) => { if (v !== "__none__") onMoveChildIn(v); }}
          >
            <SelectTrigger className="h-8 text-sm">
              <SelectValue placeholder="选一个顶层 phase 移入" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">（取消）</SelectItem>
              {movableTopPhases.map((n) => (
                <SelectItem key={n} value={n} className="font-mono">
                  <ArrowDownToLine className="mr-1 inline h-3 w-3" />
                  {n}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="mt-1 text-[10px] text-muted-foreground">
            选中的顶层 phase 会成为本并行块的最后一个子节点
          </p>
        </section>
      )}
    </div>
  );
}

/**
 * 并行块 drawer 内的"新增子阶段"内联表单：name + timeout + 添加按钮。
 * 校验失败的 toast 由调用方在 onAdd 内处理（统一在 handler 报错）。
 */
function ParallelChildAdder({ onAdd }: { onAdd: (name: string, timeout: number) => void }) {
  const [name, setName] = useState("");
  const [timeout, setTimeoutSec] = useState(900);

  function commit() {
    if (!name.trim()) return;
    onAdd(name.trim(), timeout);
    // 成功的话父级会触发重渲染（subs 数组变长），这里仅清表单
    setName("");
    setTimeoutSec(900);
  }

  return (
    <section>
      <div className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
        新增子阶段
      </div>
      <div className="flex items-center gap-2">
        <Input
          placeholder="子阶段名"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commit(); } }}
          className="h-8 flex-1 font-mono text-sm"
        />
        <Input
          type="number"
          min={1}
          placeholder="900"
          value={timeout}
          onChange={(e) => setTimeoutSec(parseInt(e.target.value, 10) || 0)}
          className="h-8 w-24 font-mono text-sm"
        />
        <Button
          variant="outline"
          size="sm"
          onClick={commit}
          disabled={!name.trim()}
          className="h-8"
        >
          <Plus className="h-3.5 w-3.5" />
          添加
        </Button>
      </div>
      <p className="mt-1 text-[10px] text-muted-foreground">
        新建空子阶段（无 ts / prompt）；添加后点击流水线节点配 prompt 或 ts 函数
      </p>
    </section>
  );
}

// ──────────────────────────────────────────────
// 表单：drawer 内单阶段字段编辑
// ──────────────────────────────────────────────
// 子组件：prompt 试跑器
//
// 让用户填完 prompt 后无需创建 task 就能看 agent 输出。
// 仅替换 ${VAR} 中真实存在的内置变量（TASK_TITLE/REQUIREMENT/... 这些任务上下文
// dry-run 时没有真值，保留占位让用户自己改）；后端用临时调用，不写 workspace。
// ──────────────────────────────────────────────

function PromptDryRunner({
  workflowName,
  agent,
  prompt,
}: {
  workflowName: string;
  /** phase 内联 agent 配置；undefined → 后端走 DEFAULT_AGENT 兜底 */
  agent: InlineAgentConfig | undefined;
  prompt: string;
}) {
  const toast = useToast();
  const [running, setRunning] = useState(false);
  const [output, setOutput] = useState<string | null>(null);
  const [durationMs, setDurationMs] = useState<number | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const agentLabel = agent?.model || agent?.provider || "默认 agent";

  async function dryRun() {
    setRunning(true);
    setOutput(null);
    setDurationMs(null);
    setErrorMsg(null);
    try {
      const r = await api.dryRunPrompt(workflowName, { agent, prompt, timeout: 120 });
      setOutput(r.text);
      setDurationMs(r.durationMs);
    } catch (e: unknown) {
      const msg = (e as Error)?.message ?? String(e);
      setErrorMsg(msg);
      toast.error("试跑失败", msg);
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="mt-2 border-[1.5px] border-dashed border-foreground/30 bg-muted/20 p-2">
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
          试跑 · 用当前 prompt 直接调一次 {agentLabel}
        </span>
        <Button
          variant="outline"
          size="sm"
          onClick={dryRun}
          disabled={running || !prompt.trim()}
          className="h-7 px-2"
        >
          {running ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
          {running ? "调用中…" : "试跑"}
        </Button>
      </div>
      <p className="mt-1 text-[10px] text-muted-foreground">
        变量占位符（${'$'}{'{REQUIREMENT}'} 等）原样发送给 agent，调试时建议先手动替换成真实测试值
      </p>
      {(output !== null || errorMsg !== null) && (
        <div className="mt-2">
          {durationMs !== null && (
            <div className="mb-1 font-mono text-[10px] text-muted-foreground">
              耗时 {(durationMs / 1000).toFixed(1)}s
            </div>
          )}
          {errorMsg !== null ? (
            <pre className="scrollbar-thin max-h-48 overflow-auto whitespace-pre-wrap border-[1.5px] border-destructive bg-destructive/8 p-2 font-mono text-[10px] leading-relaxed text-destructive">
              {errorMsg}
            </pre>
          ) : (
            <pre className="scrollbar-thin max-h-48 overflow-auto whitespace-pre-wrap border-[1.5px] border-foreground/30 bg-card p-2 font-mono text-[10px] leading-relaxed">
              {output}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────
// 子组件：ts 函数代码编辑器（独立草稿 + 应用按钮）
// ──────────────────────────────────────────────

function PhaseTsEditor({
  workflowName,
  phaseName,
  initialCode,
  hasPrompt,
  onSaved,
}: {
  workflowName: string;
  phaseName: string;
  initialCode: string | null;
  /** 该 phase 在 yaml 里有 prompt 字段：用于显示"prompt 驱动 vs ts 函数"优先级提示 */
  hasPrompt?: boolean;
  onSaved?: () => void;
}) {
  const toast = useToast();
  const [draft, setDraft] = useState(initialCode ?? "");
  const [saving, setSaving] = useState(false);

  // initialCode 变化时（外部 reload ts、切换 phase）重置草稿
  useEffect(() => { setDraft(initialCode ?? ""); }, [initialCode, phaseName]);

  const dirty = draft.trim() !== (initialCode ?? "").trim();
  const empty = draft.trim() === "";

  async function apply() {
    setSaving(true);
    try {
      const r = await api.setWorkflowPhaseFn(workflowName, phaseName, draft);
      toast.success(r.mode === "appended" ? "已新增函数到 workflow.ts" : "已更新 workflow.ts");
      onSaved?.();
    } catch (e: unknown) {
      toast.error("写入 ts 失败", (e as Error)?.message ?? String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="mt-4">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
          执行函数 · workflow.ts
          {dirty && <span className="ml-2 text-warning">· 未保存</span>}
        </span>
        <Button
          variant="outline"
          size="sm"
          onClick={apply}
          disabled={saving || !dirty || empty}
          className="h-7 px-2"
        >
          <Save className="h-3 w-3" />
          {saving ? "写入中…" : "应用代码"}
        </Button>
      </div>
      {hasPrompt && initialCode === null && (
        <p className="mb-1 border-[1.5px] border-dashed border-success/40 bg-success/5 p-2 text-[11px] text-success">
          该阶段由 prompt 驱动（yaml 里有 prompt 字段），框架自动调 agent.run；无需 ts 函数
        </p>
      )}
      {hasPrompt && initialCode !== null && (
        <p className="mb-1 border-[1.5px] border-dashed border-warning/40 bg-warning/5 p-2 text-[11px] text-warning">
          该阶段同时有 prompt 字段和 ts 函数；框架会优先调用 ts 函数（prompt 字段被忽略）
        </p>
      )}
      {!hasPrompt && initialCode === null && draft === "" && (
        <p className="mb-1 border-[1.5px] border-dashed border-foreground/30 bg-muted/30 p-2 text-[11px] text-muted-foreground">
          未找到 <code className="font-mono">run_{phaseName}</code> 函数；上面填 prompt 即可零代码运行，或在下方编写完整 ts 函数
        </p>
      )}
      <Textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder={`export async function run_${phaseName}(taskId: string): Promise<void> {\n  // TODO\n}`}
        className="scrollbar-thin h-56 resize-none border-[1.5px] border-foreground/30 bg-card p-3 font-mono text-[11px] leading-relaxed"
        spellCheck={false}
        disabled={saving}
      />
      <p className="mt-1 text-[10px] text-muted-foreground">
        必须以 <code className="font-mono">export async function run_{phaseName}(</code> 开头；应用前会自动备份原 ts 为 .bak
      </p>
    </section>
  );
}

// ──────────────────────────────────────────────

function PhaseEditForm({
  raw,
  workflowName,
  allPhaseNames,
  isTopLevel,
  parallelBlockNames,
  onChange,
  onRename,
  onMoveIntoParallel,
  onMoveOutOfParallel,
}: {
  raw: PhaseRaw;
  workflowName: string;
  allPhaseNames: string[];
  /** true 表示当前 phase 在顶层（顶层时可"移入并行块"；并行子项时可"移出"） */
  isTopLevel: boolean;
  /** 现有并行块名列表（顶层 phase 用） */
  parallelBlockNames: string[];
  onChange: (patch: Record<string, unknown>) => void;
  /** 改名提交；返回 false 则恢复输入框为原 name */
  onRename: (oldName: string, newName: string) => boolean;
  onMoveIntoParallel: (parallelName: string) => void;
  onMoveOutOfParallel: () => void;
}) {
  // 排除自己
  const rejectCandidates = allPhaseNames.filter((n) => n !== raw.name);
  const phaseName = String(raw.name ?? "");

  // 本地缓存 name 输入：用户改完 onBlur 才提交 rename
  const [nameDraft, setNameDraft] = useState(phaseName);
  useEffect(() => { setNameDraft(phaseName); }, [phaseName]);

  // raw.label 可能是 registry 兜底填的 name.toUpperCase()，那不是用户真填的，
  // 输入框要显示空让用户感知"还没设中文名"
  const rawLabel = typeof raw.label === "string" ? raw.label : null;
  const realLabel = userPhaseLabel({ name: phaseName, label: rawLabel }) ?? "";

  function commitName() {
    const trimmed = nameDraft.trim();
    if (trimmed === phaseName) return;
    if (trimmed === "") {
      setNameDraft(phaseName);
      return;
    }
    if (!onRename(phaseName, trimmed)) {
      setNameDraft(phaseName); // 校验失败回滚
    }
  }

  return (
    <div className="space-y-3 pt-3">
      <div className="grid grid-cols-1 gap-2">
        <FormRow label="显示名 (label)">
          <Input
            value={realLabel}
            placeholder={`留空则显示 ${phaseName}`}
            onChange={(e) => onChange({ label: e.target.value || undefined })}
            className="h-8 text-sm"
          />
          <p className="mt-1 text-[10px] text-muted-foreground">
            填中文显示名（如"数据入库"）；不填则节点显示标识符
          </p>
        </FormRow>

        <FormRow label="标识符 (name)">
          <Input
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitName();
                (e.target as HTMLInputElement).blur();
              } else if (e.key === "Escape") {
                setNameDraft(phaseName);
                (e.target as HTMLInputElement).blur();
              }
            }}
            placeholder="小写字母开头，a-z 0-9 _"
            className="h-8 font-mono text-sm"
          />
          <p className="mt-1 text-[10px] text-muted-foreground">
            标识符联动 workflow.ts 里的函数名；改名后保存时框架自动 rename run_xxx 函数
          </p>
        </FormRow>

        <FormRow label="超时 (秒)">
          <Input
            type="number"
            min={1}
            value={typeof raw.timeout === "number" ? raw.timeout : ""}
            placeholder="900"
            onChange={(e) => {
              const v = e.target.value;
              onChange({ timeout: v === "" ? undefined : Number(v) });
            }}
            className="h-8 w-32 font-mono text-sm"
          />
        </FormRow>

        <FormRow label="提示词 (prompt)">
          <Textarea
            value={typeof raw.prompt === "string" ? raw.prompt : ""}
            placeholder={`填了 prompt 就不需要写 ts 函数；可用变量：\${TASK_TITLE} \${REQUIREMENT} \${WORKSPACE} \${PHASE}\n例：你是一位资深工程师。请根据 \${REQUIREMENT} 输出方案。`}
            onChange={(e) => onChange({ prompt: e.target.value || undefined })}
            className="min-h-[100px] resize-y font-mono text-[11px] leading-relaxed"
            spellCheck={false}
          />
          <p className="mt-1 text-[10px] text-muted-foreground">
            yaml 写 prompt → 框架自动调用 phase 内联 agent（或默认 agent）.run(prompt)，无需写 ts 函数；
            适合简单的"调 agent 跑一段 prompt"场景，复杂分支（reject / 解析返回）仍需 ts
          </p>
          {typeof raw.prompt === "string" && raw.prompt.trim() && (
            <PromptDryRunner
              workflowName={workflowName}
              agent={normalizeInlineAgent(raw.agent)}
              prompt={raw.prompt}
            />
          )}
        </FormRow>

        <PhaseAgentEditor
          phaseName={phaseName}
          agent={normalizeInlineAgent(raw.agent)}
          onChange={(next) => onChange({ agent: next })}
        />

        <FormRow label="驳回到">
          <Select
            value={(raw.reject as string | undefined) || "__none__"}
            onValueChange={(v) => onChange({ reject: v === "__none__" ? undefined : v })}
            disabled={rejectCandidates.length === 0}
          >
            <SelectTrigger className="h-8 text-sm">
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
        </FormRow>

        {typeof raw.reject === "string" && raw.reject !== "" && (
          <FormRow label="最大驳回次数">
            <Input
              type="number"
              min={1}
              value={typeof raw.max_rejections === "number" ? raw.max_rejections : ""}
              placeholder="10"
              onChange={(e) => {
                const v = e.target.value;
                onChange({ max_rejections: v === "" ? undefined : Number(v) });
              }}
              className="h-8 w-32 font-mono text-sm"
            />
          </FormRow>
        )}

        <FormRow label="人工审批 (gate)">
          <div className="flex items-center gap-2">
            <Switch
              checked={raw.gate === true}
              onCheckedChange={(v) => onChange({ gate: v ? true : undefined })}
            />
            <span className="text-xs text-muted-foreground">
              开启后此阶段执行完会挂起到 awaiting_，需人工点击通过/驳回
            </span>
          </div>
        </FormRow>

        {raw.gate === true && (
          <FormRow label="审批提示语">
            <Input
              value={(raw.gate_message as string | undefined) ?? ""}
              placeholder="请审阅产物后决定"
              onChange={(e) => onChange({ gate_message: e.target.value || undefined })}
              className="h-8 text-sm"
            />
          </FormRow>
        )}
      </div>

      {/* 分组操作：顶层 phase 可以移入并行块；并行子项可以移出 */}
      {isTopLevel && parallelBlockNames.length > 0 && (
        <section className="mt-4 border-t border-dashed border-foreground/25 pt-3">
          <div className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
            分组
          </div>
          <div className="flex items-center gap-2">
            <Label className="text-[11px] text-muted-foreground">移入并行块：</Label>
            <Select
              value="__none__"
              onValueChange={(v) => { if (v !== "__none__") onMoveIntoParallel(v); }}
            >
              <SelectTrigger className="h-7 w-44 text-xs">
                <SelectValue placeholder="选择并行块" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">（取消）</SelectItem>
                {parallelBlockNames.map((n) => (
                  <SelectItem key={n} value={n} className="font-mono">{n}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <p className="mt-1 text-[10px] text-muted-foreground">
            该阶段会成为并行块的最后一个子节点；移入后 reject 字段被清空（并行块内 reject 语义不适用）
          </p>
        </section>
      )}
      {!isTopLevel && (
        <section className="mt-4 border-t border-dashed border-foreground/25 pt-3">
          <div className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
            分组
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={onMoveOutOfParallel}
          >
            <ArrowUpFromLine className="h-4 w-4" />
            移出并行块
          </Button>
          <p className="mt-1 text-[10px] text-muted-foreground">
            该子节点会平铺到顶层，紧接所属并行块之后
          </p>
        </section>
      )}
    </div>
  );
}

function FormRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <Label className="mb-1 block font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </Label>
      {children}
    </div>
  );
}
