import { useEffect, useState } from "react";
import { FolderGit2, Plus, Loader2, Trash2 } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/components/Toast";
import { api, type Requirement, type Workspace } from "@/hooks/useApi";
import { cn } from "@/lib/utils";

/**
 * 需求的代码库确认/反写卡片（UI「代码库」= 内核 workspace）。
 *
 * - 纯多选项目下的代码库（checkbox），无主/副之分——所有已选库均可改动、各自交付 PR
 * - 「自定义」内联新建：remote_url（+ 可选别名）→ workspaces.create（probeRemote 验证）→ 自动选中
 * - 未勾选的库可就地删除（勾选中 = 本需求在用，先取消勾选；其他需求引用时后端 IN_USE 拦截）
 * - 每次变更即时调 requirements.setWorkspaces 反写（PUT 语义幂等），无独立保存按钮
 * - 约束：至少保留一个
 * - readOnly：只渲染只读摘要（已选库），无任何编辑入口。审批及之后用 ——
 *   代码库在澄清前确认、开始澄清即冻结（中途换库会让澄清失效），后端 setWorkspaces 同口径拦截
 */
export function RequirementWorkspacePicker({
  requirement: req,
  workspaces,
  disabled,
  readOnly,
  allowEmpty,
  emptyHint,
  onChanged,
}: {
  requirement: Requirement;
  /** 该需求所属项目下的全部代码库 */
  workspaces: Workspace[];
  disabled?: boolean;
  /** 只读摘要模式（澄清开始后代码库冻结） */
  readOnly?: boolean;
  /** 允许空集确认（v2 R5：所选工作流 requires.git 为 "optional"/false 时，无库需求可走完整闭环） */
  allowEmpty?: boolean;
  /** allowEmpty 时展示的说明文案（如「此工作流不要求代码库」） */
  emptyHint?: string;
  /** 反写成功 / 新建代码库后通知父组件刷新 */
  onChanged: () => void;
}) {
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [addOpen, setAddOpen] = useState(false);
  const [newUrl, setNewUrl] = useState("");
  const [newAlias, setNewAlias] = useState("");
  const [creating, setCreating] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // 服务端状态 → 本地选择态（req 或集合变化时重置）
  useEffect(() => {
    const ids = req.workspace_ids && req.workspace_ids.length > 0
      ? req.workspace_ids
      : req.workspace_id ? [req.workspace_id] : [];
    setSelected(new Set(ids));
  }, [req.id, req.workspace_id, JSON.stringify(req.workspace_ids ?? [])]);

  async function persist(nextIds: string[]) {
    setSaving(true);
    try {
      await api.setRequirementWorkspaces(req.id, nextIds);
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
      // 所选工作流要求代码库时至少保留一个；不要求（allowEmpty）时可清空 = 确认无库
      if (next.size === 1 && !allowEmpty) {
        toast.error("至少保留一个代码库", "当前工作流需要代码库；如需无库需求请先换用不要求代码库的工作流。");
        return;
      }
      next.delete(wsId);
    } else {
      next.add(wsId);
    }
    setSelected(next);
    void persist([...next]);
  }

  /** 从 remote_url 推导别名（owner/repo.git → repo） */
  function deriveAlias(url: string): string {
    const m = url.replace(/\.git$/, "").match(/([^/:]+)$/);
    return m ? m[1]! : "";
  }

  async function deleteUnused(w: Workspace) {
    if (!window.confirm(`删除代码库「${w.alias}」？仅删除注册记录，远程仓库本身不受影响。`)) return;
    setDeletingId(w.id);
    try {
      await api.deleteWorkspace(w.id);
      toast.success(`已删除代码库「${w.alias}」`);
      onChanged();
    } catch (e: unknown) {
      toast.error("删除失败", (e as Error)?.message ?? String(e));
    } finally {
      setDeletingId(null);
    }
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
      setSelected(next);
      await api.setRequirementWorkspaces(req.id, [...next]);
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

  // 只读态：澄清开始后代码库冻结（中途换库会让澄清失效），仅展示无编辑入口
  if (readOnly) {
    const chosen = workspaces.filter((w) => selected.has(w.id));
    return (
      <Card className="p-4">
        <div className="flex items-center gap-2">
          <FolderGit2 className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="shrink-0 text-sm font-semibold">代码库</span>
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
            {chosen.length === 0 ? (
              <span className="font-mono text-xs text-muted-foreground">无（已确认为无库需求）</span>
            ) : chosen.map((w) => (
              <span
                key={w.id}
                className="inline-flex items-center gap-1 rounded-md border border-border bg-muted/40 px-2 py-0.5 font-mono text-xs"
                title={w.remote_url ?? undefined}
              >
                {w.alias}
              </span>
            ))}
          </div>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          {chosen.length === 0
            ? "已确认不关联代码库（纯文本澄清，按所选工作流交付）。"
            : "已在澄清前确认，开始澄清后冻结。所有已选库均可改动、各自交付 PR。"}
        </p>
      </Card>
    );
  }

  return (
    <Card className="p-4">
      <div className="mb-2 flex items-center gap-2">
        <FolderGit2 className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-semibold">代码库</span>
        <span className="font-mono text-[10px] text-muted-foreground">
          已选 {selected.size}
        </span>
        {saving && <Loader2 className="ml-auto h-3.5 w-3.5 animate-spin text-muted-foreground" />}
      </div>
      <p className="mb-3 text-xs text-muted-foreground">
        本需求涉及哪些代码库由你在此确认；所有已选库均可改动、各自交付 PR。
      </p>

      {allowEmpty && (
        <p className="mb-3 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          {emptyHint ?? "此工作流不要求代码库"}——可不选任何库直接开始（AI 走纯文本澄清，按工作流产出交付物）；选了库则作为参考克隆给 AI。
        </p>
      )}

      {workspaces.length === 0 && (
        <p className="mb-2 text-xs text-muted-foreground">项目下暂无代码库，用下方「自定义」添加。</p>
      )}

      <ul className="space-y-1">
        {workspaces.map((w) => {
          const checked = selected.has(w.id);
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
                title={checked ? "本需求正在使用，先取消勾选才能删除" : "删除此代码库（仅注册记录）"}
                aria-label={`删除代码库 ${w.alias}`}
                disabled={disabled || saving || checked || deletingId === w.id}
                onClick={() => void deleteUnused(w)}
                className="shrink-0 rounded p-1 text-muted-foreground/50 transition-colors hover:text-destructive disabled:opacity-30"
              >
                {deletingId === w.id
                  ? <Loader2 className="h-4 w-4 animate-spin" />
                  : <Trash2 className="h-4 w-4" />}
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
