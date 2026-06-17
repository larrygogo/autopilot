import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Plus, Save, Trash2, ArrowUp, ArrowDown, Play, Loader2, Ungroup, ArrowUpFromLine, ArrowDownToLine, ChevronDown, ChevronRight } from "lucide-react";
import { api, type InlineAgentConfig } from "@/hooks/useApi";
import { useToast } from "./Toast";
import { ConfirmDialog } from "./Modal";
import { AddStepDialog, type NewPhaseData, type NewParallelData } from "./AddStepDialog";
import { PhaseAgentEditor } from "./PhaseAgentEditor";
import { PhasePipeline } from "./PhasePipeline";
import { CodeEditor } from "./CodeEditor";
import { PromptEditor } from "./PromptEditor";
import { useResizableWidth } from "@/hooks/useResizableWidth";

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
import { extractPhaseRunFunction } from "@/lib/ts-extract";
import { pickPhaseLabel, userPhaseLabel } from "@/lib/workflow-labels";

// ──────────────────────────────────────────────
// 流水线编辑器：流水线图 + 点击节点弹编辑 drawer + 新增/删除/保存
//
// 仅处理普通 phase 的编辑；并行块作为整体不动（图里仍渲染，但点子节点也走单 phase
// 编辑）。phase name 不可改（避免维护 ts 函数 rename 链路）；其它字段都能改。
// ──────────────────────────────────────────────

type PhaseRaw = Record<string, unknown>;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 列出 ts 源码里所有 run_<name> 函数名（与后端 extractRunFunctions 三种形式对齐）。 */
function listRunFunctionNames(src: string): string[] {
  const names = new Set<string>();
  const patterns = [
    /export\s+async\s+function\s+run_([A-Za-z0-9_]+)/g,
    /export\s+function\s+run_([A-Za-z0-9_]+)/g,
    /export\s+const\s+run_([A-Za-z0-9_]+)\s*=/g,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) names.add(m[1]);
  }
  return [...names];
}

/** 收集 phases 里所有"会绑定 run_ 函数"的 name（顶层普通 phase + 并行子节点，不含并行块容器本身——与后端 collectPhaseNames 对齐）。 */
function runFnBearingNames(phases: any[]): string[] {
  const out: string[] = [];
  for (const p of phases) {
    if (!p || typeof p !== "object") continue;
    if (p.parallel) {
      const subs: PhaseRaw[] = Array.isArray(p.parallel.phases) ? p.parallel.phases : [];
      for (const s of subs) if (typeof s?.name === "string") out.push(s.name);
    } else if (typeof p.name === "string") {
      out.push(p.name);
    }
  }
  return out;
}

/** 把一段 ts 代码里的函数声明 run_<old> 改写为 run_<new>（仅声明行，不动函数体内的字符串/注释）。 */
function rewriteRunFnHeader(code: string, oldName: string, newName: string): string {
  const re = new RegExp(`(export\\s+(?:async\\s+)?function\\s+)run_${escapeRegex(oldName)}(\\s*\\()`);
  return code.replace(re, `$1run_${newName}$2`);
}

// ──────────────────────────────────────────────
// 归一化「展开态 → 编写态」：workflows.get 返回的是 registry 展开后的 phases
// （reject 语法糖已被删、变成 jump_trigger/jump_target + 一堆状态机派生字段，label 兜底成大写）。
// 编辑器只认编写态字段。若把展开态原样回写 yaml：①旧 jump_target 会盖住新改的 reject（改驳回不生效）
// ②派生字段污染 yaml。故进编辑器先剥成编写态——jump_target 反推回 reject，剥派生字段与兜底 label。
// ──────────────────────────────────────────────
const ALWAYS_STRIP_FIELDS = ["jump_trigger", "_jump_origin", "reject_trigger", "retry_target"];

function normalizeSinglePhase(raw: Record<string, unknown>): Record<string, unknown> {
  const name = typeof raw.name === "string" ? raw.name : "";
  const out: Record<string, unknown> = { ...raw };
  // jump_target → reject（编辑器唯一的驳回机制就是 reject 语法糖）
  if ((out.reject === undefined || out.reject === null) && typeof out.jump_target === "string") {
    out.reject = out.jump_target;
  }
  delete out.jump_target;
  for (const k of ALWAYS_STRIP_FIELDS) delete out[k];
  // 状态机派生字段：仅当等于默认派生值才剥（保留极少见的用户自定义 trigger）
  const derived: Record<string, string> = {
    pending_state: `pending_${name}`,
    running_state: `running_${name}`,
    trigger: `start_${name}`,
    complete_trigger: `${name}_complete`,
    fail_trigger: `${name}_fail`,
  };
  for (const [k, v] of Object.entries(derived)) {
    if (out[k] === v) delete out[k];
  }
  // registry 兜底 label = NAME.toUpperCase()，非用户填，剥掉避免烤进 yaml
  if (typeof out.label === "string" && name && out.label === name.toUpperCase()) {
    delete out.label;
  }
  return out;
}

function normalizeLoadedPhases(phases: unknown[]): any[] {
  if (!Array.isArray(phases)) return [];
  return phases.map((p) => {
    if (p && typeof p === "object" && (p as Record<string, unknown>).parallel) {
      const par = (p as { parallel: Record<string, unknown> }).parallel;
      const subs = Array.isArray(par.phases) ? (par.phases as Record<string, unknown>[]) : [];
      return { ...(p as object), parallel: { ...par, phases: subs.map((s) => normalizeSinglePhase(s)) } };
    }
    if (p && typeof p === "object") return normalizeSinglePhase(p as Record<string, unknown>);
    return p;
  });
}

