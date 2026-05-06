import React, { useCallback, useEffect, useState } from "react";
import { FolderGit2, Plus, Pencil, Trash2, Activity, RefreshCw, FolderOpen } from "lucide-react";
import { api, type Repo, type RepoHealthResult } from "@/hooks/useApi";
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

interface FormState {
  alias: string;
  path: string;
  default_branch: string;
  github_owner: string;
  github_repo: string;
}

const EMPTY: FormState = {
  alias: "",
  path: "",
  default_branch: "main",
  github_owner: "",
  github_repo: "",
};

type HealthState = "loading" | RepoHealthResult;

export function Repos() {
  const toast = useToast();
  const [repos, setRepos] = useState<Repo[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // 编辑/新建 Dialog
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingRepo, setEditingRepo] = useState<Repo | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY);
  const [saving, setSaving] = useState(false);

  // 健康检查结果 map: id -> HealthState
  const [healthMap, setHealthMap] = useState<Record<string, HealthState>>({});

  // 删除 busy
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // 文件夹选择器
  const [folderPickerOpen, setFolderPickerOpen] = useState(false);

  const refresh = useCallback(() => {
    setLoading(true);
    setLoadError(null);
    api
      .listRepos()
      .then(setRepos)
      .catch((e: unknown) => setLoadError((e as Error)?.message ?? String(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const startCreate = () => {
    setEditingRepo(null);
    setForm(EMPTY);
    setDialogOpen(true);
  };

  const startEdit = (repo: Repo) => {
    setEditingRepo(repo);
    setForm({
      alias: repo.alias,
      path: repo.path,
      default_branch: repo.default_branch,
      github_owner: repo.github_owner ?? "",
      github_repo: repo.github_repo ?? "",
    });
    setDialogOpen(true);
  };

  const closeDialog = () => {
    if (saving) return;
    setDialogOpen(false);
    setEditingRepo(null);
  };

  const save = async () => {
    const alias = form.alias.trim();
    const path = form.path.trim();
    if (!alias) {
      toast.error("验证失败", "别名不能为空");
      return;
    }
    if (!path) {
      toast.error("验证失败", "路径不能为空");
      return;
    }
    setSaving(true);
    try {
      const body = {
        alias,
        path,
        default_branch: form.default_branch.trim() || "main",
        github_owner: form.github_owner.trim() || null,
        github_repo: form.github_repo.trim() || null,
      };
      if (editingRepo) {
        await api.updateRepo(editingRepo.id, {
          path: body.path,
          default_branch: body.default_branch,
          github_owner: body.github_owner,
          github_repo: body.github_repo,
        });
        toast.success(`已更新仓库 ${alias}`);
      } else {
        await api.createRepo(body);
        toast.success(`已创建仓库 ${alias}`);
      }
      setDialogOpen(false);
      setEditingRepo(null);
      refresh();
    } catch (e: unknown) {
      toast.error(editingRepo ? "更新失败" : "创建失败", (e as Error)?.message ?? String(e));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (repo: Repo) => {
    if (!confirm(`确定删除仓库「${repo.alias}」？此操作不可撤销。`)) return;
    setDeletingId(repo.id);
    try {
      await api.deleteRepo(repo.id);
      toast.success(`已删除：${repo.alias}`);
      refresh();
    } catch (e: unknown) {
      toast.error("删除失败", (e as Error)?.message ?? String(e));
    } finally {
      setDeletingId(null);
    }
  };

  const checkHealth = async (repo: Repo) => {
    setHealthMap((prev) => ({ ...prev, [repo.id]: "loading" }));
    try {
      const result = await api.healthcheckRepo(repo.id);
      setHealthMap((prev) => ({ ...prev, [repo.id]: result }));
      if (result.healthy) {
        refresh();
      }
    } catch (e: unknown) {
      toast.error("健康检查失败", (e as Error)?.message ?? String(e));
      setHealthMap((prev) => {
        const next = { ...prev };
        delete next[repo.id];
        return next;
      });
    }
  };

  const renderHealthCell = (repo: Repo) => {
    const h = healthMap[repo.id];
    if (!h) return <span className="text-muted-foreground">—</span>;
    if (h === "loading") {
      return <span className="text-muted-foreground animate-pulse text-xs">检查中…</span>;
    }
    if (h.healthy) {
      return <span className="text-emerald-500 text-xs font-medium">✓ OK</span>;
    }
    return (
      <span className="text-destructive text-xs" title={h.issues.join("\n")}>
        ✗ {h.issues[0] ?? "异常"}
      </span>
    );
  };

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4 md:p-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">仓库管理</h2>
          <p className="text-sm text-muted-foreground">
            管理工作流可引用的代码仓库，支持健康检查与 GitHub 关联。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={refresh} disabled={loading}>
            <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
            刷新
          </Button>
          <Button size="sm" onClick={startCreate}>
            <Plus className="h-4 w-4" />
            新建仓库
          </Button>
        </div>
      </div>

      {loadError && (
        <Card className="border-destructive/50 p-4">
          <p className="text-sm text-destructive">加载失败：{loadError}</p>
        </Card>
      )}

      {!loading && repos.length === 0 && !loadError && (
        <Card className="p-8 text-center">
          <FolderGit2 className="mx-auto mb-3 h-8 w-8 text-muted-foreground/40" />
          <p className="text-sm text-muted-foreground">
            暂无仓库，点「新建仓库」开始。
          </p>
        </Card>
      )}

      {repos.length > 0 && (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
                  <th className="px-4 py-2.5 font-medium">别名</th>
                  <th className="px-4 py-2.5 font-medium">路径</th>
                  <th className="px-4 py-2.5 font-medium">默认分支</th>
                  <th className="px-4 py-2.5 font-medium">GitHub</th>
                  <th className="px-4 py-2.5 font-medium">健康</th>
                  <th className="px-4 py-2.5 font-medium text-right">操作</th>
                </tr>
              </thead>
              <tbody>
                {repos.map((repo, idx) => (
                  <tr
                    key={repo.id}
                    className={cn(
                      "border-b last:border-0 transition-colors hover:bg-muted/30",
                      idx % 2 === 1 && "bg-muted/10",
                    )}
                  >
                    <td className="px-4 py-2.5">
                      <span className="font-mono font-medium text-sm">{repo.alias}</span>
                    </td>
                    <td className="px-4 py-2.5 max-w-[220px]">
                      <span
                        className="font-mono text-xs text-muted-foreground truncate block"
                        title={repo.path}
                      >
                        {repo.path}
                      </span>
                    </td>
                    <td className="px-4 py-2.5">
                      <Badge variant="secondary" className="font-mono text-[11px] font-normal">
                        {repo.default_branch}
                      </Badge>
                    </td>
                    <td className="px-4 py-2.5 text-xs text-muted-foreground font-mono">
                      {repo.github_owner && repo.github_repo
                        ? `${repo.github_owner}/${repo.github_repo}`
                        : "—"}
                    </td>
                    <td className="px-4 py-2.5">{renderHealthCell(repo)}</td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={() => checkHealth(repo)}
                          disabled={healthMap[repo.id] === "loading" || deletingId === repo.id}
                          title="健康检查"
                        >
                          <Activity className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={() => startEdit(repo)}
                          disabled={deletingId === repo.id}
                          title="编辑"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-destructive hover:text-destructive"
                          onClick={() => remove(repo)}
                          disabled={deletingId === repo.id}
                          title="删除"
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

      <Dialog open={dialogOpen} onOpenChange={(open) => { if (!open) closeDialog(); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{editingRepo ? "编辑仓库" : "新建仓库"}</DialogTitle>
            <DialogDescription>
              {editingRepo
                ? "修改仓库信息。别名唯一且创建后不可更改。"
                : "填写仓库信息。别名创建后不可更改。"}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="repo-alias">
                别名 <span className="text-destructive">*</span>
              </Label>
              <Input
                id="repo-alias"
                placeholder="例如：my-app"
                value={form.alias}
                disabled={!!editingRepo}
                onChange={(e) => setForm((f) => ({ ...f, alias: e.target.value }))}
              />
              {editingRepo && (
                <p className="text-xs text-muted-foreground">别名创建后不可修改。</p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="repo-path">
                路径 <span className="text-destructive">*</span>
              </Label>
              <div className="flex items-center gap-2">
                <Input
                  id="repo-path"
                  placeholder="例如：/home/user/projects/my-app"
                  value={form.path}
                  onChange={(e) => setForm((f) => ({ ...f, path: e.target.value }))}
                  className="flex-1"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="shrink-0"
                  onClick={() => setFolderPickerOpen(true)}
                  title="浏览文件夹"
                >
                  <FolderOpen className="h-4 w-4" />
                  浏览…
                </Button>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="repo-branch">默认分支</Label>
              <Input
                id="repo-branch"
                placeholder="main"
                value={form.default_branch}
                onChange={(e) => setForm((f) => ({ ...f, default_branch: e.target.value }))}
              />
            </div>

            <div className="space-y-1.5">
              <Label>GitHub（可选）</Label>
              <div className="flex gap-2">
                <Input
                  placeholder="owner"
                  value={form.github_owner}
                  onChange={(e) => setForm((f) => ({ ...f, github_owner: e.target.value }))}
                  className="flex-1"
                />
                <span className="self-center text-muted-foreground">/</span>
                <Input
                  placeholder="repo"
                  value={form.github_repo}
                  onChange={(e) => setForm((f) => ({ ...f, github_repo: e.target.value }))}
                  className="flex-1"
                />
              </div>
              <p className="text-xs text-muted-foreground">填写后可在健康检查时验证远端连通性。</p>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={closeDialog} disabled={saving}>
              取消
            </Button>
            <Button onClick={save} disabled={saving}>
              {saving ? "保存中…" : editingRepo ? "保存修改" : "创建"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 文件夹浏览器 */}
      <FolderPicker
        open={folderPickerOpen}
        initialPath={form.path || undefined}
        onSelect={(path) => {
          setForm((f) => ({ ...f, path }));
          setFolderPickerOpen(false);
        }}
        onCancel={() => setFolderPickerOpen(false)}
      />
    </div>
  );
}
