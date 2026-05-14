import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Loader2, AlertTriangle } from "lucide-react";
import { api, type AuthoredWorkflow } from "@/hooks/useApi";
import { useToast } from "@/components/Toast";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";

export function NewWorkflowWithAI() {
  const navigate = useNavigate();
  const toast = useToast();

  const [description, setDescription] = useState("");
  const [authored, setAuthored] = useState<AuthoredWorkflow | null>(null);
  const [editName, setEditName] = useState("");
  const [followup, setFollowup] = useState("");
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);

  async function generate(prompt: string, includePrior: boolean) {
    if (!prompt.trim()) {
      toast.error("请描述工作流", "");
      return;
    }
    setGenerating(true);
    try {
      const result = await api.authorWorkflow({
        description: prompt.trim(),
        prior_yaml: includePrior ? authored?.yaml : undefined,
        prior_ts: includePrior ? authored?.ts : undefined,
      });
      setAuthored(result);
      if (!editName) setEditName(result.name);
      setFollowup("");
      if (result.warnings.length > 0) {
        toast.error("生成有警告", result.warnings.join("\n"));
      }
    } catch (e: unknown) {
      toast.error("生成失败", (e as Error)?.message ?? String(e));
    } finally {
      setGenerating(false);
    }
  }

  async function save() {
    if (!authored) return;
    if (!editName.trim()) {
      toast.error("请输入工作流名字", "");
      return;
    }
    if (!/^[\w.\-]+$/.test(editName.trim())) {
      toast.error("名字只允许字母 / 数字 / . _ -", "");
      return;
    }
    setSaving(true);
    try {
      await api.saveAuthoredWorkflow({
        name: editName.trim(),
        yaml: authored.yaml,
        ts: authored.ts,
      });
      toast.success(`已创建工作流 ${editName.trim()}`);
      navigate("/settings?tab=workflows");
    } catch (e: unknown) {
      toast.error("保存失败", (e as Error)?.message ?? String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-6 md:px-6 md:py-8">
      <header className="mb-4 border-b-[1.5px] border-foreground/30 pb-3">
        <h1 className="font-display text-2xl font-bold uppercase tracking-wider">
          ✨ AI 生成工作流
        </h1>
        <p className="font-mono text-xs uppercase tracking-[0.12em] text-muted-foreground mt-1">
          描述你想要的流程，AI 生成 yaml + ts；可继续追问调整
        </p>
      </header>

      {/* 描述区 */}
      <Card className="mb-4 p-4">
        <div className="space-y-2">
          <Label htmlFor="desc" className="font-mono text-[10px] uppercase tracking-[0.18em]">
            描述你要的工作流
          </Label>
          <Textarea
            id="desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={6}
            placeholder="例如：完整后端开发流程——先理需求 → 设计 → 写代码 → 跑测试 → 提 PR；测试失败可回到写代码阶段重试"
            className="font-mono text-sm"
            disabled={generating || saving}
          />
          <div className="flex justify-end">
            <Button
              onClick={() => generate(description, false)}
              disabled={generating || saving || !description.trim()}
              className="rounded-none font-mono text-[11px] uppercase tracking-[0.12em]"
            >
              {generating ? <Loader2 className="h-4 w-4 animate-spin mr-1.5" /> : null}
              {generating ? "AI 整理中..." : authored ? "重新生成" : "✨ 生成工作流"}
            </Button>
          </div>
        </div>
      </Card>

      {/* 生成结果 */}
      {authored && (
        <>
          {authored.warnings.length > 0 && (
            <Card className="mb-4 border-warning/40 bg-warning/5 p-3">
              <div className="flex gap-2">
                <AlertTriangle className="h-4 w-4 shrink-0 text-warning" />
                <div className="text-xs">
                  <div className="font-bold text-warning">生成警告：</div>
                  <ul className="mt-1 list-inside list-disc text-muted-foreground">
                    {authored.warnings.map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                </div>
              </div>
            </Card>
          )}

          <Card className="mb-4 p-4">
            <div className="mb-3 space-y-1.5">
              <Label htmlFor="wf-name" className="font-mono text-[10px] uppercase tracking-[0.18em]">
                工作流名字
              </Label>
              <Input
                id="wf-name"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                placeholder="my-backend-dev"
                className="font-mono"
                disabled={saving}
              />
              {authored.description && (
                <p className="text-xs text-muted-foreground">{authored.description}</p>
              )}
            </div>

            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <div>
                <Label className="font-mono text-[10px] uppercase tracking-[0.18em]">
                  workflow.yaml
                </Label>
                <pre className="mt-1 max-h-96 overflow-auto border-[1.5px] border-foreground/30 bg-card p-2 font-mono text-[11px]">
                  {authored.yaml}
                </pre>
              </div>
              <div>
                <Label className="font-mono text-[10px] uppercase tracking-[0.18em]">
                  workflow.ts
                </Label>
                <pre className="mt-1 max-h-96 overflow-auto border-[1.5px] border-foreground/30 bg-card p-2 font-mono text-[11px]">
                  {authored.ts}
                </pre>
              </div>
            </div>
          </Card>

          <Card className="mb-4 p-4">
            <Label htmlFor="followup" className="font-mono text-[10px] uppercase tracking-[0.18em]">
              继续调整（追问）
            </Label>
            <Textarea
              id="followup"
              value={followup}
              onChange={(e) => setFollowup(e.target.value)}
              rows={3}
              placeholder="例如：加一个 lint phase 在 test 之前"
              className="mt-1 font-mono text-sm"
              disabled={generating || saving}
            />
            <div className="mt-3 flex justify-between gap-2">
              <Button
                variant="ghost"
                onClick={() => navigate("/settings?tab=workflows")}
                disabled={saving || generating}
              >
                取消
              </Button>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  onClick={() => generate(followup, true)}
                  disabled={generating || saving || !followup.trim()}
                  className="rounded-none font-mono text-[11px] uppercase tracking-[0.12em]"
                >
                  {generating ? <Loader2 className="h-4 w-4 animate-spin mr-1.5" /> : null}
                  {generating ? "调整中..." : "应用追问"}
                </Button>
                <Button
                  onClick={save}
                  disabled={generating || saving || !editName.trim()}
                  className="rounded-none font-mono text-[11px] uppercase tracking-[0.12em]"
                >
                  {saving ? "保存中..." : "✓ 确认创建"}
                </Button>
              </div>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
