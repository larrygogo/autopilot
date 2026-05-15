import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Plus, Save, Trash2, ArrowLeft, ArrowRight, Play, Loader2 } from "lucide-react";
import { api } from "@/hooks/useApi";
import { useToast } from "./Toast";
import { ConfirmDialog } from "./Modal";
import { AddPhaseDialog, type NewPhaseData } from "./AddPhaseDialog";
import { PhasePipeline } from "./PhasePipeline";
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
  /** 工作流局部 agents（来自 workflow.yaml.agents[]），合到全局 agents 一起列入下拉 */
  workflowAgents?: Array<{ name: string }>;
  /** 工作流详情数据需要刷新的时候触发 */
  onSaved?: () => void;
}

export function PhasePipelineEditor({
  workflowName,
  initialPhases,
  tsSource,
  workflowAgents,
  onSaved,
}: Props) {
  const toast = useToast();
  const [phases, setPhases] = useState<any[]>(initialPhases);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [drawerPhase, setDrawerPhase] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [globalAgents, setGlobalAgents] = useState<string[]>([]);
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

  // 加载全局 agent 名字给 drawer 下拉用
  useEffect(() => {
    api.listAgents()
      .then((list) => setGlobalAgents(list.map((a) => a.name)))
      .catch(() => setGlobalAgents([]));
  }, []);

  const agentOptions = useMemo(() => {
    const set = new Set<string>(globalAgents);
    for (const a of workflowAgents ?? []) {
      if (a?.name) set.add(a.name);
    }
    return Array.from(set).sort();
  }, [globalAgents, workflowAgents]);

  const allPhaseNames = useMemo(() => {
    const names: string[] = [];
    for (const p of phases) {
      if (!p || typeof p !== "object") continue;
      if ((p as PhaseRaw).parallel) {
        const par = (p as PhaseRaw).parallel as PhaseRaw;
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

  // 当前 drawer 选中阶段的 raw 对象引用 + 在 phases 树中的"路径"
  const drawerPhaseLocation = useMemo(() => {
    if (!drawerPhase) return null;
    for (let i = 0; i < phases.length; i += 1) {
      const p = phases[i];
      if (!p) continue;
      if (p.parallel) {
        const subs: PhaseRaw[] = Array.isArray(p.parallel.phases) ? p.parallel.phases : [];
        for (let j = 0; j < subs.length; j += 1) {
          if (subs[j]?.name === drawerPhase) {
            return { kind: "parallel" as const, parallelIdx: i, subIdx: j, raw: subs[j] };
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
  // 并行块视为整体（其位置可调），并行块内子阶段不在本面板换序
  function handleMovePhase(name: string, dir: "left" | "right") {
    setPhases((prev) => {
      // 先找出 name 在顶层数组中的所属位置（普通 phase 直接是顶层 index，
      // 并行块子项不允许在此移动 — 拒绝）
      let topIdx = -1;
      let isParallelChild = false;
      for (let i = 0; i < prev.length; i += 1) {
        const p = prev[i];
        if (!p) continue;
        if (p.parallel) {
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
  const drawerTopIdx = useMemo(() => {
    if (!drawerPhase) return { idx: -1, total: phases.length, isParallelChild: false };
    for (let i = 0; i < phases.length; i += 1) {
      const p = phases[i];
      if (!p) continue;
      if (p.parallel) {
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

              <PhaseEditForm
                raw={drawerPhaseLocation.raw}
                workflowName={workflowName}
                allPhaseNames={allPhaseNames}
                agentOptions={agentOptions}
                onChange={(patch) => updatePhaseField(phaseName, patch)}
                onRename={(oldName, newName) => handleRenamePhase(oldName, newName)}
              />

              <PhaseTsEditor
                workflowName={workflowName}
                phaseName={phaseName}
                initialCode={drawerTsCode}
                hasPrompt={typeof drawerPhaseLocation.raw.prompt === "string" && (drawerPhaseLocation.raw.prompt as string).trim() !== ""}
                onSaved={() => onSaved?.()}
              />

              {/* 位置调整：仅顶层 phase 支持，并行块内子项不能在此调换 */}
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
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => setPendingDelete(phaseName)}
                >
                  <Trash2 className="h-4 w-4" />
                  删除阶段
                </Button>
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
    </div>
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
  agent: string;
  prompt: string;
}) {
  const toast = useToast();
  const [running, setRunning] = useState(false);
  const [output, setOutput] = useState<string | null>(null);
  const [durationMs, setDurationMs] = useState<number | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

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
          试跑 · 用当前 prompt 直接调一次 {agent}
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
  agentOptions,
  onChange,
  onRename,
}: {
  raw: PhaseRaw;
  workflowName: string;
  allPhaseNames: string[];
  agentOptions: string[];
  onChange: (patch: Record<string, unknown>) => void;
  /** 改名提交；返回 false 则恢复输入框为原 name */
  onRename: (oldName: string, newName: string) => boolean;
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

        <FormRow label="智能体 (agent)">
          <Select
            value={(raw.agent as string | undefined) || "__none__"}
            onValueChange={(v) => onChange({ agent: v === "__none__" ? undefined : v })}
          >
            <SelectTrigger className="h-8 text-sm">
              <SelectValue placeholder="（不指定，用 coder 默认）" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">（不指定）</SelectItem>
              {agentOptions.map((n) => (
                <SelectItem key={n} value={n} className="font-mono">
                  {n}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
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
            yaml 写 prompt + 指定 agent → 框架自动调用 agent.run(prompt)，无需写 ts 函数；
            适合简单的"调 agent 跑一段 prompt"场景，复杂分支（reject / 解析返回）仍需 ts
          </p>
          {typeof raw.prompt === "string" && raw.prompt.trim() && (
            <PromptDryRunner
              workflowName={workflowName}
              agent={(raw.agent as string | undefined) || "coder"}
              prompt={raw.prompt}
            />
          )}
        </FormRow>

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
