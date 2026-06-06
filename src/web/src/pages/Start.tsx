import { useState, useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { Loader2, Plus } from "lucide-react";
import { api, type Project } from "@/hooks/useApi";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { useToast } from "@/components/Toast";

export function Start() {
  const navigate = useNavigate();
  const toast = useToast();

  const [projects, setProjects] = useState<Project[]>([]);
  const [loadingProjects, setLoadingProjects] = useState(false);
  const [projectId, setProjectId] = useState("");
  const [rawText, setRawText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  // P2 断点修复：首跑场景 projects 为空时，inline 建项目而不是把用户卡死在 disabled select
  const [newProjectName, setNewProjectName] = useState("");
  const [creatingProject, setCreatingProject] = useState(false);

  // 进入页面：拉 projects（工作区不再让用户选 —— 项目:工作区 1:1，后端按 project 自动派生）
  useEffect(() => {
    setLoadingProjects(true);
    api.listProjects()
      .then((ps) => {
        setProjects(ps);
        if (ps.length > 0) setProjectId(ps[0].id);
      })
      .catch((e: unknown) => toast.error("加载项目失败", (e as Error)?.message ?? String(e)))
      .finally(() => setLoadingProjects(false));
  }, [toast]);

  const canSubmit = useMemo(
    () => !submitting && !!projectId && rawText.trim().length > 0,
    [submitting, projectId, rawText],
  );

  async function handleCreateProject() {
    const name = newProjectName.trim();
    if (!name) return;
    setCreatingProject(true);
    try {
      const p = await api.createProject({ name });
      setProjects((prev) => [...prev, p]);
      setProjectId(p.id);
      setNewProjectName("");
      toast.success(`已创建项目「${p.name}」`);
    } catch (e: unknown) {
      toast.error("创建项目失败", (e as Error)?.message ?? String(e));
    } finally {
      setCreatingProject(false);
    }
  }

  async function handleSubmit() {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      // 不传 workspace_id：后端按 project 唯一工作区自动派生（项目:工作区 1:1）
      const { title, spec_md } = await api.extractRequirement({
        raw_text: rawText.trim(),
        project_id: projectId,
      });
      const requirement = await api.createRequirement({
        project_id: projectId,
        title,
        spec_md,
      });
      navigate(`/requirements/${requirement.id}`);
    } catch (e: unknown) {
      toast.error("创建需求失败", (e as Error)?.message ?? String(e));
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <header className="mb-4 border-b border-border pb-3">
        <h1 className="font-display text-2xl font-bold">开始 · START</h1>
        <p className="text-xs text-muted-foreground mt-1">
          说说你想做什么，AI 帮你整理成需求
        </p>
      </header>

      <div className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="project" className="bp-label">项目 *</Label>
          {!loadingProjects && projects.length === 0 ? (
            // 首跑空项目兜底：inline 一行创建，避免把用户卡死在 disabled select
            <div className="space-y-2 rounded-lg border border-accent/40 bg-accent/5 p-3">
              <p className="text-xs font-medium text-accent">
                还没有项目 · 先建一个
              </p>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={newProjectName}
                  onChange={(e) => setNewProjectName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && newProjectName.trim()) void handleCreateProject();
                  }}
                  placeholder="项目名（如 我的副业 / autopilot-demo）"
                  disabled={creatingProject}
                  className="flex-1 rounded-md border border-border bg-background px-2.5 py-1.5 text-sm focus:border-accent focus:outline-none"
                  autoFocus
                />
                <Button
                  variant="default"
                  size="sm"
                  disabled={creatingProject || !newProjectName.trim()}
                  onClick={() => void handleCreateProject()}
                  className="rounded-md text-[11px]"
                >
                  {creatingProject ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
                  {creatingProject ? "创建中..." : "创建并继续"}
                </Button>
              </div>
            </div>
          ) : (
            <Select value={projectId} onValueChange={setProjectId} disabled={loadingProjects || projects.length <= 1}>
              <SelectTrigger id="project">
                <SelectValue placeholder={loadingProjects ? "加载中..." : "选择项目"} />
              </SelectTrigger>
              <SelectContent>
                {projects.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name} <span className="text-muted-foreground ml-2">{p.id}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>

        <div className="space-y-2">
          <Label htmlFor="raw" className="bp-label">说说你想做什么</Label>
          <textarea
            id="raw"
            value={rawText}
            onChange={(e) => setRawText(e.target.value)}
            rows={12}
            placeholder="例如：给登录页加忘记密码功能。需要邮件重置..."
            className="w-full text-sm border border-border bg-background px-3 py-2 rounded-md focus:outline-none focus:border-accent"
          />
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button
            variant="default"
            size="default"
            disabled={!canSubmit}
            onClick={handleSubmit}
            className="rounded-md text-[11px]"
          >
            {submitting ? <Loader2 className="h-4 w-4 animate-spin mr-1.5" /> : null}
            {submitting ? "AI 整理中..." : "生成需求 →"}
          </Button>
        </div>
      </div>
    </div>
  );
}
