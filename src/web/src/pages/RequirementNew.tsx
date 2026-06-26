/**
 * 深链预填新建需求页：/requirements/new?title=&spec=&workspace_url=&source=&external_ref=&callback_url=&callback_secret=&project=
 *
 * 设计：B 模式触发入口（见 selfhosted-autopilot-brain-design.md §6 步骤1）。
 * reqgenie（或任何外部系统）把表单要点编码进 URL query，用户在 autopilot 看到预填表单、
 * 点「创建需求」才真建（防止被任意链接刷需求）。
 */
import { useState, useEffect, useCallback } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { PageShell, FormField } from "@/components/pro";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { useToast } from "@/components/Toast";
import { api, type Workspace } from "@/hooks/useApi";

export function RequirementNew() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();

  // 从 URL query 读预填值
  const qTitle = searchParams.get("title") ?? "";
  const qSpec = searchParams.get("spec") ?? "";
  const qWorkspaceUrl = searchParams.get("workspace_url") ?? "";
  const qSource = searchParams.get("source") ?? null;
  const qExternalRef = searchParams.get("external_ref") ?? null;
  const qCallbackUrl = searchParams.get("callback_url") ?? null;
  const qCallbackSecret = searchParams.get("callback_secret") ?? null;
  const qProject = searchParams.get("project") ?? null;

  // 表单状态（预填可编辑）
  const [title, setTitle] = useState(qTitle);
  const [spec, setSpec] = useState(qSpec);
  const [workspaceUrl, setWorkspaceUrl] = useState(qWorkspaceUrl);

  // 加载 + 提交状态
  const [submitting, setSubmitting] = useState(false);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [loadingProject, setLoadingProject] = useState(true);

  // 加载 project id（优先用 query 指定，否则取第一个 project）
  useEffect(() => {
    if (qProject) {
      setProjectId(qProject);
      setLoadingProject(false);
      return;
    }
    // 取第一个 project（通常是 proj-default）
    api.listProjects()
      .then((ps) => {
        if (ps.length > 0) setProjectId(ps[0].id);
        else setProjectId("proj-default");
      })
      .catch(() => setProjectId("proj-default"))
      .finally(() => setLoadingProject(false));
  }, [qProject]);

  const handleSubmit = useCallback(async () => {
    if (!title.trim()) {
      toast.error("标题必填", "请填写需求标题");
      return;
    }
    if (!projectId) {
      toast.error("项目加载中", "请稍后再试");
      return;
    }

    setSubmitting(true);
    try {
      // 步骤 a：有 workspace_url 时找/建 workspace
      let workspaceId: string | null = null;
      const urlTrimmed = workspaceUrl.trim();
      if (urlTrimmed) {
        // 按 remote_url 找现有 workspace
        const all = await api.listWorkspaces();
        const existing = all.find((w: Workspace) => w.remote_url === urlTrimmed);
        if (existing) {
          workspaceId = existing.id;
        } else {
          // 不存在则新建：alias 取 URL 末段（去 .git 后缀）
          const rawAlias = urlTrimmed.replace(/\.git$/, "").split("/").pop() ?? "workspace";
          const ws = await api.createWorkspace({
            alias: rawAlias,
            remote_url: urlTrimmed,
            project_id: projectId,
          });
          workspaceId = ws.id;
        }
      }

      // 步骤 b：建需求
      const req = await api.createRequirement({
        project_id: projectId,
        title: title.trim(),
        spec_md: spec.trim(),
        source: qSource,
        external_ref: qExternalRef,
        callback_url: qCallbackUrl,
        callback_secret: qCallbackSecret,
      });

      // 步骤 c：有 workspace 时绑定
      if (workspaceId) {
        await api.setRequirementWorkspaces(req.id, [workspaceId]);
      }

      // 步骤 d：跳转需求详情
      navigate(`/requirements/${req.id}`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error("创建需求失败", msg);
    } finally {
      setSubmitting(false);
    }
  }, [title, spec, workspaceUrl, projectId, qSource, qExternalRef, qCallbackUrl, qCallbackSecret, toast, navigate]);

  const hasSource = !!qSource;

  return (
    <PageShell
      width="form"
      hero={{ title: "新建需求", subtitle: hasSource ? `来自 ${qSource}` : undefined }}
      loading={loadingProject}
    >
      <div className="space-y-6">
        {/* 来源提示条（仅 source 有值时显示） */}
        {hasSource && (
          <div className="rounded-lg border border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
            此需求由 <span className="font-medium text-foreground">{qSource}</span> 触发预填。
            请确认内容后点「创建需求」——点击前不会建任何东西。
          </div>
        )}

        <FormField label="标题" required htmlFor="req-title">
          <Input
            id="req-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="一句话描述需求"
            aria-invalid={!title.trim() ? true : undefined}
          />
        </FormField>

        <FormField
          label="规约"
          htmlFor="req-spec"
          hint="详细描述需求背景、验收标准等（可选，建需求后仍可补充）"
        >
          <Textarea
            id="req-spec"
            value={spec}
            onChange={(e) => setSpec(e.target.value)}
            placeholder="背景、验收标准、参考资料…"
            rows={8}
          />
        </FormField>

        <FormField
          label="代码库 URL"
          htmlFor="req-workspace-url"
          hint="填 Git remote URL（如 https://github.com/org/repo）；留空则不绑定代码库"
        >
          <Input
            id="req-workspace-url"
            value={workspaceUrl}
            onChange={(e) => setWorkspaceUrl(e.target.value)}
            placeholder="https://github.com/org/repo"
          />
        </FormField>

        <div className="flex items-center gap-3 pt-2">
          <Button
            onClick={handleSubmit}
            disabled={submitting || !title.trim()}
            className="min-w-[120px]"
          >
            {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {submitting ? "创建中…" : "创建需求"}
          </Button>
          <Button variant="ghost" onClick={() => navigate(-1)} disabled={submitting}>
            取消
          </Button>
        </div>
      </div>
    </PageShell>
  );
}
