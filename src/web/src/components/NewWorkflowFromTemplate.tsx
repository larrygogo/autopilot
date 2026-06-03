import { useEffect, useState } from "react";
import { api, type WorkflowTemplate } from "@/hooks/useApi";
import { useToast } from "@/components/Toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

const FROM_SCRATCH = "__from_scratch__";
const FROM_AI = "__from_ai__";

interface Props {
  open: boolean;
  onCancel: () => void;
  /** 模板创建成功；调用方需重拉 workflow list */
  onCreated: (name: string) => void;
  /** 用户选了「从零开始」，调用方应该弹现有的 NewWorkflowDialog */
  onFromScratch: () => void;
  /** 用户选了「✨ 用 AI 创建」，调用方应该 navigate 到 /workflows/new-with-ai */
  onFromAI: () => void;
}

export function NewWorkflowFromTemplate({ open, onCancel, onCreated, onFromScratch, onFromAI }: Props) {
  const toast = useToast();
  const [templates, setTemplates] = useState<WorkflowTemplate[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<string>("");
  const [newName, setNewName] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    api.listWorkflowTemplates()
      .then((list) => {
        setTemplates(list);
        if (list.length > 0 && !selected) setSelected(list[0]!.name);
      })
      .catch((e: unknown) => toast.error("加载模板失败", (e as Error)?.message ?? String(e)))
      .finally(() => setLoading(false));
  }, [open, selected, toast]);

  // 模板切换时把建议名预填到输入框
  useEffect(() => {
    if (selected && selected !== FROM_SCRATCH && !newName) {
      setNewName(`my-${selected}`);
    }
  }, [selected, newName]);

  async function importFromFile(file: File | null) {
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as {
        version?: number;
        name?: string;
        yaml?: string;
        ts?: string | null;
      };
      if (typeof parsed.name !== "string" || typeof parsed.yaml !== "string") {
        toast.error("文件格式错误", "需要 { name, yaml, ts? } 字段");
        return;
      }
      const targetName = window.prompt("新工作流名（可改）", parsed.name) ?? parsed.name;
      if (!targetName.trim()) return;
      if (!/^[\w.\-]+$/.test(targetName.trim())) {
        toast.error("名字只允许字母 / 数字 / . _ -", "");
        return;
      }
      await api.importWorkflowBundle({
        name: targetName.trim(),
        yaml: parsed.yaml,
        ts: parsed.ts ?? null,
      });
      toast.success(`已从文件导入工作流 ${targetName.trim()}`);
      onCreated(targetName.trim());
    } catch (e: unknown) {
      toast.error("导入失败", (e as Error)?.message ?? String(e));
    }
  }

  async function handleCreate() {
    if (selected === FROM_AI) {
      onFromAI();
      return;
    }
    if (selected === FROM_SCRATCH) {
      onFromScratch();
      return;
    }
    if (!newName.trim()) {
      toast.error("请输入工作流名字", "");
      return;
    }
    if (!/^[\w.\-]+$/.test(newName.trim())) {
      toast.error("名字只允许字母 / 数字 / . _ -", "");
      return;
    }
    setSubmitting(true);
    try {
      await api.createWorkflowFromTemplate({ template: selected, name: newName.trim() });
      toast.success(`已从模板 ${selected} 创建 ${newName.trim()}`);
      onCreated(newName.trim());
      setNewName("");
    } catch (e: unknown) {
      toast.error("创建失败", (e as Error)?.message ?? String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onCancel(); }}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>新建工作流</DialogTitle>
          <DialogDescription>
            从内置模板克隆是最快的方式——你能在它上面调整 phases / agents。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-2">
            <Label className="bp-label">选择模板</Label>
            <div className="max-h-72 space-y-1.5 overflow-y-auto">
              {/* AI 生成入口放最前面，最显眼 */}
              <button
                type="button"
                onClick={() => setSelected(FROM_AI)}
                className={cn(
                  "block w-full rounded-md border px-3 py-2 text-left transition-colors",
                  selected === FROM_AI
                    ? "border-accent bg-accent/5"
                    : "border-border hover:border-foreground/60",
                )}
              >
                <span className="text-sm font-bold">✨ 用 AI 描述（推荐）</span>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  自然语言告诉 AI 你要的流程，AI 生成 yaml + ts
                </p>
              </button>

              <label
                className={cn(
                  "block w-full cursor-pointer rounded-md border px-3 py-2 text-left transition-colors",
                  "border-border hover:border-foreground/60",
                )}
              >
                <span className="text-sm font-bold">📦 从 JSON 文件导入</span>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  导入别人导出的 .workflow.json 文件（含 yaml + ts）
                </p>
                <input
                  type="file"
                  accept=".json,application/json"
                  className="hidden"
                  onChange={(e) => importFromFile(e.target.files?.[0] ?? null)}
                />
              </label>

              {loading && <p className="text-sm text-muted-foreground">加载中…</p>}
              {!loading && templates.length === 0 && (
                <p className="text-sm text-muted-foreground">未找到内置模板</p>
              )}
              {templates.map((t) => (
                <button
                  key={t.name}
                  type="button"
                  onClick={() => setSelected(t.name)}
                  className={cn(
                    "block w-full rounded-md border px-3 py-2 text-left transition-colors",
                    selected === t.name
                      ? "border-accent bg-accent/5"
                      : "border-border hover:border-foreground/60",
                  )}
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <div className="flex items-baseline gap-2 min-w-0">
                      <span className="text-sm font-bold truncate">{t.label || t.name}</span>
                      {t.label && (
                        <span className="font-mono text-[10px] text-muted-foreground truncate">
                          {t.name}
                        </span>
                      )}
                    </div>
                    <span className="font-mono text-[10px] text-muted-foreground shrink-0">
                      {t.phase_count} 阶段 · {t.agent_count} 智能体
                    </span>
                  </div>
                  <p className="mt-0.5 text-xs text-muted-foreground">{t.description || "（无描述）"}</p>
                </button>
              ))}

              <button
                type="button"
                onClick={() => setSelected(FROM_SCRATCH)}
                className={cn(
                  "block w-full rounded-md border border-dashed px-3 py-2 text-left transition-colors",
                  selected === FROM_SCRATCH
                    ? "border-accent bg-accent/5"
                    : "border-border hover:border-foreground/60",
                )}
              >
                <span className="text-sm font-bold">⊕ 从零开始（高级）</span>
                <p className="mt-0.5 text-xs text-muted-foreground">不基于模板，手工写所有 phases / agents</p>
              </button>
            </div>
          </div>

          {selected && selected !== FROM_SCRATCH && selected !== FROM_AI && (
            <div className="space-y-1.5">
              <Label htmlFor="wf-name" className="bp-label">
                新工作流名字
              </Label>
              <Input
                id="wf-name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="my-dev"
                className="font-mono"
              />
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onCancel} disabled={submitting}>取消</Button>
          <Button onClick={handleCreate} disabled={submitting || !selected}>
            {submitting
              ? "创建中..."
              : selected === FROM_AI
              ? "✨ 用 AI 描述 →"
              : selected === FROM_SCRATCH
              ? "下一步 →"
              : "创建"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
