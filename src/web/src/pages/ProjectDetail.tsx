import React, { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowLeft, Layers, FolderGit2, Inbox, Plus, RefreshCw, ExternalLink, FolderOpen,
} from "lucide-react";
import { api, type Project, type Codebase, type Requirement } from "@/hooks/useApi";
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
  investigating: "调查中",
  awaiting_approval: "待审批",
  queued: "排队中",
  running: "执行中",
  done: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  drafting: "outline",
  investigating: "secondary",
  awaiting_approval: "secondary",
  queued: "secondary",
  running: "default",
  done: "default",
  failed: "destructive",
  cancelled: "outline",
};

interface CbForm {
  alias: string;
  path: string;
  default_branch: string;
}

const EMPTY_CB: CbForm = { alias: "", path: "", default_branch: "main" };

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

  // 新建代码库 dialog
  const [cbDialogOpen, setCbDialogOpen] = useState(false);
  const [cbForm, setCbForm] = useState<CbForm>(EMPTY_CB);
  const [savingCb, setSavingCb] = useState(false);
  const [folderPickerOpen, setFolderPickerOpen] = useState(false);

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
      })
      .catch((e: unknown) => setLoadError((e as Error)?.message ?? String(e)))
      .finally(() => setLoading(false));
  }, [projectId]);

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

  const openCbDialog = () => {
    setCbForm(EMPTY_CB);
    setCbDialogOpen(true);
  };

  const closeCbDialog = () => {
    if (savingCb) return;
    setCbDialogOpen(false);
  };

  const createCodebase = async () => {
    const alias = cbForm.alias.trim();
    const path = cbForm.path.trim();
    if (!alias) {
      toast.error("验证失败", "别名不能为空");
      return;
    }
    if (!path) {
      toast.error("验证失败", "路径不能为空");
      return;
    }
    setSavingCb(true);
    try {
      await api.createProjectCodebase(projectId, {
        alias,
        path,
        default_branch: cbForm.default_branch.trim() || "main",
      });
      toast.success(`已添加代码库「${alias}」`);
      setCbDialogOpen(false);
      refresh();
    } catch (e: unknown) {
      toast.error("创建失败", (e as Error)?.message ?? String(e));
    } finally {
      setSavingCb(false);
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
      {/* 页面头部 */}
      <div>
        <Button
          variant="ghost"
          size="sm"
          className="mb-3 -ml-2"
          onClick={() => navigate("/projects")}
        >
          <ArrowLeft className="h-4 w-4" />
          项目列表
        </Button>
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Layers className="h-5 w-5 text-muted-foreground" />
              <h2 className="text-xl font-semibold tracking-tight">{project?.name}</h2>
            </div>
            {project?.description && (
              <p className="text-sm text-muted-foreground">{project.description}</p>
            )}
          </div>
          <Button variant="outline" size="sm" onClick={refresh}>
            <RefreshCw className="h-4 w-4" />
            刷新
          </Button>
        </div>
      </div>

      {/* 代码库 */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <FolderGit2 className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-sm font-semibold">代码库（{codebases.length}）</h3>
          </div>
          <Button size="sm" variant="outline" onClick={openCbDialog}>
            <Plus className="h-4 w-4" />
            添加代码库
          </Button>
        </div>

        {codebases.length === 0 ? (
          <Card className="p-6 text-center">
            <FolderGit2 className="mx-auto mb-2 h-6 w-6 text-muted-foreground/40" />
            <p className="mb-3 text-sm text-muted-foreground">暂无代码库，点「添加代码库」关联 Git 仓库。</p>
            <Button size="sm" variant="outline" onClick={openCbDialog}>
              <Plus className="h-4 w-4" />
              添加代码库
            </Button>
          </Card>
        ) : (
          <Card className="overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
                    <th className="px-4 py-2.5 font-medium">别名</th>
                    <th className="px-4 py-2.5 font-medium">路径</th>
                    <th className="px-4 py-2.5 font-medium">默认分支</th>
                  </tr>
                </thead>
                <tbody>
                  {codebases.map((cb, idx) => (
                    <tr
                      key={cb.id}
                      className={cn(
                        "border-b last:border-0",
                        idx % 2 === 1 && "bg-muted/10",
                      )}
                    >
                      <td className="px-4 py-2.5 font-mono font-medium text-sm">{cb.alias}</td>
                      <td className="px-4 py-2.5 max-w-[280px]">
                        <span
                          className="font-mono text-xs text-muted-foreground truncate block"
                          title={cb.path}
                        >
                          {cb.path}
                        </span>
                      </td>
                      <td className="px-4 py-2.5">
                        <Badge variant="secondary" className="font-mono text-[11px] font-normal">
                          {cb.default_branch}
                        </Badge>
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
            <h3 className="text-sm font-semibold">需求（{requirements.length}）</h3>
            {requirements.length > 0 && (
              <button
                type="button"
                className="text-xs text-muted-foreground hover:text-primary hover:underline"
                onClick={() => navigate(`/requirements?project_id=${projectId}`)}
              >
                查看全部
              </button>
            )}
          </div>
          <Button size="sm" onClick={openReqDialog}>
            <Plus className="h-4 w-4" />
            新建需求
          </Button>
        </div>

        {requirements.length === 0 ? (
          <Card className="p-6 text-center">
            <Inbox className="mx-auto mb-2 h-6 w-6 text-muted-foreground/40" />
            <p className="mb-3 text-sm text-muted-foreground">暂无需求，点「新建需求」开始。</p>
            <Button size="sm" onClick={openReqDialog}>
              <Plus className="h-4 w-4" />
              新建需求
            </Button>
          </Card>
        ) : (
          <Card className="overflow-hidden">
            <div className="divide-y">
              {requirements.map((req) => (
                <div
                  key={req.id}
                  className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-muted/30 transition-colors cursor-pointer"
                  onClick={() => navigate(`/requirements/${req.id}`)}
                >
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <p className="truncate text-sm font-medium">{req.title}</p>
                    <p className="text-xs text-muted-foreground">
                      {new Date(req.created_at).toLocaleDateString("zh-CN")}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Badge variant={STATUS_VARIANT[req.status] ?? "outline"} className="text-xs">
                      {STATUS_LABEL[req.status] ?? req.status}
                    </Badge>
                    <ExternalLink className="h-3.5 w-3.5 text-muted-foreground/50" />
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

      {/* 添加代码库 Dialog */}
      <Dialog open={cbDialogOpen} onOpenChange={(open) => { if (!open) closeCbDialog(); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>添加代码库</DialogTitle>
            <DialogDescription>
              将一个 Git 仓库目录关联到项目「{project?.name}」。
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
                onChange={(e) => setCbForm((f) => ({ ...f, alias: e.target.value }))}
              />
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
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={closeCbDialog} disabled={savingCb}>取消</Button>
            <Button onClick={() => void createCodebase()} disabled={savingCb}>
              {savingCb ? "添加中…" : "添加"}
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
