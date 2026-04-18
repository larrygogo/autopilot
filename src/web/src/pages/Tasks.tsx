import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Plus, Search, X } from "lucide-react";
import { api } from "@/hooks/useApi";
import { NewTaskDialog } from "@/components/NewTaskDialog";
import { ConfirmDialog } from "@/components/Modal";
import { useToast } from "@/components/Toast";
import { TasksOverview } from "@/components/TasksOverview";
import { StatusBadge } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

interface Task {
  id: string;
  title: string;
  workflow: string;
  status: string;
  created_at: string;
  updated_at: string;
}

interface TasksProps {
  onSelect: (id: string) => void;
  subscribe: (channel: string, handler: (event: any) => void) => () => void;
}

type StatusGroup = "all" | "awaiting" | "running" | "pending" | "done" | "cancelled" | "failed";

const STATUS_GROUPS: { key: StatusGroup; label: string; match: (s: string) => boolean }[] = [
  { key: "all", label: "全部", match: () => true },
  { key: "awaiting", label: "待人工", match: (s) => s.startsWith("awaiting_") },
  { key: "running", label: "运行中", match: (s) => s.startsWith("running_") },
  { key: "pending", label: "待处理", match: (s) => s.startsWith("pending_") },
  { key: "done", label: "已完成", match: (s) => s === "done" },
  { key: "cancelled", label: "已取消", match: (s) => s === "cancelled" || s === "canceled" },
  { key: "failed", label: "失败", match: (s) => s === "failed" || s === "error" },
];

const TERMINAL_PREFIXES = ["done", "cancelled", "canceled", "failed", "error"];
function isTerminal(status: string): boolean {
  return TERMINAL_PREFIXES.includes(status);
}

