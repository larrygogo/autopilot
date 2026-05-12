import React, { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowLeft, Layers, FolderGit2, Inbox, Plus, RefreshCw, ExternalLink,
  FolderOpen, Trash2, Pencil, Activity,
} from "lucide-react";
import { api, type Project, type Codebase, type Requirement, type RepoHealthResult } from "@/hooks/useApi";
import { useToast } from "@/components/Toast";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
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
import { FolderPicker } from "@/components/FolderPicker";
import { cn } from "@/lib/utils";

interface ProjectDetailProps {
  projectId: string;
}

const STATUS_LABEL: Record<string, string> = {
  drafting: "草稿",
  clarifying: "澄清中",
  ready: "已澄清",
  investigating: "调查中",
  awaiting_approval: "待审批",
  queued: "排队中",
  running: "执行中",
  awaiting_review: "待 PR review",
  fix_revision: "修复中",
  done: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

const STATUS_VARIANT: Record<
  string,
  "default" | "secondary" | "destructive" | "outline" | "success" | "warning" | "info" | "muted"
> = {
  drafting: "outline",
  clarifying: "info",
  ready: "success",
  investigating: "info",
  awaiting_approval: "warning",
  queued: "secondary",
  running: "info",
  awaiting_review: "warning",
  fix_revision: "warning",
  done: "success",
  failed: "destructive",
  cancelled: "muted",
};

interface CbForm {
  alias: string;
  path: string;
  default_branch: string;
  github_owner: string;
  github_repo: string;
}

const EMPTY_CB: CbForm = { alias: "", path: "", default_branch: "main", github_owner: "", github_repo: "" };

type HealthState = "loading" | RepoHealthResult;

export function ProjectDetail({ projectId }: ProjectDetailProps) {
  const navigate = useNavigate();
  const toast = useToast();

  const [project, setProject] = useState<Project | null>(null);
  const [codebases, setCodebases] = useState<Codebase[]>([]);
  const [requirements, setRequirements] = useState<Requirement[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // 新建需求 dialog
  const [reqDialogOpen, setReqDialogOpen] = useState(false);
  const [reqTitle, setReqTitle] = useState("");
  const [savingReq, setSavingReq] = useState(false);

  // 新建 / 编辑代码库 dialog
  const [cbDialogOpen, setCbDialogOpen] = useState(false);
  const [editingCb, setEditingCb] = useState<Codebase | null>(null);
  const [cbForm, setCbForm] = useState<CbForm>(EMPTY_CB);
  const [savingCb, setSavingCb] = useState(false);
  const [folderPickerOpen, setFolderPickerOpen] = useState(false);
  const [deletingCbId, setDeletingCbId] = useState<string | null>(null);

  // 健康检查
  const [healthMap, setHealthMap] = useState<Record<string, HealthState>>({});

  const autoCheckHealth = useCallback((cbs: Codebase[]) => {
    if (cbs.length === 0) return;
    setHealthMap((prev) => {
      const next = { ...prev };
      for (const cb of cbs) next[cb.id] = "loading";
      return next;
    });
    for (const cb of cbs) {
      api.healthcheckRepo(cb.id)
        .then((result) => setHealthMap((prev) => ({ ...prev, [cb.id]: result })))
        .catch(() => setHealthMap((prev) => { const n = { ...prev }; delete n[cb.id]; return n; }));
    }
  }, []);

  const refresh = useCallback(() => {
    setLoading(true);
    setLoadError(null);
    Promise.all([
      api.getProject(projectId),
      api.listProjectCodebases(projectId),
      api.listProjectRequirements(projectId),
    ])
      .then(([proj, cbs, reqs]) => {
        setProject(proj);
        setCodebases(cbs);
        setRequirements(reqs);
        autoCheckHealth(cbs);
      })
      .catch((e: unknown) => setLoadError((e as Error)?.message ?? String(e)))
      .finally(() => setLoading(false));
  }, [projectId, autoCheckHealth]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // ── 需求 ──────────────────────────────────────

  const openReqDialog = () => {
    setReqTitle("");
    setReqDialogOpen(true);
  };

  const closeReqDialog = () => {
    if (savingReq) return;
    setReqDialogOpen(false);
  };

  const createRequirement = async () => {
    const title = reqTitle.trim();
    if (!title) {
      toast.error("验证失败", "需求标题不能为空");
      return;
    }
    setSavingReq(true);
    try {
      const req = await api.createRequirement({ project_id: projectId, title });
      toast.success(`已创建需求「${title}」`);
      setReqDialogOpen(false);
      navigate(`/requirements/${req.id}`);
    } catch (e: unknown) {
      toast.error("创建失败", (e as Error)?.message ?? String(e));
    } finally {
      setSavingReq(false);
    }
  };

  // ── 代码库 ────────────────────────────────────

  const openCbDialog = (cb?: Codebase) => {
    if (cb) {
      setEditingCb(cb);
      setCbForm({
        alias: cb.alias,
        path: cb.path,
        default_branch: cb.default_branch,
        github_owner: cb.github_owner ?? "",
        github_repo: cb.github_repo ?? "",
      });
    } else {
      setEditingCb(null);
      setCbForm(EMPTY_CB);
    }
    setCbDialogOpen(true);
  };

  const closeCbDialog = () => {
    if (savingCb) return;
    setCbDialogOpen(false);
    setEditingCb(null);
  };

  const saveCb = async () => {
    const alias = cbForm.alias.trim();
    const path = cbForm.path.trim();
    if (!alias) { toast.error("验证失败", "别名不能为空"); return; }
    if (!path) { toast.error("验证失败", "路径不能为空"); return; }
    setSavingCb(true);
    try {
      if (editingCb) {
        await api.updateRepo(editingCb.id, {
          path,
          default_branch: cbForm.default_branch.trim() || "main",
          github_owner: cbForm.github_owner.trim() || null,
          github_repo: cbForm.github_repo.trim() || null,
        });
        toast.success(`已更新代码库「${alias}」`);
      } else {
        await api.createProjectCodebase(projectId, {
          alias,
          path,
          default_branch: cbForm.default_branch.trim() || "main",
          github_owner: cbForm.github_owner.trim() || null,
          github_repo: cbForm.github_repo.trim() || null,
        });
        toast.success(`已添加代码库「${alias}」`);
      }
      setCbDialogOpen(false);
      setEditingCb(null);
      refresh();
    } catch (e: unknown) {
      toast.error(editingCb ? "更新失败" : "创建失败", (e as Error)?.message ?? String(e));
    } finally {
      setSavingCb(false);
    }
  };

  const removeCb = async (cb: Codebase) => {
    if (!confirm(`确定移除代码库「${cb.alias}」？\n\n注意：仍有未完成需求关联该代码库时，删除可能影响正在进行的任务。`)) return;
    setDeletingCbId(cb.id);
    try {
      await api.deleteCodebase(cb.id);
      toast.success(`已移除代码库「${cb.alias}」`);
      refresh();
    } catch (e: unknown) {
      toast.error("删除失败", (e as Error)?.message ?? String(e));
    } finally {
      setDeletingCbId(null);
    }
  };

  const checkHealth = async (cb: Codebase) => {
    setHealthMap((prev) => ({ ...prev, [cb.id]: "loading" }));
    try {
      const result = await api.healthcheckRepo(cb.id);
      setHealthMap((prev) => ({ ...prev, [cb.id]: result }));
    } catch (e: unknown) {
      toast.error("健康检查失败", (e as Error)?.message ?? String(e));
      setHealthMap((prev) => { const n = { ...prev }; delete n[cb.id]; return n; });
    }
  };

  const renderHealth = (cb: Codebase) => {
    const h = healthMap[cb.id];
    if (!h) return null;
    if (h === "loading") return <span className="text-[11px] text-muted-foreground animate-pulse">检查中…</span>;
    if (h.healthy) return <span className="font-mono text-[11px] text-success font-medium tracking-wider">✓ OK</span>;
    return (
      <span className="text-[11px] text-destructive" title={h.issues.join("\n")}>
        ✗ {h.issues[0] ?? "异常"}
      </span>
    );
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <RefreshCw className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="mx-auto max-w-5xl p-4 md:p-6">
        <Button variant="ghost" size="sm" className="mb-4" onClick={() => navigate("/projects")}>
          <ArrowLeft className="h-4 w-4" />
          返回项目列表
        </Button>
        <Card className="border-destructive/50 p-4">
          <p className="text-sm text-destructive">加载失败：{loadError}</p>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-4 md:p-6">
      {/* 顶部导航 */}
      <Button
        variant="ghost"
        size="sm"
        className="-ml-2"
        onClick={() => navigate("/projects")}
      >
        <ArrowLeft className="h-4 w-4" />
        项目列表
      </Button>

      {/* Hero 区 */}
      <header className="grid gap-x-8 gap-y-4 border-b-[1.5px] border-foreground/30 pb-5 lg:grid-cols-[1.7fr_1fr]">
        <div className="min-w-0">
          <div className="mb-3 flex items-center gap-3 font-mono text-[10px] uppercase tracking-[0.28em] text-muted-foreground">
            <span className="h-px w-6 bg-foreground/40" aria-hidden="true" />
            <span>PROJECT · {project?.id ?? "—"}</span>
            <span className="h-px flex-1 bg-foreground/20" aria-hidden="true" />
          </div>
          <div className="flex items-center gap-3">
            <Layers className="h-7 w-7 text-accent" />
            <h1 className="font-display text-3xl font-bold uppercase tracking-wider leading-[1.05] sm:text-4xl">
              {project?.name}
            </h1>
          </div>
          {project?.description && (
            <p className="mt-3 max-w-xl text-sm text-muted-foreground">{project.description}</p>
          )}
        </div>
        <div className="flex flex-col gap-3 lg:items-end">
          <div className="w-full border-[1.5px] border-foreground/30 bg-card/40 font-mono text-[11px]">
            <div className="grid grid-cols-[100px_1fr] border-b border-dashed border-foreground/25">
              <div className="border-r border-dashed border-foreground/25 bg-muted/50 px-3 py-1.5 uppercase tracking-[0.18em] text-muted-foreground">
                CODEBASES
              </div>
              <div className="px-3 py-1.5 text-foreground">{codebases.length}</div>
            </div>
            <div className="grid grid-cols-[100px_1fr]">
              <div className="border-r border-dashed border-foreground/25 bg-muted/50 px-3 py-1.5 uppercase tracking-[0.18em] text-muted-foreground">
                REQUIREMENTS
              </div>
              <div className="px-3 py-1.5 text-foreground">{requirements.length}</div>
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={refresh}>
            <RefreshCw className="h-4 w-4" />
            刷新
          </Button>
        </div>
      </header>

      {/* 代码库 */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <FolderGit2 className="h-4 w-4 text-muted-foreground" />
            <span className="bp-label">代码库 · CODEBASES（{codebases.length}）</span>
          </div>
          <Button size="sm" variant="outline" onClick={() => openCbDialog()}>
            <Plus className="h-4 w-4" />
            添加代码库
          </Button>
        </div>

        {codebases.length === 0 ? (
          <Card className="border border-dashed border-foreground/30 p-6 text-center">
            <FolderGit2 className="mx-auto mb-2 h-6 w-6 text-muted-foreground/40" />
            <p className="mb-3 font-mono text-xs uppercase tracking-wider text-muted-foreground">
              暂无代码库，点「添加代码库」关联 Git 仓库。
            </p>
            <Button size="sm" variant="outline" onClick={() => openCbDialog()}>
              <Plus className="h-4 w-4" />
              添加代码库
            </Button>
          </Card>
        ) : (
          <Card className="overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b-[1.5px] border-foreground bg-secondary/50 text-left font-mono text-[10px] uppercase tracking-[0.2em] text-foreground/70">
                    <th className="px-4 py-2.5 font-semibold">别名</th>
                    <th className="px-4 py-2.5 font-semibold">路径</th>
                    <th className="px-4 py-2.5 font-semibold">分支</th>
                    <th className="px-4 py-2.5 font-semibold">健康</th>
                    <th className="px-4 py-2.5 font-semibold text-right">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {codebases.map((cb) => (
                    <tr
                      key={cb.id}
                      className="border-b border-dashed border-foreground/20 last:border-0 transition-colors hover:bg-accent/8"
                    >
                      <td className="px-4 py-2.5 font-mono text-sm font-medium">{cb.alias}</td>
                      <td className="max-w-[240px] px-4 py-2.5">
                        <span
                          className="block truncate font-mono text-xs text-muted-foreground"
                          title={cb.path}
                        >
                          {cb.path}
                        </span>
                      </td>
                      <td className="px-4 py-2.5">
                        <Badge variant="secondary">{cb.default_branch}</Badge>
                      </td>
                      <td className="px-4 py-2.5">
                        {renderHealth(cb) ?? <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">—</span>}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <div className="flex items-center justify-end gap-0.5">
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => void checkHealth(cb)}
                            disabled={healthMap[cb.id] === "loading" || deletingCbId === cb.id}
                            title="健康检查"
                          >
                            <Activity className={cn("h-3.5 w-3.5", healthMap[cb.id] === "loading" && "animate-pulse")} />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => openCbDialog(cb)}
                            disabled={deletingCbId === cb.id}
                            title="编辑"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="text-destructive hover:text-destructive"
                            onClick={() => void removeCb(cb)}
                            disabled={deletingCbId === cb.id}
                            title="移除代码库"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}
      </section>

      {/* 需求 */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Inbox className="h-4 w-4 text-muted-foreground" />
            <span className="bp-label">需求 · REQUIREMENTS（{requirements.length}）</span>
          </div>
          <Button size="sm" onClick={openReqDialog}>
            <Plus className="h-4 w-4" />
            新建需求
          </Button>
        </div>

        {requirements.length === 0 ? (
          <Card className="p-6 text-center">
            <Inbox className="mx-auto mb-2 h-6 w-6 text-muted-foreground/40" />
            <p className="mb-3 font-mono text-xs uppercase tracking-wider text-muted-foreground">
              暂无需求，点「新建需求」开始。
            </p>
            <Button size="sm" onClick={openReqDialog}>
              <Plus className="h-4 w-4" />
              新建需求
            </Button>
          </Card>
        ) : (
          <Card className="overflow-hidden">
            <div className="divide-y divide-dashed divide-foreground/20">
              {requirements.map((req) => (
                <div
                  key={req.id}
                  className="group flex cursor-pointer items-center justify-between gap-3 border-l-2 border-transparent px-4 py-3 transition-colors hover:border-accent hover:bg-accent/8"
                  onClick={() => navigate(`/requirements/${req.id}`)}
                >
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <p className="truncate text-sm font-medium">{req.title}</p>
                    <p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                      {new Date(req.created_at).toLocaleDateString("zh-CN")}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Badge variant={STATUS_VARIANT[req.status] ?? "outline"}>
                      {STATUS_LABEL[req.status] ?? req.status}
                    </Badge>
                    <ExternalLink className="h-3.5 w-3.5 text-muted-foreground/50 transition-colors group-hover:text-accent" />
                  </div>
                </div>
              ))}
            </div>
          </Card>
        )}
      </section>

      {/* 新建需求 Dialog */}
      <Dialog open={reqDialogOpen} onOpenChange={(open) => { if (!open) closeReqDialog(); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>新建需求</DialogTitle>
            <DialogDescription>
              在项目「{project?.name}」下创建需求，创建后进入详情页编写规格。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="req-title">
                标题 <span className="text-destructive">*</span>
              </Label>
              <Input
                id="req-title"
                placeholder="例如：用户登录功能"
                value={reqTitle}
                onChange={(e) => setReqTitle(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") void createRequirement(); }}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={closeReqDialog} disabled={savingReq}>取消</Button>
            <Button onClick={() => void createRequirement()} disabled={savingReq}>
              {savingReq ? "创建中…" : "创建"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 添加 / 编辑代码库 Dialog */}
      <Dialog open={cbDialogOpen} onOpenChange={(open) => { if (!open) closeCbDialog(); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{editingCb ? "编辑代码库" : "添加代码库"}</DialogTitle>
            <DialogDescription>
              {editingCb
                ? `修改代码库「${editingCb.alias}」的配置。`
                : `将一个 Git 仓库目录关联到项目「${project?.name}」。`}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="cb-alias">
                别名 <span className="text-destructive">*</span>
              </Label>
              <Input
                id="cb-alias"
                placeholder="例如：frontend"
                value={cbForm.alias}
                disabled={!!editingCb}
                onChange={(e) => setCbForm((f) => ({ ...f, alias: e.target.value }))}
              />
              {editingCb && <p className="text-xs text-muted-foreground">别名创建后不可修改。</p>}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cb-path">
                路径 <span className="text-destructive">*</span>
              </Label>
              <div className="flex items-center gap-2">
                <Input
                  id="cb-path"
                  placeholder="例如：/home/user/projects/frontend"
                  value={cbForm.path}
                  onChange={(e) => setCbForm((f) => ({ ...f, path: e.target.value }))}
                  className="flex-1"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="shrink-0"
                  onClick={() => setFolderPickerOpen(true)}
                >
                  <FolderOpen className="h-4 w-4" />
                  浏览…
                </Button>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cb-branch">默认分支</Label>
              <Input
                id="cb-branch"
                placeholder="main"
                value={cbForm.default_branch}
                onChange={(e) => setCbForm((f) => ({ ...f, default_branch: e.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label>GitHub（可选）</Label>
              <div className="flex gap-2">
                <Input
                  placeholder="owner"
                  value={cbForm.github_owner}
                  onChange={(e) => setCbForm((f) => ({ ...f, github_owner: e.target.value }))}
                  className="flex-1"
                />
                <span className="self-center text-muted-foreground">/</span>
                <Input
                  placeholder="repo"
                  value={cbForm.github_repo}
                  onChange={(e) => setCbForm((f) => ({ ...f, github_repo: e.target.value }))}
                  className="flex-1"
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={closeCbDialog} disabled={savingCb}>取消</Button>
            <Button onClick={() => void saveCb()} disabled={savingCb}>
              {savingCb ? (editingCb ? "保存中…" : "添加中…") : (editingCb ? "保存" : "添加")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 文件夹选择器 */}
      <FolderPicker
        open={folderPickerOpen}
        initialPath={cbForm.path || undefined}
        onSelect={(path) => {
          setCbForm((f) => ({ ...f, path }));
          setFolderPickerOpen(false);
        }}
        onCancel={() => setFolderPickerOpen(false)}
      />
    </div>
  );
}