/** 保存将对 workflow.ts 产生的副作用预览（改名 / 新建 stub / 孤儿）。 */
interface SaveImpact {
  /** run_old → run_new */
  renames: { from: string; to: string }[];
  /** 将被新建 stub 的函数名（phase 无对应 run_ 函数） */
  willCreate: string[];
  /** 不再被任何 phase 引用的 run_ 函数（孤儿，框架不自动删） */
  orphans: string[];
}

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
  const [phases, setPhases] = useState<any[]>(() => normalizeLoadedPhases(initialPhases));
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [drawerPhase, setDrawerPhase] = useState<string | null>(null);
  const [addStepOpen, setAddStepOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [pendingDeleteParallel, setPendingDeleteParallel] = useState<string | null>(null);
  const [hoveredPhase, setHoveredPhase] = useState<string | null>(null);

  // ── 编辑抽屉宽度：受控 + 左缘拖拽调宽（持久化）。仅 sm+ 生效；<sm 回退 w-full（手柄隐藏）──
  const { width: drawerWidth, startResize } = useResizableWidth({
    storageKey: "phase.drawer.width.v2",
    defaultWidth: 720,
    min: 420,
  });
  const [wideEnough, setWideEnough] = useState<boolean>(
    () => (typeof window !== "undefined" ? window.matchMedia("(min-width: 640px)").matches : true),
  );
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 640px)");
    const on = () => setWideEnough(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);

  // ── ts 函数草稿：从「应用代码」即时落盘改为纳入批量保存（与字段改动同一个 dirty / 同一次保存）。
  // key = 当前 phase 名；value = 用户编辑后的完整 run_<phase> 源码。改名时一并迁移 key 并改写函数头。──
  const [tsDrafts, setTsDrafts] = useState<Record<string, string>>({});
  // 保存前的副作用确认（含 rename / 孤儿时弹出，避免破坏性操作静默发生）
  const [pendingSaveImpact, setPendingSaveImpact] = useState<SaveImpact | null>(null);

  // ── rename 追踪：保存时把 oldName→newName 一起传给后端，让 workflow.ts 里
  // run_<old> 函数也一并 rename，避免产生孤儿 ──
  const renamesRef = useRef<Map<string, string>>(new Map());
  // 本次编辑会话内新建的阶段名（rename 时不必登记 renames，因为后端没有对应的 run_<old>）
  const newlyAddedRef = useRef<Set<string>>(new Set());

  const resetDraftTracking = useCallback(() => {
    renamesRef.current = new Map();
    newlyAddedRef.current = new Set();
  }, []);

  // initialPhases 变化（保存成功后父级 reload）时重置内部状态
  useEffect(() => {
    setPhases(normalizeLoadedPhases(initialPhases));
    setDirty(false);
    setTsDrafts({});
    resetDraftTracking();
  }, [initialPhases, workflowName, resetDraftTracking]);

  // ts 草稿是否有真实改动（与源码里的原函数比对；改名后的新名在旧源码里取不到 → 视为有改动）。
  const tsDirty = useMemo(() => {
    for (const [name, draft] of Object.entries(tsDrafts)) {
      const original = (tsSource ? extractPhaseRunFunction(tsSource, name) : null) ?? "";
      if (draft.trim() !== original.trim()) return true;
    }
    return false;
  }, [tsDrafts, tsSource]);

  // 字段改动（dirty）与 ts 改动（tsDirty）合并成单一"有未保存修改"信号 → 单一保存模型。
  const anyDirty = dirty || tsDirty;

  // 收集需要写回 workflow.ts 的 ts 草稿（与原函数不同、非空），保存时在 setWorkflowPhases 之后逐个 flush。
  const collectTsEdits = useCallback((): { name: string; code: string }[] => {
    const edits: { name: string; code: string }[] = [];
    const bearing = new Set(runFnBearingNames(phases));
    for (const [name, draft] of Object.entries(tsDrafts)) {
      if (!bearing.has(name)) continue; // 该 phase 已被删除 / 改名迁移走，跳过
      const original = (tsSource ? extractPhaseRunFunction(tsSource, name) : null) ?? "";
      if (draft.trim() === "" || draft.trim() === original.trim()) continue;
      edits.push({ name, code: draft });
    }
    return edits;
  }, [phases, tsDrafts, tsSource]);

  // 离开页面 / 关闭窗口前提示：有未保存修改时弹原生 confirm
  useEffect(() => {
    if (!anyDirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // 现代浏览器忽略自定义文案，必须设置 returnValue 才会弹提示
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [anyDirty]);

  // Ctrl+S / Cmd+S 保存修改
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        if (anyDirty && !saving) void saveRef.current?.();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [anyDirty, saving]);
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

  // 阶段名 → 中文显示 label（reject 下拉等处把英文标识符翻成中文）
  const phaseLabelMap = useMemo(() => {
    const m: Record<string, string> = {};
    for (const p of phases) {
      if (!p || typeof p !== "object") continue;
      const par = (p as PhaseRaw).parallel as PhaseRaw | undefined;
      if (par && typeof par.name === "string") {
        m[par.name] = pickPhaseLabel({ name: par.name, label: par.label as string | undefined });
        const subs = Array.isArray(par.phases) ? (par.phases as PhaseRaw[]) : [];
        for (const s of subs) {
          if (typeof s.name === "string") m[s.name] = pickPhaseLabel({ name: s.name, label: s.label as string | undefined });
        }
      } else if (typeof (p as PhaseRaw).name === "string") {
        const n = (p as PhaseRaw).name as string;
        m[n] = pickPhaseLabel({ name: n, label: (p as PhaseRaw).label as string | undefined });
      }
    }
    return m;
  }, [phases]);

  // 当前 drawer 选中阶段的 raw 对象引用 + 在 phases 树中的"路径"。三种情况：
  // - top: 顶层普通 phase（最常见）
  // - parallel-child: 并行块内的子 phase
  // - parallel-block: 并行块"容器"本身（点击并行块 header 触发）
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
    // 传裸 phase 名；run_<phase> 命名约定封在 extractPhaseRunFunction 内。
    return extractPhaseRunFunction(tsSource, drawerPhase);
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
    setAddStepOpen(false);
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
    // 被删并行块的子节点 ts 草稿一并清理（collectTsEdits 已按现存 name 过滤，这里只为 tsDirty 不残留）
    const droppedChildren = new Set<string>();
    for (const p of phases) {
      if (p?.parallel?.name === blockName) {
        const subs: PhaseRaw[] = Array.isArray(p.parallel.phases) ? p.parallel.phases : [];
        for (const s of subs) if (typeof s?.name === "string") droppedChildren.add(s.name);
      }
    }
    if (droppedChildren.size > 0) {
      setTsDrafts((prev) => {
        const next: Record<string, string> = {};
        for (const [k, v] of Object.entries(prev)) if (!droppedChildren.has(k)) next[k] = v;
        return next;
      });
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
    setAddStepOpen(false);
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

    // 迁移该 phase 的 ts 草稿：key 改名 + 改写函数声明头 run_<old> → run_<new>
    setTsDrafts((prev) => {
      if (!(oldName in prev)) return prev;
      const { [oldName]: code, ...rest } = prev;
      return { ...rest, [newName]: rewriteRunFnHeader(code, oldName, newName) };
    });

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

  // 合法的 reject 目标：只能往回跳（后端 setWorkflowPhases 校验 reject ∈ 当前 phase 之前的
  // 顶层条目）。这里把约束前移到下拉选项层——只列当前 phase 所在顶层位置之前的条目名
  // （顶层普通 phase 名 / 并行块名；并行子节点名不入 orderedNames，故不作为目标）。
  const drawerRejectTargets = useMemo(() => {
    const idx = drawerTopIdx.idx;
    if (idx < 0) return [];
    const targets: string[] = [];
    for (let i = 0; i < idx; i += 1) {
      const p = phases[i];
      if (!p) continue;
      if (p.parallel) {
        if (typeof p.parallel.name === "string") targets.push(p.parallel.name);
      } else if (typeof p.name === "string") {
        targets.push(p.name);
      }
    }
    return targets;
  }, [drawerTopIdx.idx, phases]);

  function handleDeletePhase(name: string) {
    // 清理 renames：若被删的 name 是某条改名的目标，撤销该条；新建后又删除的 name 也清掉
    newlyAddedRef.current.delete(name);
    setTsDrafts((prev) => {
      if (!(name in prev)) return prev;
      const { [name]: _drop, ...rest } = prev;
      return rest;
    });
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
  // 当前有效的 rename 映射：只发"目标 newName 仍存在"的（用户可能删过中间产物）。
  const computeValidRenames = useCallback((): Record<string, string> => {
    const currentNames = new Set(allPhaseNames);
    const valid: Record<string, string> = {};
    for (const [oldName, newName] of renamesRef.current.entries()) {
      if (currentNames.has(newName)) valid[oldName] = newName;
    }
    return valid;
  }, [allPhaseNames]);

  // 预测本次保存对 workflow.ts 的副作用，用于保存前确认（把事后 toast 提到事前）。
  const computeSaveImpact = useCallback((): SaveImpact => {
    const valid = computeValidRenames();
    const renames = Object.entries(valid).map(([from, to]) => ({ from, to }));
    const existing = tsSource ? listRunFunctionNames(tsSource) : [];
    // 应用 rename 后源码里"将存在"的函数名集合
    const existingAfter = new Set(existing.map((n) => valid[n] ?? n));
    const bearing = runFnBearingNames(phases);
    const bearingSet = new Set(bearing);
    const willCreate = bearing.filter((n) => !existingAfter.has(n));
    const orphans = [...existingAfter].filter((n) => !bearingSet.has(n));
    return { renames, willCreate, orphans };
  }, [computeValidRenames, tsSource, phases]);

  async function save() {
    if (!anyDirty || saving) return;
    const impact = computeSaveImpact();
    // 破坏性 / 意外副作用（改名、产生孤儿）先弹确认；纯字段或纯新增直接保存不打断。
    if (impact.renames.length > 0 || impact.orphans.length > 0) {
      setPendingSaveImpact(impact);
      return;
    }
    await doSave();
  }

  async function doSave() {
    if (saving) return;
    setSaving(true);
    try {
      const valid = computeValidRenames();
      const renamesToSend = Object.keys(valid).length > 0 ? valid : undefined;
      const parts: string[] = [];

      // 1. 结构 / 字段 / rename —— 仅当有结构改动时调用（纯 ts 改动跳过，避免无谓重写 yaml）。
      let res: Awaited<ReturnType<typeof api.setWorkflowPhases>> | null = null;
      if (dirty) {
        res = await api.setWorkflowPhases(workflowName, phases, true, renamesToSend);
      }

      // 2. ts 函数草稿 —— 在 rename 完成之后写回（此时文件里函数名已是新名，header 匹配）。
      const edits = collectTsEdits();
      for (const { name, code } of edits) {
        await api.setWorkflowPhaseFn(workflowName, name, code);
      }

      setDirty(false);
      setTsDrafts({});
      resetDraftTracking();

      const ts = res?.ts;
      const renamed = res?.renamed ?? [];
      if (renamed.length > 0) parts.push(`已改名 ${renamed.length} 个函数：${renamed.join(", ")}`);
      if (ts?.added?.length) parts.push(`新增 ${ts.added.length} 个函数：${ts.added.join(", ")}`);
      if (edits.length > 0) parts.push(`写回 ${edits.length} 个 ts 函数：${edits.map((e) => e.name).join(", ")}`);
      if (ts?.orphans?.length) parts.push(`检测到 ${ts.orphans.length} 个孤儿函数（手工清理或下次保存自动同步）`);
      if (res?.ts_error) parts.push(`ts 同步警告：${res.ts_error}`);
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
        <div className="font-mono text-[11px] text-muted-foreground">
          流水线编辑 · 点击节点编辑
          {anyDirty && <span className="ml-2 text-warning">· 未保存（{navigator.platform.toLowerCase().includes("mac") ? "⌘" : "Ctrl"}+S 快捷保存）</span>}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setAddStepOpen(true)}>
            <Plus className="h-4 w-4" />
            新增
          </Button>
          <Button size="sm" onClick={save} disabled={!anyDirty || saving} title="保存修改（Ctrl/Cmd+S）">
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

      {/* 编辑 drawer — sm+ 受控宽度可拖拽调宽，<sm 回退 w-full */}
      <Sheet open={!!drawerPhase} onOpenChange={(o) => { if (!o) setDrawerPhase(null); }}>
        <SheetContent
          side="right"
          className="flex w-full flex-col gap-0 p-0 sm:max-w-none"
          style={wideEnough ? { width: drawerWidth } : undefined}
        >
          {/* 左缘拖拽手柄：仅 sm+ 显示 */}
          <div
            className="absolute inset-y-0 left-0 z-20 hidden w-1.5 cursor-col-resize transition-colors hover:bg-accent/40 sm:block"
            role="separator"
            aria-orientation="vertical"
            title="拖拽调整宽度"
            onPointerDown={startResize}
          />
          {drawerPhaseLocation && (() => {
            const phaseName = String(drawerPhaseLocation.raw.name ?? "");
            const rawLabel = typeof drawerPhaseLocation.raw.label === "string"
              ? drawerPhaseLocation.raw.label
              : null;
            const displayName = pickPhaseLabel({ name: phaseName, label: rawLabel });
            return (
            <>
              <SheetHeader className="shrink-0 px-4 pt-4 sm:px-6 sm:pt-6">
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

              {/* 仅中间体滚动，header / footer 固定不动 */}
              <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 sm:px-6">
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
                    rejectTargets={drawerRejectTargets}
                    phaseLabels={phaseLabelMap}
                    isTopLevel={drawerPhaseLocation.kind === "top"}
                    parallelBlockNames={parallelBlockNames}
                    onChange={(patch) => updatePhaseField(phaseName, patch)}
                    onRename={(oldName, newName) => handleRenamePhase(oldName, newName)}
                    onMoveIntoParallel={(parName) => handleMoveIntoParallel(phaseName, parName)}
                    onMoveOutOfParallel={() => handleMoveOutOfParallel(phaseName)}
                    tsOriginalCode={drawerTsCode}
                    tsValue={tsDrafts[phaseName] ?? drawerTsCode ?? ""}
                    onTsChange={(code) => setTsDrafts((prev) => ({ ...prev, [phaseName]: code }))}
                  />
                </>
              )}

              {/* 位置调整：顶层 phase / 并行块本身支持；并行块内子项不能在此调换 */}
              {!drawerTopIdx.isParallelChild && (
                <section className="mt-4">
                  <div className="mb-1.5 font-mono text-[10px] text-muted-foreground">
                    位置
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleMovePhase(phaseName, "left")}
                      disabled={drawerTopIdx.idx <= 0}
                    >
                      <ArrowUp className="h-4 w-4" />
                      前移
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleMovePhase(phaseName, "right")}
                      disabled={drawerTopIdx.idx < 0 || drawerTopIdx.idx >= drawerTopIdx.total - 1}
                    >
                      <ArrowDown className="h-4 w-4" />
                      后移
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
              {/* 危险操作：放内容区最底部、需滚动才到达，远离常驻保存键，避免误触 */}
              <section className="mt-6 border-t border-border pt-3">
                <div className="mb-1.5 font-mono text-[10px] text-muted-foreground">危险操作</div>
                {drawerPhaseLocation.kind === "parallel-block" ? (
                  <div className="flex flex-wrap gap-2">
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
                  </div>
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
              </section>
              </div>

              <SheetFooter className="shrink-0 px-4 pb-4 sm:px-6 sm:pb-6">
                <Button
                  size="sm"
                  onClick={() => {
                    setDrawerPhase(null);
                    if (anyDirty) void save();
                  }}
                  disabled={saving}
                >
                  <Save className="h-4 w-4" />
                  {anyDirty ? "保存并关闭" : "关闭"}
                </Button>
              </SheetFooter>
            </>
            );
          })()}
        </SheetContent>
      </Sheet>

      <AddStepDialog
        open={addStepOpen}
        onClose={() => setAddStepOpen(false)}
        existingNames={allPhaseNames}
        topLabels={phases.map((p) => {
          const par = p?.parallel as { name?: string; label?: string } | undefined;
          return par
            ? `[并行] ${pickPhaseLabel({ name: String(par.name ?? "?"), label: par.label })}`
            : pickPhaseLabel({ name: String(p?.name ?? "?"), label: p?.label as string | undefined });
        })}
        onConfirmPhase={handleAddPhase}
        onConfirmParallel={handleAddParallel}
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

      <ConfirmDialog
        open={!!pendingSaveImpact}
        title="保存将改写 workflow.ts"
        message={
          <div className="space-y-2 text-sm">
            <p className="text-muted-foreground">本次保存会对 workflow.ts 做以下结构改动，确认后写入：</p>
            {pendingSaveImpact?.renames.length ? (
              <div>
                <div className="mb-1 font-mono text-[11px] text-foreground">重命名函数（{pendingSaveImpact.renames.length}）</div>
                <ul className="space-y-0.5">
                  {pendingSaveImpact.renames.map((r) => (
                    <li key={r.from} className="font-mono text-[11px] text-muted-foreground">
                      <code>run_{r.from}</code> → <code>run_{r.to}</code>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {pendingSaveImpact?.willCreate.length ? (
              <div>
                <div className="mb-1 font-mono text-[11px] text-foreground">新建函数 stub（{pendingSaveImpact.willCreate.length}）</div>
                <p className="font-mono text-[11px] text-muted-foreground">{pendingSaveImpact.willCreate.map((n) => `run_${n}`).join(", ")}</p>
              </div>
            ) : null}
            {pendingSaveImpact?.orphans.length ? (
              <div>
                <div className="mb-1 font-mono text-[11px] text-warning">孤儿函数（{pendingSaveImpact.orphans.length}）</div>
                <p className="font-mono text-[11px] text-muted-foreground">
                  {pendingSaveImpact.orphans.map((n) => `run_${n}`).join(", ")}
                </p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">这些函数已无 phase 引用；框架不会自动删除，保留在文件里需手工清理。</p>
              </div>
            ) : null}
          </div>
        }
        confirmText="确认保存"
        onConfirm={() => { setPendingSaveImpact(null); void doSave(); }}
        onCancel={() => setPendingSaveImpact(null)}
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
            <SelectItem value="cancel_all">cancel_all · 任一子失败 → 整组判失败</SelectItem>
            <SelectItem value="continue">continue · 任一子失败 → 其它继续</SelectItem>
          </SelectContent>
        </Select>
      </FormRow>

      <section>
        <div className="mb-1.5 font-mono text-[10px] text-muted-foreground">
          包含的子阶段（{subs.length}）
        </div>
        <ul className="space-y-1 border border-border bg-muted/30 p-2">
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
          <div className="mb-1.5 font-mono text-[10px] text-muted-foreground">
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
      <div className="mb-1.5 font-mono text-[10px] text-muted-foreground">
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
    <div className="mt-2 border border-border bg-muted/20 p-2">
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[10px] text-muted-foreground">
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
        变量占位符（{"${REQUIREMENT}"} 等）原样发送给 agent，调试时建议先手动替换成真实测试值
      </p>
      {(output !== null || errorMsg !== null) && (
        <div className="mt-2">
          {durationMs !== null && (
            <div className="mb-1 font-mono text-[10px] text-muted-foreground">
              耗时 {(durationMs / 1000).toFixed(1)}s
            </div>
          )}
          {errorMsg !== null ? (
            <pre className="scrollbar-thin max-h-48 overflow-auto whitespace-pre-wrap border border-destructive bg-destructive/8 p-2 font-mono text-[10px] leading-relaxed text-destructive">
              {errorMsg}
            </pre>
          ) : (
            <pre className="scrollbar-thin max-h-48 overflow-auto whitespace-pre-wrap border border-border bg-card p-2 font-mono text-[10px] leading-relaxed">
              {output}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────
// 子组件：ts 函数代码编辑器（受控草稿，纳入父级批量保存）
//
// 不再独立即时落盘——编辑只更新父级 tsDrafts，与字段改动共用同一个「保存修改」。
// 这样关闭抽屉/离开页面前的未保存提示对 ts 改动同样生效，不会出现"ts 已写盘、字段丢失"的割裂。
// ──────────────────────────────────────────────

function PhaseTsEditor({
  phaseName,
  originalCode,
  value,
  onChange,
  hasPrompt,
}: {
  phaseName: string;
  /** 源码里现存的本阶段函数（用于判断"prompt 驱动 vs ts 函数"提示与脏标记） */
  originalCode: string | null;
  value: string;
  onChange: (code: string) => void;
  /** 该 phase 在 yaml 里有 prompt 字段：用于显示优先级提示 */
  hasPrompt?: boolean;
}) {
  const dirty = value.trim() !== (originalCode ?? "").trim();

  return (
    <section className="mt-4">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="font-mono text-[10px] text-muted-foreground">
          执行函数 · workflow.ts
          {dirty && <span className="ml-2 text-warning">· 未保存（随底部「保存修改」一并写回）</span>}
        </span>
      </div>
      {hasPrompt && originalCode === null && (
        <p className="mb-1 border border-success/40 bg-success/5 p-2 text-[11px] text-success">
          该阶段由 prompt 驱动（yaml 里有 prompt 字段），框架自动调 agent.run；无需 ts 函数
        </p>
      )}
      {hasPrompt && originalCode !== null && (
        <p className="mb-1 border border-warning/40 bg-warning/5 p-2 text-[11px] text-warning">
          该阶段同时有 prompt 字段和 ts 函数；提示词优先——框架只跑 prompt，<b>这段 ts 函数会被忽略</b>
        </p>
      )}
      {!hasPrompt && originalCode === null && value === "" && (
        <p className="mb-1 border border-border bg-muted/30 p-2 text-[11px] text-muted-foreground">
          未找到 <code className="font-mono">run_{phaseName}</code> 函数；上面填 prompt 即可零代码运行，或在下方编写完整 ts 函数
        </p>
      )}
      <CodeEditor
        value={value}
        onChange={onChange}
        placeholder={`export async function run_${phaseName}(taskId: string): Promise<void> {\n  // TODO\n}`}
        title={`run_${phaseName}`}
      />
      <p className="mt-1 text-[10px] text-muted-foreground">
        必须以 <code className="font-mono">export async function run_{phaseName}(</code> 开头；保存时随字段改动一并写回 workflow.ts。右上角可全屏编辑（Esc 退出）
      </p>
    </section>
  );
}

// ──────────────────────────────────────────────

function PhaseEditForm({
  raw,
  workflowName,
  allPhaseNames,
  rejectTargets,
  phaseLabels,
  isTopLevel,
  parallelBlockNames,
  onChange,
  onRename,
  onMoveIntoParallel,
  onMoveOutOfParallel,
  tsOriginalCode,
  tsValue,
  onTsChange,
}: {
  raw: PhaseRaw;
  workflowName: string;
  allPhaseNames: string[];
  /** 合法的 reject 目标（只能往回跳）——已由父级按当前 phase 的顶层位置过滤 */
  rejectTargets: string[];
  /** 阶段名 → 中文显示 label（reject 下拉用） */
  phaseLabels: Record<string, string>;
  /** true 表示当前 phase 在顶层（顶层时可"移入并行块"；并行子项时可"移出"） */
  isTopLevel: boolean;
  /** 现有并行块名列表（顶层 phase 用） */
  parallelBlockNames: string[];
  onChange: (patch: Record<string, unknown>) => void;
  /** 改名提交；返回 false 则恢复输入框为原 name */
  onRename: (oldName: string, newName: string) => boolean;
  onMoveIntoParallel: (parallelName: string) => void;
  onMoveOutOfParallel: () => void;
  /** 本阶段 workflow.ts 里现存的 run 函数源码（判断 prompt vs 代码模式 + 脏标记） */
  tsOriginalCode: string | null;
  /** ts 编辑草稿当前值 */
  tsValue: string;
  onTsChange: (code: string) => void;
}) {
  // reject 只能往回跳：候选 = 父级按位置过滤后的合法目标（排除自己）。
  // 若当前已存的 reject 值因重排变得不合法，仍并入候选保证它在下拉里可见（否则 Select 渲染不出 label）。
  const curReject = typeof raw.reject === "string" ? raw.reject : "";
  const rejectCandidates = (() => {
    const valid = rejectTargets.filter((n) => n !== raw.name);
    if (curReject && curReject !== raw.name && !valid.includes(curReject)) {
      return [...valid, curReject];
    }
    return valid;
  })();
  const rejectValueInvalid = !!curReject && !rejectTargets.includes(curReject);
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

  // 声明式判据（decision）草稿读写：支持增量填写，全空才删。
  const decision = (raw.decision ?? {}) as {
    mode?: string;
    pass?: string;
    reject?: string;
    reason_section?: string;
    match?: string;
    criteria?: string;
    judge_provider?: string;
    judge_model?: string;
    judge_system_prompt?: string;
  };
  // 判据模式：tool（评审 agent 自己调 submit_decision，dev 在用，推荐）/ marker（grep 标记）。
  // 按数据推断，缺省 tool。（早期 judge 模式已移除——tool 文本路径是其更省等价物。）
  const decisionMode: "tool" | "marker" =
    decision.mode === "marker" ? "marker"
      : decision.mode === "tool" ? "tool"
      : decision.pass || decision.reject ? "marker"
      : "tool";
  function patchDecision(p: Partial<typeof decision>) {
    const next: Record<string, unknown> = { ...decision, ...p };
    const cleaned: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(next)) if (typeof v === "string" && v.trim()) cleaned[k] = v;
    onChange({ decision: Object.keys(cleaned).length ? cleaned : undefined });
  }
  // 切模式：清掉其他模式专属字段，避免残留脏数据；judge_* 是已移除的 judge 模式遗留，一并清。
  function setDecisionMode(mode: "tool" | "marker") {
    const p: Partial<typeof decision> = { mode };
    if (mode !== "marker") { p.pass = ""; p.reject = ""; p.reason_section = ""; p.match = ""; }
    p.judge_provider = ""; p.judge_model = ""; p.judge_system_prompt = "";
    patchDecision(p);
  }
  const isPromptMode = typeof raw.prompt === "string" && raw.prompt.trim() !== "";
  const hasTsFn = (tsOriginalCode ?? "").trim() !== "" || tsValue.trim() !== "";
  // 任务编辑模式：写提示词（零代码）/ 写执行函数（ts）二选一。初值按数据推断；切 phase 时重置。
  const [taskMode, setTaskMode] = useState<"prompt" | "code">(hasTsFn && !isPromptMode ? "code" : "prompt");
  useEffect(() => {
    setTaskMode(hasTsFn && !isPromptMode ? "code" : "prompt");
    // 仅 phase 切换时重置（模式内编辑不重置）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phaseName]);

  // 出口判定：这一步跑完怎么走。三选一（互斥），由数据派生——
  //   直接通过 = 无驳回目标且未开人工审批；自动判据 = 有驳回目标（agent 自判）；人工审批 = gate=true（停下等人）。
  const rejectSet = typeof raw.reject === "string" && raw.reject !== "";
  const exitMode: "through" | "auto" | "manual" =
    raw.gate === true ? "manual" : rejectSet ? "auto" : "through";
  function chooseExitMode(mode: "through" | "auto" | "manual") {
    if (mode === "through") {
      onChange({ reject: undefined, max_rejections: undefined, gate: undefined, decision: undefined, gate_message: undefined });
    } else if (mode === "auto") {
      // 自动判据需要一个驳回目标——还没选就默认挑最近的前序阶段，省一步手动选。
      const patch: Record<string, unknown> = { gate: undefined, gate_message: undefined };
      if (!rejectSet && rejectCandidates.length > 0) patch.reject = rejectCandidates[rejectCandidates.length - 1];
      onChange(patch);
    } else {
      onChange({ gate: true, decision: undefined });
    }
  }

  // 任务区（写提示词 / 写执行函数）：构建好后嵌入智能体卡，紧跟模型之后。
  const taskGroup = (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="bp-label text-[11px] text-foreground">任务</span>
        <div className="inline-flex rounded-md border border-border bg-muted/30 p-0.5">
          <button type="button" onClick={() => setTaskMode("prompt")} className={taskMode === "prompt" ? "rounded-[5px] bg-card px-2 py-0.5 text-[10px] text-foreground shadow-sm" : "rounded-[5px] px-2 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"}>写提示词</button>
          <button type="button" onClick={() => setTaskMode("code")} className={taskMode === "code" ? "rounded-[5px] bg-card px-2 py-0.5 text-[10px] text-foreground shadow-sm" : "rounded-[5px] px-2 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"}>写执行函数</button>
        </div>
      </div>
      {isPromptMode && hasTsFn && (
        <p className="border border-warning/40 bg-warning/5 p-2 text-[10px] text-warning">
          同时填了提示词和执行函数，提示词优先——运行时只执行提示词、执行函数被忽略（要改用执行函数请清空提示词）。
        </p>
      )}
      {taskMode === "prompt" ? (
        <div className="space-y-1">
          <PromptEditor
            value={typeof raw.prompt === "string" ? raw.prompt : ""}
            onChange={(v) => onChange({ prompt: v || undefined })}
            placeholder={"这一步要 agent 做什么。点上方「变量」插入占位符，运行时框架替换成真实值。\n例：评审 ${HANDOFF_design} 是否满足 ${REQUIREMENT}。"}
          />
          {typeof raw.prompt === "string" && raw.prompt.trim() && (
            <PromptDryRunner
              workflowName={workflowName}
              agent={normalizeInlineAgent(raw.agent)}
              prompt={raw.prompt}
            />
          )}
        </div>
      ) : (
        <PhaseTsEditor
          phaseName={phaseName}
          originalCode={tsOriginalCode}
          value={tsValue}
          onChange={onTsChange}
          hasPrompt={isPromptMode}
        />
      )}
    </div>
  );

  return (
    <div className="space-y-3 pt-3">
      {/* 阶段信息（折叠，放最上面）：显示名 / 标识符 / 超时 / 分组 */}
      <CollapsibleSection title="阶段信息（显示名 · 标识符 · 超时）">
        {/* sm+ 两列、移动端逐项堆叠——字段不必各占一行 */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
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
        </div>

        {/* 分组：顶层 phase 移入并行块；并行子项移出 */}
        {isTopLevel && parallelBlockNames.length > 0 && (
          <section className="mt-2 border-t border-border pt-3">
            <div className="mb-1.5 font-mono text-[10px] text-muted-foreground">
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
          <section className="mt-2 border-t border-border pt-3">
            <div className="mb-1.5 font-mono text-[10px] text-muted-foreground">
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
      </CollapsibleSection>

      {/* 智能体卡：模型 → 角色设定 → 任务 → 高级，合成一张卡 */}
      <PhaseAgentEditor
        phaseName={phaseName}
        agent={normalizeInlineAgent(raw.agent)}
        onChange={(next) => onChange({ agent: next })}
        taskSlot={taskGroup}
      />

      {/* 流程控制（折叠）：这一步跑完怎么走 —— 直接通过 / 自动判据 / 人工审批 三选一 */}
      <CollapsibleSection title="流程控制（这一步跑完怎么走）">
        <FormRow label="这一步跑完怎么走">
          <div className="space-y-2">
            <div className="inline-flex flex-wrap rounded-md border border-border bg-muted/30 p-0.5">
              {([
                ["through", "直接通过"],
                ["auto", "自动判据"],
                ["manual", "人工审批"],
              ] as const).map(([m, label]) => {
                // 第一个阶段没有可驳回的前序，自动判据无意义 → 禁用
                const disabled = m === "auto" && rejectCandidates.length === 0;
                const active = exitMode === m;
                return (
                  <button
                    key={m}
                    type="button"
                    disabled={disabled}
                    onClick={() => chooseExitMode(m)}
                    title={disabled ? "当前已是第一个阶段，没有可回退的前序，无法自动判据" : undefined}
                    className={
                      active
                        ? "rounded-[5px] bg-card px-2.5 py-1 text-[11px] text-foreground shadow-sm"
                        : "rounded-[5px] px-2.5 py-1 text-[11px] text-muted-foreground enabled:hover:text-foreground disabled:opacity-40"
                    }
                  >
                    {label}
                  </button>
                );
              })}
            </div>
            <p className="text-[10px] text-muted-foreground">
              {exitMode === "through" && "跑完直接进下一步，不卡。"}
              {exitMode === "auto" && "做评审的 agent 按你写的标准自己判通过 / 驳回，驳回自动回退重做（上限走「最大驳回次数」，触顶暂停报人）。"}
              {exitMode === "manual" && "跑完停下来等你，点「通过」进下一步，点「驳回」回退重做。"}
            </p>
          </div>
        </FormRow>

        {/* 驳回到 + 最大驳回次数：自动判据 / 人工审批 共用（人工审批留空＝只能通过） */}
        {(exitMode === "auto" || exitMode === "manual") && (
          <>
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
                  {rejectCandidates.map((n) => {
                    const label = phaseLabels[n] ?? n;
                    return (
                      <SelectItem key={n} value={n}>
                        <span className="flex items-baseline gap-1.5">
                          <span>{label}</span>
                          {label !== n && <span className="font-mono text-[10px] text-muted-foreground">{n}</span>}
                          {n === curReject && rejectValueInvalid ? "（已不在前序，请重选）" : ""}
                        </span>
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
              {rejectValueInvalid ? (
                <p className="mt-1 text-[10px] text-warning">
                  当前「{curReject}」已排到本阶段之后，驳回只能往回跳；请改选前序阶段，否则保存会被拒。
                </p>
              ) : exitMode === "auto" && !rejectSet ? (
                <p className="mt-1 text-[10px] text-warning">
                  自动判据需要一个回退目标，请在上面选一个前序阶段。
                </p>
              ) : exitMode === "manual" ? (
                <p className="mt-1 text-[10px] text-muted-foreground">
                  你点「驳回」时回退到这里重做；留空（不驳回）＝这一步只能通过。
                </p>
              ) : (
                <p className="mt-1 text-[10px] text-muted-foreground">
                  只列出本阶段之前的阶段（驳回只能往回跳）。
                </p>
              )}
            </FormRow>

            {rejectSet && (
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
          </>
        )}

        {/* 自动判据配置 —— 仅提示词模式可视化配；ts 模式由代码判 */}
        {exitMode === "auto" && rejectSet && isPromptMode && (
          <FormRow label="判据（这一步如何判通过 / 驳回）">
            <div className="space-y-2">
              {/* 模式：工具裁决（tool，评审 agent 自己调 submit_decision）/ 标记匹配（marker，grep agent 输出标记） */}
              <div className="inline-flex rounded-md border border-border bg-muted/30 p-0.5">
                <button type="button" onClick={() => setDecisionMode("tool")} className={decisionMode === "tool" ? "rounded-[5px] bg-card px-2 py-0.5 text-[10px] text-foreground shadow-sm" : "rounded-[5px] px-2 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"}>工具裁决</button>
                <button type="button" onClick={() => setDecisionMode("marker")} className={decisionMode === "marker" ? "rounded-[5px] bg-card px-2 py-0.5 text-[10px] text-foreground shadow-sm" : "rounded-[5px] px-2 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"}>标记匹配</button>
              </div>

              {decisionMode === "tool" ? (
                <div className="space-y-1">
                  <span className="text-[10px] text-muted-foreground">
                    评判标准：这一步怎样算通过 / 驳回。
                  </span>
                  <Textarea
                    value={decision.criteria ?? ""}
                    placeholder={"如：架构方向正确、核心需求有覆盖即 pass；仅当存在架构性硬伤（技术方向错 / 不可行 / 核心需求遗漏）才 reject。可在开发阶段处理的 gap 不构成驳回。"}
                    onChange={(e) => patchDecision({ criteria: e.target.value })}
                    className="min-h-[90px] resize-y text-sm leading-relaxed"
                    spellCheck={false}
                  />
                </div>
              ) : (
                <>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <div className="space-y-1">
                      <span className="text-[10px] text-muted-foreground">通过标记</span>
                      <Input value={decision.pass ?? ""} placeholder="如 REVIEW_RESULT: PASS" onChange={(e) => patchDecision({ pass: e.target.value })} className="h-8 font-mono text-sm" />
                    </div>
                    <div className="space-y-1">
                      <span className="text-[10px] text-muted-foreground">驳回标记</span>
                      <Input value={decision.reject ?? ""} placeholder="如 REVIEW_RESULT: REJECT" onChange={(e) => patchDecision({ reject: e.target.value })} className="h-8 font-mono text-sm" />
                    </div>
                  </div>
                  <div className="space-y-1">
                    <span className="text-[10px] text-muted-foreground">驳回理由段（可选）</span>
                    <Input value={decision.reason_section ?? ""} placeholder="如 ## 驳回理由（留空取全文）" onChange={(e) => patchDecision({ reason_section: e.target.value })} className="h-8 font-mono text-sm" />
                  </div>
                </>
              )}
            </div>
          </FormRow>
        )}

        {exitMode === "auto" && rejectSet && !isPromptMode && (
          <p className="text-[10px] text-muted-foreground">
            这一步用执行函数（ts）实现，通过 / 驳回由代码里的逻辑决定，这里不用另配判据。
          </p>
        )}

        {/* 人工审批配置 */}
        {exitMode === "manual" && (
          <FormRow label="审批提示语">
            <Input
              value={(raw.gate_message as string | undefined) ?? ""}
              placeholder="请审阅产物后决定"
              onChange={(e) => onChange({ gate_message: e.target.value || undefined })}
              className="h-8 text-sm"
            />
          </FormRow>
        )}
      </CollapsibleSection>
    </div>
  );
}

function FormRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <Label className="mb-1 block font-mono text-[10px] text-muted-foreground">
        {label}
      </Label>
      {children}
    </div>
  );
}

// 折叠区：把智能体卡之外的次要配置（阶段信息 / 流程控制）收起，默认折叠，
// 让智能体卡（模型 + 任务 + 角色）成为抽屉里的主视觉。
function CollapsibleSection({
  title,
  defaultOpen,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(!!defaultOpen);
  return (
    <div className="rounded-lg border border-border">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 bp-label px-3 py-2 text-[10px] text-muted-foreground hover:text-foreground"
      >
        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        <span>{title}</span>
      </button>
      {open && <div className="space-y-3 border-t border-border p-3">{children}</div>}
    </div>
  );
}