export function Tasks({ onSelect, subscribe }: TasksProps) {
  const toast = useToast();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [newOpen, setNewOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusGroup>("all");
  const [workflowFilter, setWorkflowFilter] = useState<string>("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  const refresh = useCallback(() => {
    api
      .listTasks()
      .then(setTasks)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => subscribe("task:*", () => refresh()), [subscribe, refresh]);

  const workflowOptions = useMemo(() => {
    const set = new Set<string>();
    for (const t of tasks) set.add(t.workflow);
    return [...set].sort();
  }, [tasks]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const statusMatch = STATUS_GROUPS.find((g) => g.key === statusFilter)!.match;
    return tasks.filter((t) => {
      if (!statusMatch(t.status)) return false;
      if (workflowFilter !== "all" && t.workflow !== workflowFilter) return false;
      if (q && !t.id.toLowerCase().includes(q) && !t.title.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [tasks, search, statusFilter, workflowFilter]);

  const cancellableSelected = useMemo(
    () => filtered.filter((t) => selected.has(t.id) && !isTerminal(t.status)),
    [filtered, selected],
  );

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    const filteredIds = filtered.map((t) => t.id);
    const allSelected = filteredIds.every((id) => selected.has(id));
    setSelected(
      allSelected
        ? new Set([...selected].filter((id) => !filteredIds.includes(id)))
        : new Set([...selected, ...filteredIds]),
    );
  };

  const clearSelection = () => setSelected(new Set());

  const doBulkCancel = async () => {
    setCancelling(true);
    let ok = 0,
      fail = 0;
    for (const t of cancellableSelected) {
      try {
        await api.cancelTask(t.id);
        ok++;
      } catch {
        fail++;
      }
    }
    setCancelling(false);
    setConfirmOpen(false);
    if (fail === 0) toast.success(`已请求取消 ${ok} 个任务`);
    else toast.warning(`请求取消 ${ok} 个任务，${fail} 个失败`);
    clearSelection();
    refresh();
  };

  const totalMatched = filtered.length;
  const totalAll = tasks.length;
  const allFilteredSelected = filtered.length > 0 && filtered.every((t) => selected.has(t.id));
  const hasActiveFilter =
    search.trim().length > 0 || statusFilter !== "all" || workflowFilter !== "all";

  if (loading) {
    return (
      <div className="mx-auto w-full max-w-6xl px-5 py-8 text-sm text-muted-foreground">加载中…</div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-6xl px-5 py-6">
      <TasksOverview tasks={tasks} onSelectTask={onSelect} />

      <div className="mb-4 flex items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">任务列表</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {totalMatched === totalAll ? `${totalAll} 个` : `${totalMatched} / ${totalAll} 个`}
          </p>
        </div>
        <Button onClick={() => setNewOpen(true)} className="shrink-0">
          <Plus className="h-4 w-4" />
          新建任务
        </Button>
      </div>

      {totalAll > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="search"
              placeholder="搜索 ID 或标题…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8"
            />
          </div>

          {workflowOptions.length > 1 && (
            <Select value={workflowFilter} onValueChange={setWorkflowFilter}>
              <SelectTrigger className="w-40 shrink-0">
                <SelectValue placeholder="工作流" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">所有工作流</SelectItem>
                {workflowOptions.map((w) => (
                  <SelectItem key={w} value={w}>
                    {w}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      )}

      {totalAll > 0 && (
        <div className="scrollbar-thin mb-4 flex w-full gap-1 overflow-x-auto">
          {STATUS_GROUPS.map((g) => {
            const active = statusFilter === g.key;
            return (
              <button
                key={g.key}
                type="button"
                onClick={() => setStatusFilter(g.key)}
                className={cn(
                  "inline-flex h-7 shrink-0 items-center rounded-full border px-3 text-xs font-medium transition-colors",
                  active
                    ? "border-primary/30 bg-primary/10 text-primary"
                    : "border-border bg-background text-muted-foreground hover:bg-accent hover:text-foreground",
                )}
              >
                {g.label}
              </button>
            );
          })}
        </div>
      )}

      {selected.size > 0 && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-primary/20 bg-primary/5 px-4 py-2.5 text-sm">
          <span>
            <strong className="font-semibold">{selected.size}</strong> 个已选 · 可取消{" "}
            <strong className="font-semibold">{cancellableSelected.length}</strong> 个
          </span>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="destructive"
              onClick={() => setConfirmOpen(true)}
              disabled={cancellableSelected.length === 0}
            >
              批量取消
            </Button>
            <Button size="sm" variant="ghost" onClick={clearSelection}>
              清除选择
            </Button>
          </div>
        </div>
      )}

      {totalAll === 0 ? (
        <EmptyState
          title="还没有任务"
          hint="从工作流启动第一个任务开始。"
          action={
            <Button onClick={() => setNewOpen(true)}>
              <Plus className="h-4 w-4" />
              创建第一个任务
            </Button>
          }
        />
      ) : filtered.length === 0 ? (
        <EmptyState
          title="没有匹配的任务"
          hint="调整搜索或筛选条件试试。"
          action={
            <Button
              variant="secondary"
              onClick={() => {
                setSearch("");
                setStatusFilter("all");
                setWorkflowFilter("all");
              }}
            >
              <X className="h-4 w-4" />
              清除过滤
            </Button>
          }
        />
      ) : (
        <>
          {/* Desktop: table */}
          <div className="hidden rounded-lg border bg-card shadow-sm md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8">
                    <input
                      type="checkbox"
                      aria-label="全选"
                      className="accent-primary"
                      checked={allFilteredSelected}
                      onChange={toggleSelectAll}
                    />
                  </TableHead>
                  <TableHead>ID</TableHead>
                  <TableHead>标题</TableHead>
                  <TableHead>工作流</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead className="text-right">更新时间</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((t) => (
                  <TableRow key={t.id} className="cursor-pointer">
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        aria-label={`选中 ${t.id}`}
                        className="accent-primary"
                        checked={selected.has(t.id)}
                        onChange={() => toggleSelect(t.id)}
                      />
                    </TableCell>
                    <TableCell className="font-mono text-xs text-primary" onClick={() => onSelect(t.id)}>
                      {t.id}
                    </TableCell>
                    <TableCell onClick={() => onSelect(t.id)}>
                      <div className="max-w-[320px] truncate" title={t.title}>
                        {t.title}
                      </div>
                    </TableCell>
                    <TableCell
                      className="font-mono text-xs text-muted-foreground"
                      onClick={() => onSelect(t.id)}
                    >
                      {t.workflow}
                    </TableCell>
                    <TableCell onClick={() => onSelect(t.id)}>
                      <StatusBadge status={t.status} />
                    </TableCell>
                    <TableCell
                      className="whitespace-nowrap text-right text-xs text-muted-foreground"
                      onClick={() => onSelect(t.id)}
                    >
                      {new Date(t.updated_at).toLocaleString()}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {/* Mobile: cards */}
          <div className="flex flex-col gap-2 md:hidden">
            {filtered.map((t) => (
              <div
                key={t.id}
                className={cn(
                  "rounded-lg border bg-card px-3.5 py-3 shadow-sm transition-colors",
                  selected.has(t.id) && "border-primary/40 ring-1 ring-primary/20",
                )}
              >
                <div className="mb-2 flex items-center justify-between gap-2">
                  <label
                    className="flex items-center gap-2"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <input
                      type="checkbox"
                      className="accent-primary"
                      checked={selected.has(t.id)}
                      onChange={() => toggleSelect(t.id)}
                    />
                    <span className="font-mono text-xs text-primary">{t.id}</span>
                  </label>
                  <StatusBadge status={t.status} compact />
                </div>
                <div onClick={() => onSelect(t.id)} className="min-w-0">
                  <div className="mb-1 line-clamp-2 break-words text-sm">{t.title}</div>
                  <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                    <span className="truncate font-mono">{t.workflow}</span>
                    <span className="shrink-0">{new Date(t.updated_at).toLocaleString()}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      <NewTaskDialog
        open={newOpen}
        onClose={() => setNewOpen(false)}
        onCreated={(id) => {
          refresh();
          onSelect(id);
        }}
      />

      <ConfirmDialog
        open={confirmOpen}
        title="批量取消任务"
        message={
          <div className="space-y-2">
            <p>确认取消以下 {cancellableSelected.length} 个任务？正在运行的阶段将被中止。</p>
            <ul className="max-h-56 space-y-0.5 overflow-auto rounded-md border bg-muted/40 p-2 font-mono text-xs">
              {cancellableSelected.map((t) => (
                <li key={t.id}>
                  {t.id} — {t.title}
                </li>
              ))}
            </ul>
            {selected.size > cancellableSelected.length && (
              <p className="text-xs text-muted-foreground">
                另有 {selected.size - cancellableSelected.length} 个已终态任务会被跳过。
              </p>
            )}
          </div>
        }
        confirmText={cancelling ? "处理中…" : "确认取消"}
        cancelText="不要"
        danger
        onConfirm={doBulkCancel}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  );
}

function EmptyState({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed bg-card/50 px-6 py-12 text-center">
      <div className="text-sm font-medium">{title}</div>
      {hint && <p className="max-w-sm text-xs text-muted-foreground">{hint}</p>}
      {action}
    </div>
  );
}
