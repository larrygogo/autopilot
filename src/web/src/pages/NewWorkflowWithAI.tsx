import { useMemo, useRef, useState } from "react";
import { PageHero } from "@/components/PageHero";
import { PAGE_W_FORM } from "@/lib/layout";
import { useNavigate } from "react-router-dom";
import { Loader2, AlertTriangle, ChevronDown, ChevronRight } from "lucide-react";
import { parse as parseYaml, parseDocument } from "yaml";
import { api, type AuthoredWorkflow } from "@/hooks/useApi";
import { useToast } from "@/components/Toast";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { PhaseEditor } from "@/components/PhaseEditor";

export function NewWorkflowWithAI() {
  const navigate = useNavigate();
  const toast = useToast();

  const [description, setDescription] = useState("");
  const [authored, setAuthored] = useState<AuthoredWorkflow | null>(null);
  const [editName, setEditName] = useState("");
  const [followup, setFollowup] = useState("");
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  /** YAML/TS 文本编辑折叠区，默认收起；给"我要看 yaml 原文"的用户出口 */
  const [editorOpen, setEditorOpen] = useState(false);
  /** 编辑器 anchor — scroll target */
  const editorAnchorRef = useRef<HTMLDivElement | null>(null);

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

  // 识别后端 fallback（AI 调用挂了、返回非法 JSON 等）— 此时 yaml/ts 是占位 stub，
  // 用户不应该能保存这种垃圾工作流。一律走"重新生成"或"追问"路径。
  const isFallback = useMemo(
    () => !!authored?.warnings?.some((w) => w.startsWith("AI 生成失败") || w.startsWith("缺 yaml") || w.startsWith("AI 返回")),
    [authored?.warnings],
  );

  /**
   * PhaseEditor 草稿模式回调：把图形化编辑后的 phases 数组写回 authored.yaml。
   * 用 yaml Document API 局部替换 phases 字段，保留其他顶层字段 + 注释 + 格式。
   */
  function applyPhasesToYaml(newPhases: unknown[]) {
    if (!authored) return;
    try {
      const doc = parseDocument(authored.yaml);
      doc.set("phases", newPhases);
      setAuthored({ ...authored, yaml: doc.toString() });
    } catch (e: unknown) {
      // 极端情况：原 yaml 已不可解析（用户在文本编辑区破坏了）
      toast.error("应用阶段修改失败", (e as Error)?.message ?? String(e));
    }
  }

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
    <div className={PAGE_W_FORM}>
      <PageHero
        title="AI 生成工作流"
        subtitle="描述你想要的流程，AI 生成 yaml + ts；可继续追问调整"
      />

      {/* 描述区 */}
      <Card className="mb-4 p-4">
        <div className="space-y-2">
          <Label htmlFor="desc" className="font-mono text-[10px] ">
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
              className="rounded-md font-mono text-[11px] "
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
              <Label htmlFor="wf-name" className="font-mono text-[10px] ">
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
              <Label className="font-mono text-[10px] ">
                阶段（可直接编辑）
              </Label>
              {parsedPhases.length > 0 ? (
                // 复用 /workflows 的 PhaseEditor，draftMode 关闭所有持久化 API 调用，
                // 改动通过 onItemsChange 上抛 → applyPhasesToYaml 回写 authored.yaml
                // （用 yaml Document API 局部替换 phases 字段，保留其他顶层字段 + 注释）
                <PhaseEditor
                  workflowName="__draft__"
                  initialPhases={parsedPhases}
                  draftMode
                  onItemsChange={applyPhasesToYaml}
                />
              ) : (
                <p className="border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
                  yaml 解析失败或没有 phases；请检查警告区，或追问让 AI 调整。
                </p>
              )}
            </div>
          </Card>

          {/* YAML/TS 直接编辑（高级）— 给"我要精确改一个字段，不想 AI 再跑一轮"的用户出口；
              改完 PhasePipeline 会从 authored.yaml 实时 re-parse */}
          <Card className="mb-4" ref={editorAnchorRef as unknown as React.RefObject<HTMLDivElement>}>
            <button
              type="button"
              onClick={() => setEditorOpen((v) => !v)}
              className="flex w-full items-center gap-2 border-b border-border px-4 py-2.5 text-left transition-colors hover:bg-muted/30"
              aria-expanded={editorOpen}
            >
              {editorOpen ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
              <span className="font-mono text-[10px] text-muted-foreground">
                直接编辑 YAML / TS · 高级
              </span>
              <span className="ml-2 font-mono text-[10px] text-muted-foreground/70">
                改完实时刷新上方预览
              </span>
            </button>
            {editorOpen && (
              <div className="space-y-3 p-4">
                <div className="space-y-1.5">
                  <Label htmlFor="edit-yaml" className="font-mono text-[10px] ">
                    workflow.yaml
                  </Label>
                  <Textarea
                    id="edit-yaml"
                    value={authored.yaml}
                    onChange={(e) => setAuthored({ ...authored, yaml: e.target.value })}
                    rows={Math.min(20, Math.max(8, authored.yaml.split("\n").length + 1))}
                    className="font-mono text-xs"
                    disabled={saving || generating}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="edit-ts" className="font-mono text-[10px] ">
                    workflow.ts <span className="ml-1 text-muted-foreground">（零代码模式留空）</span>
                  </Label>
                  <Textarea
                    id="edit-ts"
                    value={authored.ts}
                    onChange={(e) => setAuthored({ ...authored, ts: e.target.value })}
                    rows={Math.min(20, Math.max(4, authored.ts.split("\n").length + 1))}
                    className="font-mono text-xs"
                    disabled={saving || generating}
                  />
                </div>
              </div>
            )}
          </Card>

          <Card className="mb-4 p-4">
            <Label htmlFor="followup" className="font-mono text-[10px] ">
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
                  className="rounded-md font-mono text-[11px] "
                >
                  {generating ? <Loader2 className="h-4 w-4 animate-spin mr-1.5" /> : null}
                  {generating ? "调整中..." : "应用追问"}
                </Button>
                <Button
                  onClick={save}
                  disabled={generating || saving || !editName.trim() || isFallback}
                  title={isFallback ? "AI 生成失败，请先重新生成或追问让 AI 重出方案" : undefined}
                  className="rounded-md font-mono text-[11px] "
                >
                  {saving ? "保存中..." : isFallback ? "✗ AI 失败，请重试" : "✓ 确认创建"}
                </Button>
              </div>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
