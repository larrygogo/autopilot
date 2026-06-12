import React, { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Layers, Plus, RefreshCw, Pencil, Trash2, MoreHorizontal } from "lucide-react";
import { ConfirmDialog, EmptyState, EntityGrid, EntityList, ErrorState, FormDialog, FormField, PageHero, PageShell, SkeletonRows, ViewToggle, useViewMode, type EntityCardItem } from "@/components/pro";
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



  const [deleteTarget, setDeleteTarget] = useState<Project | null>(null);
  const [deleting, setDeleting] = useState(false);

  // grid / list 视图（localStorage 记住偏好）
  const [view, setView] = useViewMode("library.projects.view");

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
    setDialogOpen(false);
    setEditingProject(null);
  };

  // busy / 内联错误 / 成功关闭由 FormDialog 骨架接管：抛错 = 失败（内联展示），正常返回 = 成功
  const save = async () => {
    const name = form.name.trim();
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
    setEditingProject(null);
    refresh();
  };

  const openDeleteDialog = (p: Project, e: React.MouseEvent) => {
    e.stopPropagation();
    setDeleteTarget(p);
  };

  const closeDeleteDialog = () => {
    if (deleting) return;
    setDeleteTarget(null);
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api.deleteProject(deleteTarget.id);
      toast.success(`已删除项目「${deleteTarget.name}」`);
      setDeleteTarget(null);
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

  const projectItems: EntityCardItem[] = projects.map((project) => ({
    key: project.id,
    title: project.name,
    subtitle: project.id,
    description: project.description || undefined,
    meta: `创建于 ${new Date(project.created_at).toLocaleDateString("zh-CN")}`,
    menu: projectMenu(project),
    icon: Layers,
    onOpen: () => navigate("/projects/" + project.id),
  }));

  return (
    <div className="space-y-4">
      {/* 列表页统一骨架：PageHero（标题+副标+主创建按钮）+ 工具行（计数+视图切换） */}
      <PageHero
        title="项目"
        subtitle="按项目维度查看 / 新建 / 进入工作台"
        actions={
          <Button onClick={openCreateDialog}>
            <Plus className="h-4 w-4" />
            新建项目
          </Button>
        }
      />
      <div className="flex items-center justify-between gap-3">
        <p className="bp-label text-muted-foreground">
          共 {projects.length} 个项目
        </p>
        <ViewToggle view={view} onChange={setView} />
      </div>

      {loadError && <ErrorState title="加载项目失败" detail={loadError} onRetry={refresh} />}

      {loading && <SkeletonRows variant="card" count={3} />}

      {!loading && !loadError && projects.length === 0 && (
        <EmptyState
          size="page"
          icon={Layers}
          title="暂无项目"
          hint="项目是需求与代码库的工作台，先建一个开始"
          action={
            <Button size="sm" onClick={openCreateDialog}>
              <Plus className="h-4 w-4" />
              新建项目
            </Button>
          }
        />
      )}

      {/* grid / list：共享实体目录模板（EntityCards，与工作流目录同款） */}
      {!loading && projects.length > 0 && view === "grid" && <EntityGrid items={projectItems} />}
      {!loading && projects.length > 0 && view === "list" && <EntityList items={projectItems} />}

      {/* 新建 / 编辑 dialog（FormDialog 骨架：busy/内联错误/Enter 提交由骨架接管） */}
      <FormDialog
        open={dialogOpen}
        onOpenChange={(open) => { if (!open) closeDialog(); }}
        title={editingProject ? "编辑项目" : "新建项目"}
        description={
          editingProject
            ? "修改项目名称或描述。"
            : "填写名称即可创建；Git 仓库稍后在项目的「代码库」里关联。"
        }
        submitText={editingProject ? "保存" : "创建"}
        submitDisabled={!form.name.trim()}
        onSubmit={save}
      >
        <FormField label="名称" required htmlFor="project-name">
          <Input
            id="project-name"
            placeholder="例如：My Awesome App"
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          />
        </FormField>
        <FormField label="描述（可选）" htmlFor="project-description">
          <Input
            id="project-description"
            placeholder="简短描述项目用途"
            value={form.description}
            onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
          />
        </FormField>
      </FormDialog>

      {/* 删除确认：不可逆且高代价 → ConfirmDialog confirmWord（规范 docs/web-components.md §3） */}
      <ConfirmDialog
        open={!!deleteTarget}
        title="删除项目"
        message="此操作将永久删除项目及其下所有代码库和需求，且不可恢复。"
        danger
        confirmWord={deleteTarget?.name}
        confirmText="确认删除"
        onConfirm={confirmDelete}
        onCancel={closeDeleteDialog}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Library 主容器（"历史" tab 已并入 Now 页，此处只剩项目列表）
// ---------------------------------------------------------------------------

export function Library() {
  // 历史 tab 已并入「现在」页，本页只剩项目列表（页头在 ProjectsTab 内，
  // 新建按钮要挂 PageHero actions 而 dialog state 在 tab 组件里）
  return (
    <PageShell width="content">
      <ProjectsTab />
    </PageShell>
  );
}
