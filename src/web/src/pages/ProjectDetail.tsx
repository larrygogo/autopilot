import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  ArrowLeft, FolderGit2, Inbox, Plus, RefreshCw,
  Trash2, Pencil, List, Archive, Loader2, Hand,
} from "lucide-react";
import { api, type Project, type Workspace, type Requirement } from "@/hooks/useApi";
import { useWebSocket } from "@/hooks/useWebSocket";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { TimeGroupedList, RequirementRow, type TimedRow } from "@/components/PipelineList";
import { tsToMs } from "@/lib/pipeline-time";
import { projectReqTab, type ProjectReqTab } from "@/lib/requirement-buckets";
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
import { ConfirmDialog } from "@/components/Modal";
import { cn } from "@/lib/utils";

/** 项目工作台子页（Supabase 式：侧栏项目导航切换，路由 /projects/:id/:section；无概览页，默认落需求） */
export type ProjectSection = "requirements" | "workspaces" | "settings";

interface ProjectDetailProps {
  projectId: string;
  section?: ProjectSection;
}

interface CbForm {
  alias: string;
  remote_url: string;
  default_branch: string;
  github_owner: string;
  github_repo: string;
}

const EMPTY_CB: CbForm = { alias: "", remote_url: "", default_branch: "main", github_owner: "", github_repo: "" };


