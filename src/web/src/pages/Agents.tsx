import React, { useEffect, useState } from "react";
import { Plus, Pencil, Trash2, PlayCircle, AlertTriangle } from "lucide-react";
import { api, type AgentItem, type ProviderModelsResult } from "@/hooks/useApi";
import { useToast } from "@/components/Toast";
import { ConfirmDialog } from "@/components/Modal";
import { AgentDryRunDialog } from "@/components/AgentDryRunDialog";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input, Textarea } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type EditState = { original: string | null; draft: AgentItem } | null;

const PROVIDERS = ["anthropic", "openai", "google"] as const;
const PERMISSION_MODES = ["auto", "ask", "readonly", "deny"] as const;

function emptyDraft(): AgentItem {
  return { name: "", provider: "anthropic", model: "", max_turns: 10, permission_mode: "auto", system_prompt: "" };
}

// 保留 embedded 参数签名以兼容旧调用
export function Agents(_props: { embedded?: boolean } = {}) {
  const toast = useToast();
  const [agents, setAgents] = useState<AgentItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [edit, setEdit] = useState<EditState>(null);
  const [saving, setSaving] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [dryRunTarget, setDryRunTarget] = useState<AgentItem | null>(null);
  const [models, setModels] = useState<Record<string, ProviderModelsResult>>({});

  const refresh = () => {
    setLoading(true);
    setLoadError(null);
    api.listAgents()
      .then(setAgents)
      .catch((e) => setLoadError(e?.message ?? String(e)))
      .finally(() => setLoading(false));
  };

  useEffect(() => { refresh(); }, []);

  useEffect(() => {
    const names = ["anthropic", "openai", "google"];
    Promise.all(names.map((n) => api.getProviderModels(n).catch(() => null)))
      .then((list) => {
        const map: Record<string, ProviderModelsResult> = {};
        for (const r of list) if (r) map[r.name] = r;
        setModels(map);
      });
  }, []);

  const startCreate = () => setEdit({ original: null, draft: emptyDraft() });
  const startEdit = (a: AgentItem) => setEdit({ original: a.name, draft: { ...a } });
  const closeEdit = () => { if (!saving) setEdit(null); };

  const doDelete = async () => {
    if (!pendingDelete) return;
    const name = pendingDelete;
    try {
      await api.deleteAgent(name);
      toast.success(`已删除 ${name}`);
      refresh();
    } catch (e: any) {
      toast.error("删除失败", e?.message ?? String(e));
    } finally {
      setPendingDelete(null);
    }
  };

  const save = async () => {
    if (!edit) return;
    const { original, draft } = edit;
    if (!draft.name || !/^[\w.\-]+$/.test(draft.name)) {
      toast.warning("名称必须为字母、数字、._- 组成，且非空");
      return;
    }
    if (!draft.provider) {
      toast.warning("必须选择 provider");
      return;
    }
    setSaving(true);
    try {
      const body: Record<string, unknown> = { provider: draft.provider };
      if (draft.model) body.model = draft.model;
      if (typeof draft.max_turns === "number") body.max_turns = draft.max_turns;
      if (draft.permission_mode) body.permission_mode = draft.permission_mode;
      if (draft.system_prompt) body.system_prompt = draft.system_prompt;
      if (draft.extends) body.extends = draft.extends;

      if (original && original === draft.name) {
        await api.updateAgent(original, body);
      } else if (original && original !== draft.name) {
        await api.createAgent({ name: draft.name, ...body });
        await api.deleteAgent(original);
      } else {
        await api.createAgent({ name: draft.name, ...body });
      }
      toast.success("已保存");
      setEdit(null);
      refresh();
    } catch (e: any) {
      toast.error("保存失败", e?.message ?? String(e));
    } finally {
      setSaving(false);
    }
  };

  const updateDraft = <K extends keyof AgentItem>(key: K, value: AgentItem[K]) => {
    if (!edit) return;
    setEdit({ ...edit, draft: { ...edit.draft, [key]: value } });
  };

  const pendingTarget = pendingDelete ? agents.find((a) => a.name === pendingDelete) : null;
  const pendingRefs = pendingTarget?.used_by ?? [];

  return (
    <div className="mx-auto w-full max-w-4xl px-5 py-6">
      {/* Header */}
      <div className="mb-5 flex items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">智能体</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">{agents.length} 个</p>
        </div>
        <Button onClick={startCreate}>
          <Plus className="h-4 w-4" />
          新建
        </Button>
      </div>

      {loadError && (
        <Card className="mb-4 border-destructive/40 bg-destructive/5 p-4">
          <p className="text-sm font-medium text-destructive">加载失败：{loadError}</p>
          <p className="mt-1.5 text-xs text-muted-foreground">
            常见原因：daemon 未重启（新 API 未生效）。请执行{" "}
            <code className="rounded bg-muted px-1 py-0.5 font-mono">autopilot daemon stop && autopilot daemon start</code> 后刷新页面。
          </p>
        </Card>
      )}

      {loading ? (
        <p className="text-sm text-muted-foreground">加载中…</p>
      ) : agents.length === 0 ? (
        <Card className="flex flex-col items-center gap-3 border-dashed bg-card/50 px-6 py-12 text-center">
          <p className="text-sm text-muted-foreground">暂无智能体</p>
          <Button onClick={startCreate}>
            <Plus className="h-4 w-4" />
            创建第一个智能体
          </Button>
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {agents.map((a) => (
            <Card key={a.name} className="p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="font-mono text-sm font-semibold text-primary">{a.name}</h3>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5 font-mono text-xs text-muted-foreground">
                    <span>{a.provider ?? "—"}</span>
                    {a.model && <span>/ {a.model}</span>}
                    {a.max_turns !== undefined && <span>· {a.max_turns} turns</span>}
                    {a.permission_mode && <span>· {a.permission_mode}</span>}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button size="sm" variant="secondary" onClick={() => setDryRunTarget(a)}>
                    <PlayCircle className="h-3.5 w-3.5" />
                    试跑
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => startEdit(a)}>
                    <Pencil className="h-3.5 w-3.5" />
                    编辑
                  </Button>
                  <Button size="sm" variant="destructive" onClick={() => setPendingDelete(a.name)}>
                    <Trash2 className="h-3.5 w-3.5" />
                    删除
                  </Button>
                </div>
              </div>

              {a.used_by && a.used_by.length > 0 && (
                <div className="mt-3 flex flex-wrap items-center gap-1.5">
                  <span className="text-xs text-muted-foreground">被引用：</span>
                  {a.used_by.map((wf) => (
                    <Badge key={wf} variant="secondary" className="font-mono font-normal">
                      {wf}
                    </Badge>
                  ))}
                </div>
              )}

              {a.system_prompt && (
                <p className="mt-3 line-clamp-3 whitespace-pre-wrap text-xs text-muted-foreground">
                  {a.system_prompt}
                </p>
              )}
            </Card>
          ))}
        </div>
      )}

      {/* 编辑 / 新建 Dialog */}
      <Dialog open={!!edit} onOpenChange={(v) => { if (!v) closeEdit(); }}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{edit?.original ? `编辑 ${edit.original}` : "新建智能体"}</DialogTitle>
            <DialogDescription>配置 agent 的提供商、模型与系统提示词。</DialogDescription>
          </DialogHeader>

          {edit && (
            <div className="max-h-[65vh] space-y-4 overflow-y-auto py-1 pr-1">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="agent-name">
                    名称 <span className="text-destructive">*</span>
                  </Label>
                  <Input
                    id="agent-name"
                    className="font-mono"
                    placeholder="coder"
                    value={edit.draft.name}
                    onChange={(e) => updateDraft("name", e.target.value)}
                    disabled={!!edit.original}
                  />
                  {edit.original && (
                    <p className="text-xs text-muted-foreground">改名请删除后重建</p>
                  )}
                </div>

                <div className="space-y-1.5">
                  <Label>
                    提供商 <span className="text-destructive">*</span>
                  </Label>
                  <Select
                    value={edit.draft.provider ?? ""}
                    onValueChange={(v) => updateDraft("provider", v)}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {PROVIDERS.map((p) => (
                        <SelectItem key={p} value={p}>{p}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="agent-model">模型（留空使用 provider 默认）</Label>
                  <Input
                    id="agent-model"
                    className="font-mono"
                    placeholder="claude-sonnet-4-6"
                    list={edit.draft.provider ? `agent-models-${edit.draft.provider}` : undefined}
                    value={edit.draft.model ?? ""}
                    onChange={(e) => updateDraft("model", e.target.value)}
                  />
                  {edit.draft.provider && models[edit.draft.provider] && (
                    <datalist id={`agent-models-${edit.draft.provider}`}>
                      {models[edit.draft.provider].models.map((m) => <option key={m} value={m} />)}
                    </datalist>
                  )}
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="agent-turns">最大轮数</Label>
                  <Input
                    id="agent-turns"
                    type="number"
                    min={1}
                    value={edit.draft.max_turns ?? 10}
                    onChange={(e) => updateDraft("max_turns", parseInt(e.target.value, 10) || 10)}
                  />
                </div>

                <div className="space-y-1.5">
                  <Label>权限模式</Label>
                  <Select
                    value={edit.draft.permission_mode ?? "auto"}
                    onValueChange={(v) => updateDraft("permission_mode", v)}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {PERMISSION_MODES.map((p) => (
                        <SelectItem key={p} value={p}>{p}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="agent-extends">继承自（可选）</Label>
                  <Input
                    id="agent-extends"
                    className="font-mono"
                    placeholder="留空默认继承同名"
                    value={(edit.draft.extends as string) ?? ""}
                    onChange={(e) => updateDraft("extends", e.target.value || undefined)}
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="agent-prompt">系统提示词</Label>
                <Textarea
                  id="agent-prompt"
                  className="min-h-[180px] font-mono text-xs"
                  placeholder="这里定义该智能体的基础角色提示词。调用时可追加 additional_system。"
                  value={edit.draft.system_prompt ?? ""}
                  onChange={(e) => updateDraft("system_prompt", e.target.value)}
                />
              </div>
            </div>
          )}

          <DialogFooter>
            <Button variant="secondary" onClick={closeEdit} disabled={saving}>
              取消
            </Button>
            <Button onClick={save} disabled={saving}>
              {saving ? "保存中…" : "保存"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除确认 */}
      <ConfirmDialog
        open={!!pendingDelete}
        title="删除智能体"
        message={
          <div className="space-y-2">
            <p>
              确认删除智能体 <code className="rounded bg-muted px-1 font-mono">{pendingDelete}</code>？此操作不可恢复。
            </p>
            {pendingRefs.length > 0 && (
              <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-2.5">
                <div className="flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-400">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  以下 {pendingRefs.length} 个工作流引用了此智能体，删除后这些工作流将无法运行：
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {pendingRefs.map((wf) => (
                    <Badge key={wf} variant="secondary" className="font-mono font-normal">{wf}</Badge>
                  ))}
                </div>
              </div>
            )}
          </div>
        }
        confirmText="删除"
        danger
        onConfirm={doDelete}
        onCancel={() => setPendingDelete(null)}
      />

      {/* 试跑 Dialog */}
      <AgentDryRunDialog
        open={!!dryRunTarget}
        onClose={() => setDryRunTarget(null)}
        agent={dryRunTarget}
      />
    </div>
  );
}
