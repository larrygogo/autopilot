import React, { useEffect, useState } from "react";
import { Plus, Pencil, Trash2, ExternalLink, AlertTriangle } from "lucide-react";
import { api } from "../hooks/useApi";
import { useToast } from "./Toast";
import { ConfirmDialog } from "./Modal";
import { WorkflowAgentDialog, type WorkflowAgentDraft } from "./WorkflowAgentDialog";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

interface Props {
  workflowName: string;
  /** 工作流详情里的 agents 数组 */
  initialAgents: any[];
  /** 保存后通知父组件刷新详情 */
  onSaved?: () => void;
  /** 可选：点击卡片跳到全局 agent 编辑 */
  onJumpToAgent?: (name: string) => void;
}

export function WorkflowAgentsEditor({
  workflowName,
  initialAgents,
  onSaved,
  onJumpToAgent,
}: Props) {
  const toast = useToast();
  const [items, setItems] = useState<WorkflowAgentDraft[]>(() => normalize(initialAgents));
  const [globalAgentNames, setGlobalAgentNames] = useState<string[]>([]);
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<{ idx: number; name: string } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setItems(normalize(initialAgents));
  }, [JSON.stringify(initialAgents), workflowName]);

  useEffect(() => {
    api
      .listAgents()
      .then((list) => setGlobalAgentNames(list.map((a) => a.name)))
      .catch(() => {});
  }, []);

  const persist = async (next: WorkflowAgentDraft[]) => {
    setSaving(true);
    try {
      await api.setWorkflowAgents(workflowName, next);
      setItems(next);
      toast.success("已保存");
      onSaved?.();
    } catch (e: any) {
      toast.error("保存失败", e?.message ?? String(e));
      throw e;
    } finally {
      setSaving(false);
    }
  };

  const onAdd = async (draft: WorkflowAgentDraft) => {
    const next = [...items, draft];
    try {
      await persist(next);
      setAddOpen(false);
    } catch {
      /* 对话框保持打开 */
    }
  };

  const onUpdate = async (draft: WorkflowAgentDraft) => {
    if (editingIdx === null) return;
    const next = items.map((it, i) => (i === editingIdx ? draft : it));
    try {
      await persist(next);
      setEditingIdx(null);
    } catch {
      /* 对话框保持打开 */
    }
  };

  const doDelete = async () => {
    if (!pendingDelete) return;
    const next = items.filter((_, i) => i !== pendingDelete.idx);
    try {
      await persist(next);
    } finally {
      setPendingDelete(null);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold">使用的智能体</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {items.length === 0
              ? "未覆盖（仅用全局 agents）"
              : `${items.length} 个工作流内覆盖`}
          </p>
        </div>
        <Button size="sm" onClick={() => setAddOpen(true)} disabled={saving}>
          <Plus className="h-3.5 w-3.5" />
          添加
        </Button>
      </div>

      {items.length === 0 ? (
        <Card className="border-dashed bg-card/50 px-4 py-6 text-center">
          <p className="text-xs text-muted-foreground">
            该工作流未定义覆盖，运行时直接使用全局 agents。点击「添加」在此工作流内覆盖某个 agent
            的字段。
          </p>
        </Card>
      ) : (
        <div className="flex flex-col gap-2.5">
          {items.map((a, idx) => {
            const overrides: string[] = [];
            if (a.provider) overrides.push(`provider=${a.provider}`);
            if (a.model) overrides.push(`model=${a.model}`);
            if (typeof a.max_turns === "number") overrides.push(`max_turns=${a.max_turns}`);
            if (a.permission_mode) overrides.push(`permission=${a.permission_mode}`);
            if (a.system_prompt) overrides.push("system_prompt");

            const baseName = a.extends ?? a.name;
            const baseExists = globalAgentNames.includes(baseName);

            return (
              <Card key={idx} className="p-3.5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <h4 className="font-mono text-sm font-semibold text-primary">{a.name}</h4>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5 font-mono text-xs text-muted-foreground">
                      <span>继承自 {a.extends ?? a.name}</span>
                      {!baseExists && (
                        <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400">
                          <AlertTriangle className="h-3 w-3" />
                          全局未定义
                        </span>
                      )}
                    </div>
                    {overrides.length > 0 && (
                      <div className="mt-2 flex flex-wrap items-center gap-1.5">
                        <span className="text-xs text-muted-foreground">覆盖：</span>
                        {overrides.map((o) => (
                          <Badge key={o} variant="secondary" className="font-mono font-normal">
                            {o}
                          </Badge>
                        ))}
                      </div>
                    )}
                    {a.system_prompt && (
                      <p className="mt-2 line-clamp-3 whitespace-pre-wrap text-xs text-muted-foreground">
                        {a.system_prompt.length > 140
                          ? a.system_prompt.slice(0, 140) + "…"
                          : a.system_prompt}
                      </p>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {onJumpToAgent && baseExists && (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => onJumpToAgent(baseName)}
                        title="跳到全局 agent 编辑"
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                        全局
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => setEditingIdx(idx)}
                      disabled={saving}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                      编辑
                    </Button>
                    <Button
                      size="sm"
                      variant="destructive"
                      onClick={() => setPendingDelete({ idx, name: a.name })}
                      disabled={saving}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      删除
                    </Button>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      <WorkflowAgentDialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onSubmit={onAdd}
        globalAgentNames={globalAgentNames}
        existingOtherNames={items.map((a) => a.name)}
      />

      <WorkflowAgentDialog
        open={editingIdx !== null}
        onClose={() => setEditingIdx(null)}
        onSubmit={onUpdate}
        initial={editingIdx !== null ? items[editingIdx] : undefined}
        globalAgentNames={globalAgentNames}
        existingOtherNames={items.filter((_, i) => i !== editingIdx).map((a) => a.name)}
      />

      <ConfirmDialog
        open={!!pendingDelete}
        title="删除智能体覆盖"
        message={
          <span>
            删除工作流内 <code className="rounded bg-muted px-1 font-mono">{pendingDelete?.name}</code>{" "}
            的覆盖？
            <br />
            <span className="text-xs text-muted-foreground">
              删除后，此工作流将直接使用全局同名 agent（如存在）。
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

function normalize(raw: any[] | undefined): WorkflowAgentDraft[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((a) => ({
    name: a?.name ?? "",
    extends: a?.extends ?? undefined,
    provider: a?.provider ?? undefined,
    model: a?.model ?? undefined,
    max_turns: typeof a?.max_turns === "number" ? a.max_turns : undefined,
    permission_mode: a?.permission_mode ?? undefined,
    system_prompt: a?.system_prompt ?? undefined,
  }));
}