export function ProjectDetail({ projectId, section = "requirements" }: ProjectDetailProps) {
  const navigate = useNavigate();
  const toast = useToast();

  const [project, setProject] = useState<Project | null>(null);
  const [codebases, setCodebases] = useState<Workspace[]>([]);
  const [requirements, setRequirements] = useState<Requirement[]>([]);
  const [workflowLabels, setWorkflowLabels] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reqTab, setReqTab] = useState<string>("all");

  // 项目设置（settings section 内联表单，原编辑 dialog 已收编于此）
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [projForm, setProjForm] = useState<{ name: string; description: string }>({ name: "", description: "" });
  const [savingProj, setSavingProj] = useState(false);

  // 新建需求 dialog
  const [reqDialogOpen, setReqDialogOpen] = useState(false);
  const [reqDesc, setReqDesc] = useState("");
  const [savingReq, setSavingReq] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);

  // 新建 / 编辑代码库 dialog
  const [cbDialogOpen, setCbDialogOpen] = useState(false);
  const [editingCb, setEditingCb] = useState<Workspace | null>(null);
  const [cbForm, setCbForm] = useState<CbForm>(EMPTY_CB);
  const [savingCb, setSavingCb] = useState(false);
  const [cbDetectHint, setCbDetectHint] = useState<string | null>(null);
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
    // 工作流 label 映射：需求卡 secondary 显示工作流中文名（与流水线页对齐）；拉不到不阻塞
    api.listWorkflows()
      .then((list) => setWorkflowLabels(Object.fromEntries(list.map((w) => [w.name, w.label ?? w.name]))))
      .catch(() => {});
  }, [projectId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // WS：需求状态变化（含卡片行内动作触发的）→ 静默重拉需求列表，不闪整页 loading
  const { subscribe } = useWebSocket();
  useEffect(() => {
    const unsub = subscribe("requirement:*", () => {
      api.listProjectRequirements(projectId).then(setRequirements).catch(() => {});
    });
    return unsub;
  }, [projectId, subscribe]);

  // 需求 4 段 tab 分桶（与流水线页同构；项目页需求自己代表全生命周期）
  const reqBuckets = useMemo(() => {
    const buckets: Record<ProjectReqTab, Requirement[]> = { human: [], running: [], archived: [] };
    for (const r of requirements) buckets[projectReqTab(r.status)].push(r);
    return buckets;
  }, [requirements]);

  const now = Date.now();
  const rowsOf = (list: Requirement[]): TimedRow[] =>
    list
      .map((r) => ({ key: r.id, ts: tsToMs(r.updated_at), node: <RequirementRow req={r} now={now} maps={{ workflows: workflowLabels }} /> }))
      .sort((a, b) => b.ts - a.ts);

  // ── 需求 ──────────────────────────────────────

  const openReqDialog = () => {
    setReqDesc("");
    setReqDialogOpen(true);
  };

  const closeReqDialog = () => {
    if (savingReq) return;
    setPendingFiles([]);
    setReqDialogOpen(false);
  };

  const createRequirement = async () => {
    const desc = reqDesc.trim();
    if (!desc) {
      toast.error("验证失败", "需求描述不能为空");
      return;
    }
    // 从描述截取临时 title（取首行；若过长则截 30 字 + "…"）；clarifier 后续会基于内容优化 title。
    // 代码库不在此选：创建时自动派生默认主库，集合在审批阶段反写确认
    const firstLine = desc.split("\n")[0].trim();
    const title = firstLine.length > 30 ? firstLine.slice(0, 30) + "…" : firstLine;
    setSavingReq(true);
    try {
      const req = await api.createRequirement({ project_id: projectId, title, spec_md: desc });
      toast.success(`已创建需求「${title}」`);
      // 若有预选文件，创建后立即上传（失败不阻断导航）
      if (pendingFiles.length > 0) {
        try {
          await api.uploadAttachments(req.id, pendingFiles);
        } catch (e: unknown) {
          toast.error("附件上传失败", (e as Error)?.message ?? String(e));
        }
      }
      setReqDialogOpen(false);
      setPendingFiles([]);
      navigate(`/requirements/${req.id}`);
    } catch (e: unknown) {
      toast.error("创建失败", (e as Error)?.message ?? String(e));
    } finally {
      setSavingReq(false);
    }
  };

  // ── 项目 ────────────────────────────────────

  // 项目加载后同步设置表单初值
  useEffect(() => {
    if (project) {
      setProjForm({ name: project.name, description: project.description ?? "" });
    }
  }, [project]);

  const saveProject = async () => {
    const name = projForm.name.trim();
    if (!name) { toast.error("验证失败", "项目名称不能为空"); return; }
    setSavingProj(true);
    try {
      await api.updateProject(projectId, { name, description: projForm.description.trim() || null });
      toast.success("已更新项目");
      refresh();
    } catch (e: unknown) {
      toast.error("更新失败", (e as Error)?.message ?? String(e));
    } finally {
      setSavingProj(false);
    }
  };

  const removeProject = async () => {
    if (!project) return;
    try {
      await api.deleteProject(project.id);
      toast.success(`已删除项目「${project.name}」`);
      navigate("/projects");
    } catch (e: unknown) {
      toast.error("删除失败", (e as Error)?.message ?? String(e));
      throw e; // 让 ConfirmDialog 退出 busy 态，弹窗保持打开供重试
    }
  };

  // ── 代码库 ────────────────────────────────────

  const openCbDialog = (cb?: Workspace) => {
    if (cb) {
      setEditingCb(cb);
      setCbForm({
        alias: cb.alias,
        remote_url: cb.remote_url ?? "",
        default_branch: cb.default_branch,
        github_owner: cb.github_owner ?? "",
        github_repo: cb.github_repo ?? "",
      });
    } else {
      setEditingCb(null);
      setCbForm(EMPTY_CB);
    }
    setCbDetectHint(null);
    setCbDialogOpen(true);
  };

  const closeCbDialog = () => {
    if (savingCb) return;
    setCbDialogOpen(false);
    setEditingCb(null);
    setCbDetectHint(null);
  };

  const saveCb = async () => {
    const alias = cbForm.alias.trim();
    const remoteUrl = cbForm.remote_url.trim();
    if (!alias) { toast.error("验证失败", "别名不能为空"); return; }
    if (!remoteUrl) { toast.error("验证失败", "远程地址不能为空"); return; }
    setSavingCb(true);
    try {
      if (editingCb) {
        await api.updateWorkspace(editingCb.id, {
          remote_url: remoteUrl,
          default_branch: cbForm.default_branch.trim() || "main",
          github_owner: cbForm.github_owner.trim() || null,
          github_repo: cbForm.github_repo.trim() || null,
        });
        toast.success(`已更新代码库「${alias}」`);
      } else {
        // 走 workspaces.create（仅凭远程 URL 注册 + probeRemote 验证 + 默认分支自动探测）。
        // 不走 projects.addWorkspace —— 那是远程化前的本地 path 模式老接口（要求 path 必填）。
        await api.createWorkspace({
          alias,
          remote_url: remoteUrl,
          project_id: projectId,
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

  const removeCb = async (cb: Workspace) => {
    if (!confirm(`确定移除代码库「${cb.alias}」？`)) return;
    setDeletingCbId(cb.id);
    try {
      await api.deleteWorkspace(cb.id);
      toast.success(`已移除代码库「${cb.alias}」`);
      refresh();
    } catch (e: unknown) {
      const msg = (e as Error)?.message ?? String(e);
      // 后端 IN_USE：有需求挂在此 workspace；提取数字弹二次确认
      if (msg.startsWith("IN_USE:")) {
        const m = msg.match(/(\d+)/);
        const n = m ? m[1] : "若干";
        if (confirm(
          `⚠ ${n} 条需求关联此代码库。继续删除会把这些需求的 workspace_id 置 NULL（需求保留，但变成"未关联代码库"）。\n\n确定要级联删除吗？`,
        )) {
          try {
            await api.deleteWorkspace(cb.id, true);
            toast.success(`已移除代码库「${cb.alias}」（${n} 条需求已解关联）`);
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
      {/* 代码库 */}
      {section === "workspaces" && (
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <FolderGit2 className="h-4 w-4 text-muted-foreground" />
            <span className="bp-label">代码库 · WORKSPACES（{codebases.length}）</span>
          </div>
          <Button size="sm" variant="outline" onClick={() => openCbDialog()}>
            <Plus className="h-4 w-4" />
            添加代码库
          </Button>
        </div>

        {codebases.length === 0 ? (
          <Card className="border border-border p-6 text-center">
            <FolderGit2 className="mx-auto mb-2 h-6 w-6 text-muted-foreground/40" />
            <p className="mb-3 font-mono text-xs text-muted-foreground">
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
                  <tr className="border-b border-border bg-secondary/50 text-left font-mono text-[10px] text-foreground/70">
                    <th className="px-4 py-2.5 font-semibold">别名</th>
                    <th className="hidden px-4 py-2.5 font-semibold md:table-cell">远程地址</th>
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
                          {/* mobile 下远程地址列被隐藏，把地址附在别名下面 */}
                          <span
                            className="block truncate text-[10px] font-normal text-muted-foreground md:hidden"
                            title={cb.remote_url ?? ""}
                          >
                            {cb.remote_url ?? <span className="text-orange-500">未填远程地址</span>}
                          </span>
                        </div>
                      </td>
                      <td className="hidden max-w-[320px] px-4 py-2.5 md:table-cell">
                        <span
                          className="block truncate font-mono text-xs text-muted-foreground"
                          title={cb.remote_url ?? ""}
                        >
                          {cb.remote_url ?? <span className="text-orange-500">未填远程地址</span>}
                        </span>
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
      )}

      {/* 需求 */}
      {section === "requirements" && (
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
            title={codebases.length === 0 ? "请先在「代码库」关联 Git 仓库" : undefined}
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
                需先关联代码库才能创建/运行需求 ——{" "}
                <Link to={`/projects/${projectId}/workspaces`} className="underline hover:text-foreground">
                  去「代码库」添加 ▸
                </Link>
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
          <Tabs value={reqTab} onValueChange={setReqTab}>
            <TabsList className="w-full justify-start overflow-x-auto overflow-y-hidden">
              <TabsTrigger value="all" className="gap-1.5">
                <List className="h-3.5 w-3.5 text-foreground/70" />
                全部
                <span className="ml-0.5 rounded-full bg-muted px-1.5 text-[10px] text-muted-foreground">{requirements.length}</span>
              </TabsTrigger>
              <TabsTrigger value="human" className="gap-1.5">
                <Hand className="h-3.5 w-3.5 text-warning" />
                等待人工
                <span className="ml-0.5 rounded-full bg-muted px-1.5 text-[10px] text-muted-foreground">{reqBuckets.human.length}</span>
              </TabsTrigger>
              <TabsTrigger value="running" className="gap-1.5">
                <Loader2 className="h-3.5 w-3.5 text-accent" />
                运行中
                <span className="ml-0.5 rounded-full bg-muted px-1.5 text-[10px] text-muted-foreground">{reqBuckets.running.length}</span>
              </TabsTrigger>
              <TabsTrigger value="archived" className="gap-1.5">
                <Archive className="h-3.5 w-3.5 text-muted-foreground" />
                归档
                <span className="ml-0.5 rounded-full bg-muted px-1.5 text-[10px] text-muted-foreground">{reqBuckets.archived.length}</span>
              </TabsTrigger>
            </TabsList>

            <TabsContent value="all">
              <TimeGroupedList rows={rowsOf(requirements)} now={now} />
            </TabsContent>
            {([
              ["human", reqBuckets.human, "没有等你处理的需求"],
              ["running", reqBuckets.running, "没有正在推进的需求"],
              ["archived", reqBuckets.archived, "还没有归档的需求"],
            ] as Array<[string, Requirement[], string]>).map(([key, list, empty]) => (
              <TabsContent key={key} value={key}>
                {list.length > 0 ? (
                  <TimeGroupedList rows={rowsOf(list)} now={now} />
                ) : (
                  <p className="py-10 text-center font-mono text-[11px] text-muted-foreground">{empty}</p>
                )}
              </TabsContent>
            ))}
          </Tabs>
        )}
      </section>
      )}

      {/* 设置：项目信息内联表单 + 危险区 */}
      {section === "settings" && (
        <section className="max-w-xl space-y-6">
          <div>
            <h2 className="mb-3 text-base font-semibold">项目信息</h2>
            <Card className="space-y-4 p-4">
              <div className="space-y-1.5">
                <Label htmlFor="proj-name">
                  名称 <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="proj-name"
                  placeholder="项目名称"
                  value={projForm.name}
                  onChange={(e) => setProjForm((f) => ({ ...f, name: e.target.value }))}
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
              <div className="flex justify-end">
                <Button onClick={() => void saveProject()} disabled={savingProj}>
                  {savingProj ? "保存中…" : "保存"}
                </Button>
              </div>
            </Card>
          </div>

          {project && project.id !== "proj-default" && (
            <div>
              <h2 className="mb-3 text-base font-semibold text-destructive">危险区</h2>
              <Card className="flex flex-col gap-3 border-destructive/40 p-4 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-sm text-muted-foreground">
                  删除项目将级联清除其下全部需求、任务与代码库配置，不可恢复。
                </p>
                <Button
                  variant="destructive"
                  className="shrink-0"
                  onClick={() => setDeleteOpen(true)}
                >
                  <Trash2 className="h-4 w-4" />
                  删除项目
                </Button>
              </Card>
            </div>
          )}
        </section>
      )}

      {/* 删除项目确认 —— 用共享 ConfirmDialog（confirmWord=项目名，高危输入名确认）*/}
      <ConfirmDialog
        open={deleteOpen}
        title={`删除项目「${project?.name}」？`}
        danger
        confirmText="确认删除"
        confirmWord={project?.name}
        message={
          <p>
            将<strong className="text-destructive">永久删除</strong>该项目，并级联清除其下
            {" "}{requirements.length}{" "}条需求、关联的全部任务（含运行中，会先尝试停止）、
            {" "}{codebases.length}{" "}个代码库配置及评论/反馈等数据。此操作<strong>不可恢复</strong>。
          </p>
        }
        onConfirm={removeProject}
        onCancel={() => setDeleteOpen(false)}
      />

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
            {/* 附件预选：创建后自动上传 */}
            <div className="space-y-2">
              <label className="font-mono text-[11px] text-muted-foreground">附件（可选）</label>
              {pendingFiles.length > 0 && (
                <div className="space-y-1">
                  {pendingFiles.map((f, i) => (
                    <div key={i} className="flex items-center gap-2 rounded border border-border px-2.5 py-1.5">
                      <span className="flex-1 truncate font-mono text-[11px]">{f.name}</span>
                      <button
                        type="button"
                        className="text-muted-foreground hover:text-destructive"
                        onClick={() => setPendingFiles((prev) => prev.filter((_, idx) => idx !== i))}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <div
                className="flex cursor-pointer items-center justify-center gap-2 rounded-md border border-dashed border-border px-3 py-2.5 hover:border-accent/60 hover:bg-muted/30 transition-colors"
                onClick={() => {
                  const input = document.createElement("input");
                  input.type = "file";
                  input.multiple = true;
                  input.onchange = () => {
                    const files = Array.from(input.files ?? []);
                    setPendingFiles((prev) => [...prev, ...files]);
                  };
                  input.click();
                }}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === "Enter") (e.currentTarget as HTMLElement).click(); }}
              >
                <span className="font-mono text-[11px] text-muted-foreground">+ 选择文件（图片 / PDF / Office / 代码，最大 200MB）</span>
              </div>
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
                : `将一个远程 Git 仓库关联到项目「${project?.name}」。`}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            {/* 别名 */}
            {!editingCb && (
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
            )}
            {/* 远程地址 */}
            <div className="space-y-1.5">
              <Label htmlFor="cb-remote">
                远程仓库地址 <span className="text-destructive">*</span>
              </Label>
              <Input
                id="cb-remote"
                placeholder="https://github.com/owner/repo.git 或 git@github.com:owner/repo.git"
                value={cbForm.remote_url}
                onChange={(e) => setCbForm((f) => ({ ...f, remote_url: e.target.value }))}
              />
              {cbDetectHint && (
                <p className="text-xs text-muted-foreground mt-1">{cbDetectHint}</p>
              )}
              <p className="text-[11px] text-muted-foreground/80">
                写入前会执行 git ls-remote 验证远程可达性；默认分支将自动探测。
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={closeCbDialog} disabled={savingCb}>取消</Button>
            <Button onClick={() => void saveCb()} disabled={savingCb || !cbForm.remote_url.trim()}>
              {savingCb ? (editingCb ? "保存中…" : "添加中…") : (editingCb ? "保存" : "添加")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
