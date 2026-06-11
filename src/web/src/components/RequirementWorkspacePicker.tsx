import { useEffect, useState } from "react";
import { FolderGit2, Plus, Star, Loader2 } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/components/Toast";
import { api, type Requirement, type Workspace } from "@/hooks/useApi";
import { cn } from "@/lib/utils";

/**
 * 审批阶段的代码库反写卡片（UI「代码库」= 内核 workspace）。
 *
 * - 多选项目下的代码库（checkbox），主库（任务执行库）用星标单选
 * - 「自定义」内联新建：remote_url（+ 可选别名）→ workspaces.create（probeRemote 验证）→ 自动选中
 * - 每次变更即时调 requirements.setWorkspaces 反写（PUT 语义幂等），无独立保存按钮
 * - 约束：至少保留一个；取消主库时自动提升剩余第一个为主库
 */
export function RequirementWorkspacePicker({
  requirement: req,
  workspaces,
  disabled,
  onChanged,
}: {
  requirement: Requirement;
  /** 该需求所属项目下的全部代码库 */
  workspaces: Workspace[];
  disabled?: boolean;
  /** 反写成功 / 新建代码库后通知父组件刷新 */
  onChanged: () => void;
}) {
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [primary, setPrimary] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [newUrl, setNewUrl] = useState("");
  const [newAlias, setNewAlias] = useState("");
  const [creating, setCreating] = useState(false);

  // 服务端状态 → 本地选择态（req 或集合变化时重置）
  useEffect(() => {
    const ids = req.workspace_ids && req.workspace_ids.length > 0
      ? req.workspace_ids
      : req.workspace_id ? [req.workspace_id] : [];
    setSelected(new Set(ids));
    setPrimary(req.workspace_id ?? ids[0] ?? null);
  }, [req.id, req.workspace_id, JSON.stringify(req.workspace_ids ?? [])]);

  async function persist(nextIds: string[], nextPrimary: string) {
    setSaving(true);
    try {
      await api.setRequirementWorkspaces(req.id, nextIds, nextPrimary);
      onChanged();
    } catch (e: unknown) {
      toast.error("代码库设置失败", (e as Error)?.message ?? String(e));
      onChanged(); // 回拉服务端状态，丢弃本地脏选择
    } finally {
      setSaving(false);
    }
  }

  function toggle(wsId: string) {
    const next = new Set(selected);
    if (next.has(wsId)) {
      if (next.size === 1) {
        toast.error("至少保留一个代码库");
        return;
      }
      next.delete(wsId);
    } else {
      next.add(wsId);
    }
    // 主库被取消 → 自动提升剩余第一个
    let nextPrimary = primary && next.has(primary) ? primary : [...next][0]!;
    setSelected(next);
    setPrimary(nextPrimary);
    void persist([...next], nextPrimary);
  }

  function makePrimary(wsId: string) {
    if (!selected.has(wsId) || wsId === primary) return;
    setPrimary(wsId);
    void persist([...selected], wsId);
  }

  /** 从 remote_url 推导别名（owner/repo.git → repo） */
  function deriveAlias(url: string): string {
    const m = url.replace(/\.git$/, "").match(/([^/:]+)$/);
    return m ? m[1]! : "";
  }

  async function createCustom() {
    const url = newUrl.trim();
    if (!url) {
      toast.error("远程仓库地址不能为空");
      return;
    }
    const alias = newAlias.trim() || deriveAlias(url);
    if (!alias) {
      toast.error("无法从地址推导别名，请手动填写");
      return;
    }
    setCreating(true);
    try {
      const ws = await api.createWorkspace({ alias, remote_url: url, project_id: req.project_id });
      // 新库自动加入选中集合并反写
      const next = new Set(selected);
      next.add(ws.id);
      const nextPrimary = primary ?? ws.id;
      setSelected(next);
      setPrimary(nextPrimary);
      await api.setRequirementWorkspaces(req.id, [...next], nextPrimary);
      toast.success(`已添加代码库「${alias}」并选中`);
      setNewUrl("");
      setNewAlias("");
      setAddOpen(false);
      onChanged();
    } catch (e: unknown) {
      toast.error("添加代码库失败", (e as Error)?.message ?? String(e));
    } finally {
      setCreating(false);
    }
  }

  return (
    <Card className="p-4">
      <div className="mb-2 flex items-center gap-2">
        <FolderGit2 className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-semibold">代码库</span>
        <span className="font-mono text-[10px] text-muted-foreground">
          已选 {selected.size} · 星标 = 主库（任务在此执行）
        </span>
        {saving && <Loader2 className="ml-auto h-3.5 w-3.5 animate-spin text-muted-foreground" />}
      </div>
      <p className="mb-3 text-xs text-muted-foreground">
        本需求涉及哪些代码库由你在此确认；任务只在主库改动并提交，其余作为只读上下文提供给 Agent。
      </p>

      {workspaces.length === 0 && (
        <p className="mb-2 text-xs text-muted-foreground">项目下暂无代码库，用下方「自定义」添加。</p>
      )}

      <ul className="space-y-1">
        {workspaces.map((w) => {
          const checked = selected.has(w.id);
          const isPrimary = primary === w.id;
          return (
            <li
              key={w.id}
              className={cn(
                "flex items-center gap-2.5 rounded-md border px-2.5 py-2",
                checked ? "border-accent/40 bg-accent/5" : "border-border",
              )}
            >
              <Checkbox
                checked={checked}
                onChange={() => toggle(w.id)}
                disabled={disabled || saving}
                id={`ws-pick-${w.id}`}
              />
              <label htmlFor={`ws-pick-${w.id}`} className="min-w-0 flex-1 cursor-pointer">
                <span className="font-mono text-sm">{w.alias}</span>
                <span className="ml-2 truncate font-mono text-[10px] text-muted-foreground">
                  {w.remote_url ?? "(无远程地址)"}
                </span>
              </label>
              <button
                type="button"
                title={isPrimary ? "主库（任务在此执行）" : "设为主库"}
                aria-label={isPrimary ? `主库 ${w.alias}` : `设 ${w.alias} 为主库`}
                disabled={disabled || saving || !checked}
                onClick={() => makePrimary(w.id)}
                className={cn(
                  "shrink-0 rounded p-1 transition-colors disabled:opacity-30",
                  isPrimary ? "text-warning" : "text-muted-foreground/50 hover:text-foreground",
                )}
              >
                <Star className={cn("h-4 w-4", isPrimary && "fill-current")} />
              </button>
            </li>
          );
        })}
      </ul>

      {/* 自定义：输入远程地址新建并选中 */}
      {addOpen ? (
        <div className="mt-3 space-y-2 rounded-md border border-dashed border-border p-3">
          <Input
            placeholder="https://github.com/owner/repo.git"
            value={newUrl}
            onChange={(e) => setNewUrl(e.target.value)}
            disabled={creating}
          />
          <Input
            placeholder={`别名（可选，默认 ${deriveAlias(newUrl) || "从仓库名推导"}）`}
            value={newAlias}
            onChange={(e) => setNewAlias(e.target.value)}
            disabled={creating}
          />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setAddOpen(false)} disabled={creating}>
              取消
            </Button>
            <Button size="sm" onClick={() => void createCustom()} disabled={creating || !newUrl.trim()}>
              {creating ? "验证远程可达性…" : "添加并选中"}
            </Button>
          </div>
        </div>
      ) : (
        <Button
          variant="outline"
          size="sm"
          className="mt-3 w-full"
          onClick={() => setAddOpen(true)}
          disabled={disabled}
        >
          <Plus className="h-3.5 w-3.5" />
          自定义代码库（输入远程地址）
        </Button>
      )}
    </Card>
  );
}
