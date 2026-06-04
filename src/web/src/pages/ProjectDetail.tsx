import React, { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowLeft, Layers, FolderGit2, Inbox, Plus, RefreshCw, ExternalLink,
  FolderOpen, Trash2, Pencil,
} from "lucide-react";
import { api, type Project, type Workspace, type Requirement } from "@/hooks/useApi";
import { useToast } from "@/components/Toast";
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

/** 取路径最后一段作为文件夹名（兼容 Windows \ 和 POSIX /，忽略结尾分隔符） */
function folderName(p: string): string {
  const trimmed = p.trim().replace(/[\\/]+$/, "");
  return trimmed.split(/[\\/]/).pop() ?? "";
}


export function ProjectDetail({ projectId }: ProjectDetailProps) {
  const navigate = useNavigate();
  const toast = useToast();

  const [project, setProject] = useState<Project | null>(null);
  const [codebases, setCodebases] = useState<Workspace[]>([]);
  const [requirements, setRequirements] = useState<Requirement[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // 编辑项目 dialog
  const [projDialogOpen, setProjDialogOpen] = useState(false);
  const [projForm, setProjForm] = useState<{ name: string; description: string }>({ name: "", description: "" });
  const [savingProj, setSavingProj] = useState(false);

  // 新建需求 dialog
  const [reqDialogOpen, setReqDialogOpen] = useState(false);
  const [reqDesc, setReqDesc] = useState("");
  const [savingReq, setSavingReq] = useState(false);

  // 新建 / 编辑工作区 dialog
  const [cbDialogOpen, setCbDialogOpen] = useState(false);
  const [editingCb, setEditingCb] = useState<Workspace | null>(null);
  const [cbForm, setCbForm] = useState<CbForm>(EMPTY_CB);
  const [savingCb, setSavingCb] = useState(false);
  const [detectingCb, setDetectingCb] = useState(false);
  const [cbDetectHint, setCbDetectHint] = useState<string | null>(null);
  const [lastDetectedPath, setLastDetectedPath] = useState("");
  const [folderPickerOpen, setFolderPickerOpen] = useState(false);
  const [deletingCbId, setDeletingCbId] = useState<string | null>(null);

  const refresh = useCallback(() => {
    setLoading(true);
    setLoadError(null);
    Promise.all([
      api.getProject(projectId),
      api.listProjectWorkspaces(projectId),
      api.listProjectRequirements(projectId),
    ])
      .then(([proj, cbs, reqs]) => {
        setProject(proj);
        setCodebases(cbs);
        setRequirements(reqs);
      })
      .catch((e: unknown) => setLoadError((e as Error)?.message ?? String(e)))
      .finally(() => setLoading(false));
  }, [projectId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // ── 需求 ──────────────────────────────────────

  const openReqDialog = () => {
    setReqDesc("");
    setReqDialogOpen(true);
  };

  const closeReqDialog = () => {
    if (savingReq) return;
    setReqDialogOpen(false);
  };

  const createRequirement = async () => {
    const desc = reqDesc.trim();
    if (!desc) {
      toast.error("验证失败", "需求描述不能为空");
      return;
    }
    // 从描述截取临时 title（取首行；若过长则截 30 字 + "…"）；clarifier 后续会基于内容优化 title。
    const firstLine = desc.split("\n")[0].trim();
    const title = firstLine.length > 30 ? firstLine.slice(0, 30) + "…" : firstLine;
    setSavingReq(true);
    try {
      const req = await api.createRequirement({ project_id: projectId, title, spec_md: desc });
      toast.success(`已创建需求「${title}」`);
      setReqDialogOpen(false);
      navigate(`/requirements/${req.id}`);
    } catch (e: unknown) {
      toast.error("创建失败", (e as Error)?.message ?? String(e));
    } finally {
      setSavingReq(false);
    }
  };

  // ── 项目 ────────────────────────────────────

  const openProjDialog = () => {
    setProjForm({ name: project?.name ?? "", description: project?.description ?? "" });
    setProjDialogOpen(true);
  };

  const saveProject = async () => {
    const name = projForm.name.trim();
    if (!name) { toast.error("验证失败", "项目名称不能为空"); return; }
    setSavingProj(true);
    try {
      await api.updateProject(projectId, { name, description: projForm.description.trim() || null });
      toast.success("已更新项目");
      setProjDialogOpen(false);
      refresh();
    } catch (e: unknown) {
      toast.error("更新失败", (e as Error)?.message ?? String(e));
    } finally {
      setSavingProj(false);
    }
  };

  // ── 工作区 ────────────────────────────────────

  const openCbDialog = (cb?: Workspace) => {
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
    // 编辑时以已存路径为基线（同路径失焦不重识别、不覆盖已存值）；新建从空开始
    setLastDetectedPath(cb?.path ?? "");
    setCbDetectHint(null);
    setCbDialogOpen(true);
  };

  const closeCbDialog = () => {
    if (savingCb) return;
    setCbDialogOpen(false);
    setEditingCb(null);
    setCbDetectHint(null);
  };

  /**
   * 从路径自动识别 git 信息，回填默认分支 / GitHub。
   * 仅在「路径相对上次识别变化」时触发——换目录就用新仓库的值覆盖（分支/GitHub
   * 跟随当前目录，不残留上一个仓库）；同一路径重复失焦不重识别，避免覆盖手动微调。
   */
  const detectCbFromPath = async (rawPath: string) => {
    const path = rawPath.trim();
    if (!path || path === lastDetectedPath) return;
    const prevBase = folderName(lastDetectedPath);
    setLastDetectedPath(path);
    // 别名默认取文件夹名（仅新建）：空、或仍是上个目录的自动名时跟随；用户手填的保留
    if (!editingCb) {
      const base = folderName(path);
      if (base) {
        setCbForm((f) => ({
          ...f,
          alias: !f.alias.trim() || f.alias.trim() === prevBase ? base : f.alias,
        }));
      }
    }
    setDetectingCb(true);
    setCbDetectHint(null);
    try {
      const info = await api.detectWorkspace(path);
      if (!info.is_git) {
        setCbDetectHint("该路径不是 git 仓库，未能自动识别。");
        return;
      }
      // 换了目录 → 用新仓库的值覆盖（识别不到则回退 main / 清空 GitHub）
      setCbForm((f) => ({
        ...f,
        default_branch: info.default_branch ?? "main",
        github_owner: info.github_owner ?? "",
        github_repo: info.github_repo ?? "",
      }));
      const parts: string[] = [];
      if (info.default_branch) parts.push(`默认分支 ${info.default_branch}`);
      if (info.remote_url) parts.push(`远程 ${info.remote_url}`);
      setCbDetectHint(parts.length ? `已识别：${parts.join("；")}` : "已识别为 git 仓库（无 origin 远程）。");
    } catch (e: unknown) {
      setCbDetectHint(null);
    } finally {
      setDetectingCb(false);
    }
  };

  const saveCb = async () => {
    const alias = cbForm.alias.trim();
    const path = cbForm.path.trim();
    if (!alias) { toast.error("验证失败", "别名不能为空"); return; }
    if (!path) { toast.error("验证失败", "路径不能为空"); return; }
    setSavingCb(true);
    try {
      if (editingCb) {
        await api.updateWorkspace(editingCb.id, {
          path,
          default_branch: cbForm.default_branch.trim() || "main",
          github_owner: cbForm.github_owner.trim() || null,
          github_repo: cbForm.github_repo.trim() || null,
        });
        toast.success(`已更新工作区「${alias}」`);
      } else {
        await api.createProjectWorkspace(projectId, {
          alias,
          path,
          default_branch: cbForm.default_branch.trim() || "main",
          github_owner: cbForm.github_owner.trim() || null,
          github_repo: cbForm.github_repo.trim() || null,
        });
        toast.success(`已添加工作区「${alias}」`);
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

  const removeCb = async (cb: Workspace) => {
    if (!confirm(`确定移除工作区「${cb.alias}」？`)) return;
    setDeletingCbId(cb.id);
    try {
      await api.deleteWorkspace(cb.id);
      toast.success(`已移除工作区「${cb.alias}」`);
      refresh();
    } catch (e: unknown) {
      const msg = (e as Error)?.message ?? String(e);
      // 后端 IN_USE：有需求挂在此 workspace；提取数字弹二次确认
      if (msg.startsWith("IN_USE:")) {
        const m = msg.match(/(\d+)/);
        const n = m ? m[1] : "若干";
        if (confirm(
          `⚠ ${n} 条需求关联此工作区。继续删除会把这些需求的 workspace_id 置 NULL（需求保留，但变成"未关联工作区"）。\n\n确定要级联删除吗？`,
        )) {
          try {
            await api.deleteWorkspace(cb.id, true);
            toast.success(`已移除工作区「${cb.alias}」（${n} 条需求已解关联）`);
            refresh();
          } catch (e2: unknown) {
            toast.error("删除失败", (e2 as Error)?.message ?? String(e2));
          }
        }
      } else {
        toast.error("删除失败", msg);
      }
    } finally {
      setDeletingCbId(null);
    }
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
      <header className="grid gap-x-8 gap-y-4 border-b border-border pb-5 lg:grid-cols-[1.7fr_1fr]">
        <div className="min-w-0">
          <div className="mb-3 flex items-center gap-3 font-mono text-[10px] text-muted-foreground">
            <span className="h-px w-6 bg-foreground/40" aria-hidden="true" />
            <span>PROJECT · {project?.id ?? "—"}</span>
            <span className="h-px flex-1 bg-foreground/20" aria-hidden="true" />
          </div>
          <div className="flex items-center gap-3">
            <Layers className="h-7 w-7 text-accent" />
            <h1 className="font-display text-3xl font-bold leading-[1.05] sm:text-4xl">
              {project?.name}
            </h1>
            {project && (
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 shrink-0 text-muted-foreground hover:text-foreground"
                title="编辑项目"
                onClick={openProjDialog}
              >
                <Pencil className="h-4 w-4" />
              </Button>
            )}
          </div>
          {project?.description && (
            <p className="mt-3 max-w-xl text-sm text-muted-foreground">{project.description}</p>
          )}
        </div>
        <div className="flex flex-col gap-3 lg:items-end">
          <div className="w-full border border-border bg-card/40 font-mono text-[11px]">
            <div className="grid grid-cols-[100px_1fr] border-b border-border">
              <div className="border-r border-border bg-muted/50 px-3 py-1.5 text-muted-foreground">
                工作区
              </div>
              <div className="px-3 py-1.5 text-foreground">{codebases.length}</div>
            </div>
            <div className="grid grid-cols-[100px_1fr]">
              <div className="border-r border-border bg-muted/50 px-3 py-1.5 text-muted-foreground">
                需求
              </div>
              <div className="px-3 py-1.5 text-foreground">{requirements.length}</div>
            </div>
          </div>
        </div>
      </header>

      {/* 工作区 */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <FolderGit2 className="h-4 w-4 text-muted-foreground" />
            <span className="bp-label">工作区 · WORKSPACES（{codebases.length}）</span>
          </div>
          {/* 每个项目仅一个工作区：已有则不再显示添加 */}
          {codebases.length === 0 && (
            <Button size="sm" variant="outline" onClick={() => openCbDialog()}>
              <Plus className="h-4 w-4" />
              添加工作区
            </Button>
          )}
        </div>

        {codebases.length === 0 ? (
          <Card className="border border-border p-6 text-center">
            <FolderGit2 className="mx-auto mb-2 h-6 w-6 text-muted-foreground/40" />
            <p className="mb-3 font-mono text-xs text-muted-foreground">
              暂无工作区，点「添加工作区」关联 Git 仓库。
            </p>
            <Button size="sm" variant="outline" onClick={() => openCbDialog()}>
              <Plus className="h-4 w-4" />
              添加工作区
            </Button>
          </Card>
        ) : (
          <Card className="overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-secondary/50 text-left font-mono text-[10px] text-foreground/70">
                    <th className="px-4 py-2.5 font-semibold">别名</th>
                    <th className="hidden px-4 py-2.5 font-semibold md:table-cell">路径</th>
                    <th className="hidden px-4 py-2.5 font-semibold sm:table-cell">分支</th>
                    <th className="px-4 py-2.5 font-semibold text-right">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {codebases.map((cb) => (
                    <tr
                      key={cb.id}
                      className="border-b border-border last:border-0 transition-colors hover:bg-accent/8"
                    >
                      <td className="px-4 py-2.5 font-mono text-sm font-medium">
                        <div className="flex flex-col gap-0.5 md:gap-0">
                          <span>{cb.alias}</span>
                          {/* mobile 下路径列被隐藏，把路径附在别名下面，让用户至少能识别 */}
                          <span
                            className="block truncate text-[10px] font-normal text-muted-foreground md:hidden"
                            title={cb.path}
                          >
                            {cb.path}
                          </span>
                          {cb.path_exists === false && (
                            <span className="text-[10px] font-normal text-destructive md:hidden">路径不存在</span>
                          )}
                        </div>
                      </td>
                      <td className="hidden max-w-[240px] px-4 py-2.5 md:table-cell">
                        <span
                          className="block truncate font-mono text-xs text-muted-foreground"
                          title={cb.path}
                        >
                          {cb.path}
                        </span>
                        {cb.path_exists === false && (
                          <span className="mt-0.5 block font-mono text-[10px] text-destructive" title="本地路径当前不存在（可能已被删除或移动）">
                            ⚠ 路径不存在
                          </span>
                        )}
                      </td>
                      <td className="hidden px-4 py-2.5 sm:table-cell">
                        <Badge variant="secondary">{cb.default_branch}</Badge>
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <div className="flex items-center justify-end gap-0.5">
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
                            title="移除工作区"
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
          <Button
            size="sm"
            onClick={openReqDialog}
            disabled={codebases.length === 0}
            title={codebases.length === 0 ? "请先为项目添加工作区" : undefined}
          >
            <Plus className="h-4 w-4" />
            新建需求
          </Button>
        </div>

        {requirements.length === 0 ? (
          <Card className="p-6 text-center">
            <Inbox className="mx-auto mb-2 h-6 w-6 text-muted-foreground/40" />
            {codebases.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                需先关联工作区才能创建/运行需求 —— 请先在上方「添加工作区」。
              </p>
            ) : (
              <>
                <p className="mb-3 font-mono text-xs text-muted-foreground">
                  暂无需求，点「新建需求」开始。
                </p>
                <Button size="sm" onClick={openReqDialog}>
                  <Plus className="h-4 w-4" />
                  新建需求
                </Button>
              </>
            )}
          </Card>
        ) : (
          <Card className="overflow-hidden">
            <div className="divide-y divide-foreground/20">
              {requirements.map((req) => (
                <div
                  key={req.id}
                  className="group flex cursor-pointer items-center justify-between gap-3 border-l-2 border-transparent px-4 py-3 transition-colors hover:border-accent hover:bg-accent/8"
                  onClick={() => navigate(`/requirements/${req.id}`)}
                >
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <p className="truncate text-sm font-medium">{req.title}</p>
                    <p className="font-mono text-[10px] text-muted-foreground">
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

      {/* 编辑项目 Dialog */}
      <Dialog open={projDialogOpen} onOpenChange={(open) => { if (!open && !savingProj) setProjDialogOpen(false); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>编辑项目</DialogTitle>
            <DialogDescription>修改项目名称与描述。</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="proj-name">
                名称 <span className="text-destructive">*</span>
              </Label>
              <Input
                id="proj-name"
                placeholder="项目名称"
                value={projForm.name}
                autoFocus
                onChange={(e) => setProjForm((f) => ({ ...f, name: e.target.value }))}
                onKeyDown={(e) => { if (e.key === "Enter") void saveProject(); }}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="proj-desc">描述（可选）</Label>
              <Textarea
                id="proj-desc"
                placeholder="一句话描述这个项目"
                value={projForm.description}
                onChange={(e) => setProjForm((f) => ({ ...f, description: e.target.value }))}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setProjDialogOpen(false)} disabled={savingProj}>取消</Button>
            <Button onClick={() => void saveProject()} disabled={savingProj}>
              {savingProj ? "保存中…" : "保存"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 新建需求 Dialog */}
      <Dialog open={reqDialogOpen} onOpenChange={(open) => { if (!open) closeReqDialog(); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>新建需求</DialogTitle>
            <DialogDescription>
              直接写下你想做什么，AI 会帮你总结标题、补充结构、逐个澄清细节。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="req-desc">
                需求描述 <span className="text-destructive">*</span>
              </Label>
              <Textarea
                id="req-desc"
                placeholder="例如：希望在 /now 主屏增加一个『今日重点』区域，把所有 P0/P1 的卡片合并展示，方便一眼看到要紧的事…"
                value={reqDesc}
                onChange={(e) => setReqDesc(e.target.value)}
                rows={6}
                className="resize-none"
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void createRequirement();
                }}
              />
              <p className="font-mono text-[10px] text-muted-foreground">
                Ctrl/⌘+Enter 提交 · 标题会自动从首行截取，AI 后续会优化
              </p>
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

      {/* 添加 / 编辑工作区 Dialog */}
      <Dialog open={cbDialogOpen} onOpenChange={(open) => { if (!open) closeCbDialog(); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{editingCb ? "编辑工作区" : "添加工作区"}</DialogTitle>
            <DialogDescription>
              {editingCb
                ? `修改工作区「${editingCb.alias}」的配置。`
                : `将一个 Git 仓库目录关联到项目「${project?.name}」。`}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
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
                  onBlur={(e) => void detectCbFromPath(e.target.value)}
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
            {cbForm.path.trim() && (
              <div className="space-y-1 rounded-md border border-border bg-muted/30 px-3 py-2">
                {detectingCb ? (
                  <p className="text-xs text-muted-foreground">正在从 Git 识别…</p>
                ) : (
                  <>
                    <p className="text-xs text-muted-foreground">
                      将采用：别名 <span className="font-mono text-foreground">{cbForm.alias || folderName(cbForm.path)}</span>
                      {" · 默认分支 "}
                      <span className="font-mono text-foreground">{cbForm.default_branch || "main"}</span>
                      {cbForm.github_owner && cbForm.github_repo && (
                        <>
                          {" · GitHub "}
                          <span className="font-mono text-foreground">{cbForm.github_owner}/{cbForm.github_repo}</span>
                        </>
                      )}
                    </p>
                    {cbDetectHint && (
                      <p className="text-[11px] text-muted-foreground/80">{cbDetectHint}</p>
                    )}
                    {editingCb && (
                      <p className="text-[11px] text-muted-foreground/80">别名创建后不可修改；分支 / GitHub 随路径自动识别。</p>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={closeCbDialog} disabled={savingCb}>取消</Button>
            <Button onClick={() => void saveCb()} disabled={savingCb || !cbForm.path.trim()}>
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
          void detectCbFromPath(path);
        }}
        onCancel={() => setFolderPickerOpen(false)}
      />
    </div>
  );
}
