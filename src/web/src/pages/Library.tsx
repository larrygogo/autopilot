import React, { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Layers, Plus, RefreshCw, Pencil, Trash2, LayoutGrid, List, MoreHorizontal } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { useWebSocket } from "@/hooks/useWebSocket";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { api, type Project } from "@/hooks/useApi";
import { useToast } from "@/components/Toast";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Projects tab（原 src/web/src/pages/Projects.tsx 内联简化版，去 PageHero）
// ---------------------------------------------------------------------------

interface FormState {
  name: string;
  description: string;
}

const EMPTY_FORM: FormState = { name: "", description: "" };

function ProjectsTab() {
  const navigate = useNavigate();
  const toast = useToast();
  const { subscribe } = useWebSocket();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingProject, setEditingProject] = useState<Project | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);



  const [deleteTarget, setDeleteTarget] = useState<Project | null>(null);
  const [deleteInput, setDeleteInput] = useState("");
  const [deleting, setDeleting] = useState(false);

  // grid / list 视图（localStorage 记住偏好）
  const [view, setView] = useState<"grid" | "list">(() => {
    try {
      return localStorage.getItem("library.projects.view") === "list" ? "list" : "grid";
    } catch {
      return "grid";
    }
  });
  useEffect(() => {
    try { localStorage.setItem("library.projects.view", view); } catch { /* ignore */ }
  }, [view]);

  const refresh = useCallback(() => {
    setLoading(true);
    setLoadError(null);
    api
      .listProjects()
      .then(setProjects)
      .catch((e: unknown) => setLoadError((e as Error)?.message ?? String(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // WS：projects:* 自动 refetch（含跨标签页 / 跨设备的项目变化）
  useEffect(() => {
    const unsub = subscribe("projects:*", () => refresh());
    return unsub;
  }, [subscribe, refresh]);

  const openCreateDialog = () => {
    setEditingProject(null);
    setForm(EMPTY_FORM);
    setDialogOpen(true);
  };

  const openEditDialog = (p: Project, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingProject(p);
    setForm({ name: p.name, description: p.description ?? "" });
    setDialogOpen(true);
  };

  const closeDialog = () => {
    if (saving) return;
    setDialogOpen(false);
    setEditingProject(null);
  };

  const save = async () => {
    const name = form.name.trim();
    if (!name) {
      toast.error("验证失败", "项目名称不能为空");
      return;
    }
    setSaving(true);
    try {
      if (editingProject) {
        // 编辑：只改 name / description，不动代码库
        await api.updateProject(editingProject.id, {
          name,
          description: form.description.trim() || null,
        });
        toast.success(`已更新项目「${name}」`);
      } else {
        // 新建：只要名称/描述；代码库稍后在项目的「代码库」分区关联
        await api.createProject({
          name,
          description: form.description.trim() || undefined,
        });
        toast.success(`已创建项目「${name}」，可在项目的「代码库」里关联 Git 仓库`);
      }
      setDialogOpen(false);
      setEditingProject(null);
      refresh();
    } catch (e: unknown) {
      toast.error(editingProject ? "更新失败" : "创建失败", (e as Error)?.message ?? String(e));
    } finally {
      setSaving(false);
    }
  };

  const openDeleteDialog = (p: Project, e: React.MouseEvent) => {
    e.stopPropagation();
    setDeleteTarget(p);
    setDeleteInput("");
  };

  const closeDeleteDialog = () => {
    if (deleting) return;
    setDeleteTarget(null);
    setDeleteInput("");
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api.deleteProject(deleteTarget.id);
      toast.success(`已删除项目「${deleteTarget.name}」`);
      setDeleteTarget(null);
      setDeleteInput("");
      refresh();
    } catch (e: unknown) {
      toast.error("删除失败", (e as Error)?.message ?? String(e));
    } finally {
      setDeleting(false);
    }
  };

  // Supabase 式操作菜单（grid 卡片右上角 / list 行尾共用）
  const projectMenu = (project: Project) => (
    <DropdownMenu>
      <DropdownMenuTrigger
        onClick={(e) => e.stopPropagation()}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        aria-label={`项目 ${project.name} 操作`}
      >
        <MoreHorizontal className="h-4 w-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-36" onClick={(e) => e.stopPropagation()}>
        <DropdownMenuItem className="gap-2" onSelect={() => openEditDialog(project, { stopPropagation: () => {} } as React.MouseEvent)}>
          <Pencil className="h-3.5 w-3.5" />
          编辑
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="gap-2 text-destructive focus:text-destructive"
          onSelect={() => openDeleteDialog(project, { stopPropagation: () => {} } as React.MouseEvent)}
        >
          <Trash2 className="h-3.5 w-3.5" />
          删除
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    <div className="space-y-4 pt-4">
      <div className="flex items-center justify-between gap-3">
        <p className="bp-label text-muted-foreground">
          共 {projects.length} 个项目
        </p>
        <div className="flex items-center gap-2">
          {/* grid / list 视图切换（记住偏好） */}
          <div className="flex items-center rounded-md border border-border p-0.5">
            <button
              type="button"
              aria-label="网格视图"
              onClick={() => setView("grid")}
              className={cn(
                "flex h-7 w-7 items-center justify-center rounded transition-colors",
                view === "grid" ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              <LayoutGrid className="h-4 w-4" />
            </button>
            <button
              type="button"
              aria-label="列表视图"
              onClick={() => setView("list")}
              className={cn(
                "flex h-7 w-7 items-center justify-center rounded transition-colors",
                view === "list" ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              <List className="h-4 w-4" />
            </button>
          </div>
          <Button size="sm" onClick={openCreateDialog}>
            <Plus className="h-4 w-4" />
            新建项目
          </Button>
        </div>
      </div>

      {loadError && (
        <Card className="border-destructive/50 p-4">
          <p className="text-sm text-destructive">加载失败：{loadError}</p>
        </Card>
      )}

      {loading && (
        <div className="flex items-center justify-center py-12">
          <RefreshCw className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      )}

      {!loading && !loadError && projects.length === 0 && (
        <Card className="p-10 text-center">
          <Layers className="mx-auto mb-3 h-8 w-8 text-muted-foreground/40" />
          <p className="mb-4 text-sm text-muted-foreground">
            暂无项目，点「新建项目」开始创建第一个项目。
          </p>
          <Button size="sm" onClick={openCreateDialog}>
            <Plus className="h-4 w-4" />
            新建项目
          </Button>
        </Card>
      )}

      {/* grid：固定高度卡片（Supabase 式，右上角 ⋯ 操作菜单） */}
      {!loading && projects.length > 0 && view === "grid" && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((project) => (
            <Card
              key={project.id}
              className="flex h-[150px] cursor-pointer flex-col p-4 transition-colors hover:border-accent"
              onClick={() => navigate("/projects/" + project.id)}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <h3 className="truncate text-base font-bold leading-tight">{project.name}</h3>
                  <div className="mt-1 flex items-center gap-1.5 font-mono text-[10px] text-muted-foreground">
                    <Layers className="h-3 w-3 shrink-0" />
                    {project.id}
                  </div>
                </div>
                {projectMenu(project)}
              </div>
              {project.description && (
                <p className="mt-2 text-xs leading-relaxed text-muted-foreground line-clamp-2">
                  {project.description}
                </p>
              )}
              <div className="mt-auto text-[11px] text-muted-foreground">
                创建于 {new Date(project.created_at).toLocaleDateString("zh-CN")}
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* list：行式视图 */}
      {!loading && projects.length > 0 && view === "list" && (
        <Card className="overflow-hidden p-0">
          <ul className="divide-y divide-border">
            {projects.map((project) => (
              <li
                key={project.id}
                className="flex cursor-pointer items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/40"
                onClick={() => navigate("/projects/" + project.id)}
              >
                <Layers className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="shrink-0 text-sm font-bold">{project.name}</span>
                <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                  {project.description ?? ""}
                </span>
                <span className="hidden shrink-0 font-mono text-[10px] text-muted-foreground sm:inline">
                  {project.id}
                </span>
                <span className="hidden shrink-0 text-[11px] text-muted-foreground md:inline">
                  {new Date(project.created_at).toLocaleDateString("zh-CN")}
                </span>
                {projectMenu(project)}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {/* 新建 / 编辑 dialog */}
      <Dialog open={dialogOpen} onOpenChange={(open) => { if (!open) closeDialog(); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{editingProject ? "编辑项目" : "新建项目"}</DialogTitle>
            <DialogDescription>
              {editingProject
                ? "修改项目名称或描述。"
                : "填写名称即可创建；Git 仓库稍后在项目的「代码库」里关联。"}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="project-name">
                名称 <span className="text-destructive">*</span>
              </Label>
              <Input
                id="project-name"
                placeholder="例如：My Awesome App"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                onKeyDown={(e) => { if (e.key === "Enter") void save(); }}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="project-description">描述（可选）</Label>
              <Input
                id="project-description"
                placeholder="简短描述项目用途"
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                onKeyDown={(e) => { if (e.key === "Enter") void save(); }}
              />
            </div>

          </div>

          <DialogFooter>
            <Button variant="outline" onClick={closeDialog} disabled={saving}>
              取消
            </Button>
            <Button onClick={() => void save()} disabled={saving}>
              {saving ? (editingProject ? "保存中…" : "创建中…") : (editingProject ? "保存" : "创建")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除确认 dialog */}
      <Dialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) closeDeleteDialog(); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>删除项目</DialogTitle>
            <DialogDescription>
              此操作将永久删除项目及其下所有代码库和需求，且不可恢复。
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 py-2">
            <p className="text-sm text-muted-foreground">
              请输入项目名称{" "}
              <span className="font-medium text-foreground">
                {deleteTarget?.name}
              </span>{" "}
              以确认删除：
            </p>
            <Input
              placeholder={deleteTarget?.name}
              value={deleteInput}
              onChange={(e) => setDeleteInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && deleteInput === deleteTarget?.name) void confirmDelete();
              }}
              autoFocus
            />
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={closeDeleteDialog} disabled={deleting}>
              取消
            </Button>
            <Button
              variant="destructive"
              onClick={() => void confirmDelete()}
              disabled={deleting || deleteInput !== deleteTarget?.name}
            >
              {deleting ? "删除中…" : "确认删除"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Library 主容器（"历史" tab 已并入 Now 页，此处只剩项目列表）
// ---------------------------------------------------------------------------

export function Library() {
  // 历史 tab 已并入「现在」页，本页只剩项目列表
  return (
    <div className="mx-auto max-w-6xl px-4 py-6 md:px-6 md:py-8">
      <header className="mb-4 border-b border-border pb-3">
        <h1 className="font-display text-2xl font-bold">项目</h1>
        <p className="text-xs text-muted-foreground mt-1">
          按项目维度查看 / 新建 / 进入工作台
        </p>
      </header>

      <ProjectsTab />
    </div>
  );
}
