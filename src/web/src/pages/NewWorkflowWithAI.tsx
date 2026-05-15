import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Loader2, AlertTriangle, MousePointerClick } from "lucide-react";
import { parse as parseYaml } from "yaml";
import { api, type AuthoredWorkflow } from "@/hooks/useApi";
import { useToast } from "@/components/Toast";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { PhasePipeline } from "@/components/PhasePipeline";
import { PhaseDetailDrawer, type DrawerPhaseInfo } from "@/components/PhaseDetailDrawer";
import { extractPhaseFunction } from "@/lib/ts-extract";

export function NewWorkflowWithAI() {
  const navigate = useNavigate();
  const toast = useToast();

  const [description, setDescription] = useState("");
  const [authored, setAuthored] = useState<AuthoredWorkflow | null>(null);
  const [editName, setEditName] = useState("");
  const [followup, setFollowup] = useState("");
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [drawerPhase, setDrawerPhase] = useState<DrawerPhaseInfo | null>(null);

  // 把 AI 生成的 yaml 解析成 phases 数组，喂给 PhasePipeline。
  // 解析失败时 phases 为空，UI 会显示空态而不是崩溃。
  const parsedPhases = useMemo<unknown[]>(() => {
    if (!authored?.yaml) return [];
    try {
      const doc = parseYaml(authored.yaml) as { phases?: unknown[] } | null;
      return Array.isArray(doc?.phases) ? doc!.phases : [];
    } catch {
      return [];
    }
  }, [authored?.yaml]);

  const phasesByName = useMemo(() => {
    const map = new Map<string, Record<string, unknown>>();
    for (const p of parsedPhases) {
      if (!p || typeof p !== "object") continue;
      const obj = p as Record<string, unknown>;
      if (obj.parallel && typeof obj.parallel === "object") {
        const par = obj.parallel as Record<string, unknown>;
        const subs = Array.isArray(par.phases) ? (par.phases as Array<Record<string, unknown>>) : [];
        for (const s of subs) {
          if (s && typeof s.name === "string") map.set(s.name, s);
        }
      } else if (typeof obj.name === "string") {
        map.set(obj.name, obj);
      }
    }
    return map;
  }, [parsedPhases]);

  function openDrawerFor(phaseName: string) {
    const raw = phasesByName.get(phaseName);
    if (!raw) return;
    setDrawerPhase({
      name: phaseName,
      label: typeof raw.label === "string" ? raw.label : undefined,
      agent: typeof raw.agent === "string" ? raw.agent : undefined,
      timeout: typeof raw.timeout === "number" ? raw.timeout : undefined,
      reject: typeof raw.reject === "string" ? raw.reject : null,
      gate: raw.gate === true,
      gate_message: typeof raw.gate_message === "string" ? raw.gate_message : undefined,
      max_rejections: typeof raw.max_rejections === "number" ? raw.max_rejections : undefined,
    });
  }

  const drawerTsCode = useMemo(() => {
    if (!drawerPhase || !authored?.ts) return null;
    return extractPhaseFunction(authored.ts, drawerPhase.name);
  }, [drawerPhase, authored?.ts]);

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
      navigate("/workflows");
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

            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <Label className="font-mono text-[10px] uppercase tracking-[0.18em]">
                  流水线预览
                </Label>
                <span className="inline-flex items-center gap-1 font-mono text-[10px] text-muted-foreground">
                  <MousePointerClick className="h-3 w-3" />
                  点击阶段查看配置
                </span>
              </div>
              {parsedPhases.length > 0 ? (
                <PhasePipeline
                  phases={parsedPhases}
                  onPhaseClick={openDrawerFor}
                />
              ) : (
                <p className="border-[1.5px] border-dashed border-foreground/30 bg-muted/30 p-3 text-xs text-muted-foreground">
                  yaml 解析失败或没有 phases；请检查警告区，或追问让 AI 调整。
                </p>
              )}
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
                onClick={() => navigate("/workflows")}
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

      <PhaseDetailDrawer
        mode="preview"
        open={!!drawerPhase}
        onOpenChange={(o) => { if (!o) setDrawerPhase(null); }}
        phase={drawerPhase}
        tsFunctionCode={drawerTsCode}
      />
    </div>
  );
}
