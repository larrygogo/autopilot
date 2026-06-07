import React, { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Layers, Plus, RefreshCw, Pencil, Trash2, FolderOpen } from "lucide-react";
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
import { FolderPicker } from "@/components/FolderPicker";
import { api, type Project } from "@/hooks/useApi";
import { useToast } from "@/components/Toast";
import { cn, folderName } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Projects tab（原 src/web/src/pages/Projects.tsx 内联简化版，去 PageHero）
// ---------------------------------------------------------------------------

interface FormState {
  name: string;
  description: string;
  path: string;
  alias: string;
}

const EMPTY_FORM: FormState = { name: "", description: "", path: "", alias: "" };

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
  const [folderPickerOpen, setFolderPickerOpen] = useState(false);
  // 记录上次自动推导的 alias，用于判断用户是否手动修改过
  const [lastAutoAlias, setLastAutoAlias] = useState("");

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

  // WS：projects:* 自动 refetch（含跨标签页 / 跨设备的项目变化）
  useEffect(() => {
    const unsub = subscribe("projects:*", () => refresh());
    return unsub;
  }, [subscribe, refresh]);

  const openCreateDialog = () => {
    setEditingProject(null);
    setForm(EMPTY_FORM);
    setLastAutoAlias("");
    setDialogOpen(true);
  };

  const openEditDialog = (p: Project, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingProject(p);
    setForm({ name: p.name, description: p.description ?? "", path: "", alias: "" });
    setDialogOpen(true);
  };

  const closeDialog = () => {
    if (saving) return;
    setDialogOpen(false);
    setEditingProject(null);
  };

  /** path 变化时自动推导 alias（仅新建模式；用户手改过的不覆盖） */
  const handlePathChange = (newPath: string) => {
    setForm((f) => {
      const autoAlias = folderName(newPath);
      // alias 为空、或仍是上次自动推导值 → 跟随更新
      const shouldAutoFill = !f.alias.trim() || f.alias.trim() === lastAutoAlias;
      if (shouldAutoFill && autoAlias) setLastAutoAlias(autoAlias);
      return {
        ...f,
        path: newPath,
        alias: shouldAutoFill && autoAlias ? autoAlias : f.alias,
      };
    });
  };

  const save = async () => {
    const name = form.name.trim();
    if (!name) {
      toast.error("验证失败", "项目名称不能为空");
      return;
    }
    if (!editingProject && !form.path.trim()) {
      toast.error("验证失败", "工作区路径不能为空");
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
        const result = await api.createProjectWithWorkspace({
          name,
          description: form.description.trim() || undefined,
          path: form.path.trim(),
          alias: form.alias.trim() || undefined,
        });
        toast.success(`已创建项目「${name}」`);
        // 创建成功后跳转到项目详情页
        setDialogOpen(false);
        setEditingProject(null);
        refresh();
        navigate(`/projects/${result.project.id}`);
        return;
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
    <div className="space-y-4 pt-4">
      <div className="flex items-center justify-between gap-3">
        <p className="bp-label text-muted-foreground">
          共 {projects.length} 个项目
        </p>
        <div className="flex items-center gap-2">
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

      {!loading && projects.length > 0 && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((project) => (
            <Card
              key={project.id}
              className="flex cursor-pointer flex-col p-4 transition-colors hover:border-accent"
              onClick={() => navigate("/projects/" + project.id)}
            >
              {/* eyebrow + 项目 id（蓝图风） */}
              <div className="mb-2 flex items-center gap-2 bp-label text-muted-foreground">
                <Layers className="h-3 w-3" />
                <span className="font-mono">{project.id}</span>
              </div>
              <h3 className="text-base font-bold leading-tight line-clamp-2">
                {project.name}
              </h3>
              {project.description && (
                <p className="mt-2 text-xs leading-relaxed text-muted-foreground line-clamp-2">
                  {project.description}
                </p>
              )}
              {/* 底部 footer：创建时间 + 永远可见的 edit / delete（不依赖 hover，键盘 / 触屏均可达） */}
              <div className="mt-auto flex items-center justify-between border-t border-border pt-2">
                <span className="text-[11px] text-muted-foreground">
                  创建于 {new Date(project.created_at).toLocaleDateString("zh-CN")}
                </span>
                <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={(e) => openEditDialog(project, e)}
                    disabled={deleteTarget?.id === project.id}
                    title="编辑"
                    aria-label={`编辑项目 ${project.name}`}
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
                    aria-label={`删除项目 ${project.name}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
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
                : "填写项目名称、描述，并指定本地代码目录作为工作区。"}
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

            {/* 新建模式：工作区字段 */}
            {!editingProject && (
              <>
                <div className="border-t border-border pt-3">
                  <p className="text-xs font-medium text-muted-foreground mb-3">工作区</p>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="project-path">
                    本地路径 <span className="text-destructive">*</span>
                  </Label>
                  <div className="flex gap-2">
                    <Input
                      id="project-path"
                      className="flex-1"
                      placeholder="例如：/code/myapp"
                      value={form.path}
                      onChange={(e) => handlePathChange(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") void save(); }}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      className="shrink-0"
                      onClick={() => setFolderPickerOpen(true)}
                      title="选择文件夹"
                    >
                      <FolderOpen className="h-4 w-4" />
                    </Button>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="project-alias">别名（可选，缺省取目录名）</Label>
                  <Input
                    id="project-alias"
                    placeholder={folderName(form.path) || "workspace"}
                    value={form.alias}
                    onChange={(e) => setForm((f) => ({ ...f, alias: e.target.value }))}
                    onKeyDown={(e) => { if (e.key === "Enter") void save(); }}
                  />
                </div>
              </>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={closeDialog} disabled={saving}>
              取消
            </Button>
            <Button onClick={() => void save()} disabled={saving}>
              {saving ? (editingProject ? "保存中…" : "创建中…") : (editingProject ? "保存" : "创建项目")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 文件夹选择器（仅新建模式使用） */}
      <FolderPicker
        open={folderPickerOpen}
        initialPath={form.path || undefined}
        onSelect={(path) => {
          handlePathChange(path);
          setFolderPickerOpen(false);
        }}
        onCancel={() => setFolderPickerOpen(false)}
      />

      {/* 删除确认 dialog */}
      <Dialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) closeDeleteDialog(); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>删除项目</DialogTitle>
            <DialogDescription>
              此操作将永久删除项目及其下所有工作区和需求，且不可恢复。
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
