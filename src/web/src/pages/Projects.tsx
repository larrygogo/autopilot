import React, { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Layers, Plus, RefreshCw, Pencil, Trash2 } from "lucide-react";
import { api, type Project } from "@/hooks/useApi";
import { useToast } from "@/components/Toast";
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
import { cn } from "@/lib/utils";
import { PageHero } from "@/components/PageHero";

interface FormState {
  name: string;
  description: string;
}

const EMPTY_FORM: FormState = { name: "", description: "" };

export function Projects() {
  const navigate = useNavigate();
  const toast = useToast();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // 新建 / 编辑 dialog
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingProject, setEditingProject] = useState<Project | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  // 删除确认 dialog
  const [deleteTarget, setDeleteTarget] = useState<Project | null>(null);
  const [deleteInput, setDeleteInput] = useState("");
  const [deleting, setDeleting] = useState(false);

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
        await api.updateProject(editingProject.id, {
          name,
          description: form.description.trim() || null,
        });
        toast.success(`已更新项目「${name}」`);
      } else {
        await api.createProject({
          name,
          description: form.description.trim() || undefined,
        });
        toast.success(`已创建项目「${name}」`);
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

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4 md:p-6">
      <PageHero
        eyebrow="SHEET · PROJECTS / 项目工作台"
        title="Projects"
        subtitle="项目 · 工作台"
        description="顶层工作空间。每个项目可关联多个 Codebase 与多条 Requirement。"
        meta={[
          { k: "TOTAL", v: projects.length },
        ]}
        actions={
          <>
            <Button variant="outline" size="sm" onClick={refresh} disabled={loading}>
              <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
              刷新
            </Button>
            <Button size="sm" onClick={openCreateDialog}>
              <Plus className="h-4 w-4" />
              新建项目
            </Button>
          </>
        }
      />

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

      {!loading && projects.length > 0 && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((project) => (
            <Card
              key={project.id}
              className="group relative cursor-pointer p-5 hover:shadow-md transition-shadow"
              onClick={() => navigate("/projects/" + project.id)}
            >
              {/* 操作按钮（hover 时显示） */}
              <div className="absolute right-3 top-3 hidden items-center gap-1 group-hover:flex">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={(e) => openEditDialog(project, e)}
                  disabled={deleteTarget?.id === project.id}
                  title="编辑"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-destructive hover:text-destructive"
                  onClick={(e) => openDeleteDialog(project, e)}
                  disabled={deleteTarget?.id === project.id}
                  title="删除"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>

              <div className="space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <h3 className="font-semibold leading-tight tracking-tight line-clamp-2 pr-14">
                    {project.name}
                  </h3>
                  <Layers className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground/60 group-hover:invisible" />
                </div>
                {project.description && (
                  <p className="text-sm text-muted-foreground line-clamp-3">
                    {project.description}
                  </p>
                )}
                <p className="text-xs text-muted-foreground/70">
                  创建于 {new Date(project.created_at).toLocaleDateString("zh-CN")}
                </p>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* 新建 / 编辑 dialog */}
      <Dialog open={dialogOpen} onOpenChange={(open) => { if (!open) closeDialog(); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{editingProject ? "编辑项目" : "新建项目"}</DialogTitle>
            <DialogDescription>
              {editingProject
                ? "修改项目名称或描述。"
                : "填写项目名称和描述，创建后可在项目工作台中关联代码库和需求。"}
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
