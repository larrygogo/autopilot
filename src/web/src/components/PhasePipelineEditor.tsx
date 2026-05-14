import React, { useEffect, useMemo, useState } from "react";
import { Plus, Save, Trash2, Pencil } from "lucide-react";
import { api } from "@/hooks/useApi";
import { useToast } from "./Toast";
import { ConfirmDialog } from "./Modal";
import { AddPhaseDialog, type NewPhaseData } from "./AddPhaseDialog";
import { PhasePipeline } from "./PhasePipeline";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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

  // initialPhases 变化（保存成功后父级 reload）时重置内部状态
  useEffect(() => {
    setPhases(initialPhases);
    setDirty(false);
  }, [initialPhases, workflowName]);

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
    setDirty(true);
    setAddOpen(false);
    toast.success(`新增阶段 ${data.name}（未保存，点保存生效）`);
  }

  // ── 删除阶段 ──
  function handleDeletePhase(name: string) {
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
    setSaving(true);
    try {
      const res = await api.setWorkflowPhases(workflowName, phases, true);
      setDirty(false);
      const ts = res.ts;
      const parts: string[] = [];
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

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
          流水线编辑 · 点击节点编辑
          {dirty && <span className="ml-2 text-warning">· 未保存</span>}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setAddOpen(true)}>
            <Plus className="h-4 w-4" />
            新增阶段
          </Button>
          <Button size="sm" onClick={save} disabled={!dirty || saving}>
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
                allPhaseNames={allPhaseNames}
                agentOptions={agentOptions}
                onChange={(patch) => updatePhaseField(phaseName, patch)}
              />

              {/* ts 函数代码（只读） */}
              <section className="mt-4">
                <div className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                  执行函数 · workflow.ts（只读）
                </div>
                {drawerTsCode ? (
                  <pre className="scrollbar-thin max-h-56 overflow-auto border-[1.5px] border-foreground/30 bg-card p-3 font-mono text-[11px] leading-relaxed">
                    {drawerTsCode}
                  </pre>
                ) : (
                  <p className="border-[1.5px] border-dashed border-foreground/30 bg-muted/30 p-3 text-xs text-muted-foreground">
                    未找到 <code className="font-mono">{phaseName}</code> 函数；
                    保存修改时框架会自动追加 stub。
                  </p>
                )}
              </section>

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

function PhaseEditForm({
  raw,
  allPhaseNames,
  agentOptions,
  onChange,
}: {
  raw: PhaseRaw;
  allPhaseNames: string[];
  agentOptions: string[];
  onChange: (patch: Record<string, unknown>) => void;
}) {
  // 排除自己
  const rejectCandidates = allPhaseNames.filter((n) => n !== raw.name);

  // raw.label 可能是 registry 兜底填的 name.toUpperCase()，那不是用户真填的，
  // 输入框要显示空让用户感知"还没设中文名"
  const rawLabel = typeof raw.label === "string" ? raw.label : null;
  const realLabel = userPhaseLabel({ name: String(raw.name ?? ""), label: rawLabel }) ?? "";

  return (
    <div className="space-y-3 pt-3">
      <div className="grid grid-cols-1 gap-2">
        <FormRow label="显示名 (label)">
          <Input
            value={realLabel}
            placeholder={`留空则显示 ${String(raw.name ?? "")}`}
            onChange={(e) => onChange({ label: e.target.value || undefined })}
            className="h-8 text-sm"
          />
          <p className="mt-1 text-[10px] text-muted-foreground">
            填中文显示名（如"数据入库"）；不填则节点显示标识符
          </p>
        </FormRow>

        <FormRow label="标识符 (name)">
          <Input
            value={String(raw.name ?? "")}
            disabled
            readOnly
            className="h-8 font-mono text-sm bg-muted/40"
          />
          <p className="mt-1 text-[10px] text-muted-foreground">
            name 关联 workflow.ts 中的函数名，改名涉及代码迁移，本面板不支持
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
