import React, { useEffect, useMemo, useState } from "react";
import { Workflow, Plug, Sliders, Moon, Sun, Plus, FileText, Folder, MessageCircle, XCircle, RotateCw } from "lucide-react";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command";
import { useTheme } from "@/lib/theme";
import { api } from "@/hooks/useApi";
import { useToast } from "@/components/Toast";

interface Task {
  id: string;
  title: string;
  workflow: string;
  status: string;
}

interface Workflow {
  name: string;
}

interface Requirement {
  id: string;
  title: string;
  status: string;
}

interface Project {
  id: string;
  name: string;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 传入目标路径（如 "/library"、"/settings"） */
  onNavigate: (path: string) => void;
  onSelectTask: (id: string) => void;
  onNewTask: () => void;
  /** 当前页面 pathname — 用来给出上下文敏感动作（如 TaskDetail 时显示"取消此任务"） */
  pathname?: string;
}

interface ContentProps {
  /** 内容是否处于激活态（控制数据拉取时机：dialog 打开 / 移动端抽屉切到搜索 tab） */
  active: boolean;
  /** 选中任意项后关闭宿主（dialog 或抽屉） */
  onClose: () => void;
  onNavigate: (path: string) => void;
  onSelectTask: (id: string) => void;
  onNewTask: () => void;
  pathname?: string;
  /** 覆盖 CommandList 高度（移动端抽屉内撑满） */
  listClassName?: string;
}

/** 从 pathname 提取上下文实体 id（/tasks/:id / /requirements/:id / /projects/:id） */
function parseContext(pathname?: string): { kind: "task" | "requirement" | "project"; id: string } | null {
  if (!pathname) return null;
  const taskM = pathname.match(/^\/tasks\/([^/]+)/);
  if (taskM) return { kind: "task", id: taskM[1]! };
  const reqM = pathname.match(/^\/requirements\/([^/]+)/);
  if (reqM) return { kind: "requirement", id: reqM[1]! };
  const projM = pathname.match(/^\/projects\/([^/]+)/);
  if (projM) return { kind: "project", id: projM[1]! };
  return null;
}

export function CommandPalette({ open, onOpenChange, onNavigate, onSelectTask, onNewTask, pathname }: Props) {
  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandPaletteContent
        active={open}
        onClose={() => onOpenChange(false)}
        onNavigate={onNavigate}
        onSelectTask={onSelectTask}
        onNewTask={onNewTask}
        pathname={pathname}
      />
    </CommandDialog>
  );
}

/** 搜索 / 命令内容体 —— 桌面端套 CommandDialog，移动端内嵌底部抽屉的「搜索」tab */
export function CommandPaletteContent({
  active,
  onClose,
  onNavigate,
  onSelectTask,
  onNewTask,
  pathname,
  listClassName,
}: ContentProps) {
  const { resolved, toggle } = useTheme();
  const toast = useToast();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [requirements, setRequirements] = useState<Requirement[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);

  useEffect(() => {
    if (!active) return;
    api.listTasks({ limit: "30" }).then((list) => setTasks(list as Task[])).catch(() => {});
    api.listWorkflows().then((list: any) => setWorkflows((list ?? []) as Workflow[])).catch(() => {});
    api.listRequirements().then((list: any) => setRequirements((list ?? []) as Requirement[])).catch(() => {});
    api.listProjects().then((list) => setProjects(list as Project[])).catch(() => {});
  }, [active]);

  const run = (fn: () => void | Promise<void>) => () => {
    onClose();
    void fn();
  };

  // 上下文敏感动作 — TaskDetail 页时给"取消 / 重启"快捷动作
  const context = useMemo(() => parseContext(pathname), [pathname]);
  /** 当前上下文里的 task（若是 task 页） — 用 status 决定哪些动作可用 */
  const contextTask = useMemo(() => {
    if (context?.kind !== "task") return null;
    return tasks.find((t) => t.id === context.id) ?? null;
  }, [context, tasks]);

  async function handleCancelContextTask() {
    if (context?.kind !== "task") return;
    try {
      await api.cancelTask(context.id);
      toast.success(`已取消任务 ${context.id}`);
    } catch (e: unknown) {
      toast.error("取消失败", (e as Error)?.message ?? String(e));
    }
  }

  async function handleRestartContextTask() {
    if (context?.kind !== "task") return;
    try {
      await api.restartTask(context.id);
      toast.success(`已重启任务 ${context.id}`);
    } catch (e: unknown) {
      toast.error("重启失败", (e as Error)?.message ?? String(e));
    }
  }

  const pages = useMemo(
    () => [
      { path: "/workflows", label: "工作流", icon: Workflow },
      { path: "/settings/providers", label: "提供商", icon: Plug },
      { path: "/settings", label: "通用设置", icon: Sliders },
    ],
    [],
  );

  return (
    <>
      <CommandInput placeholder="跳转、搜索任务 / 需求 / 项目、执行命令…" />
      <CommandList className={listClassName}>
        <CommandEmpty>没有匹配结果</CommandEmpty>

        {/* 上下文敏感动作 — 仅 TaskDetail 页时显示，让键盘流用户不必鼠标点 task 卡 */}
        {context?.kind === "task" && (
          <>
            <CommandGroup heading={`此任务 · ${context.id}`}>
              <CommandItem
                value={`cancel-task ${context.id}`}
                onSelect={run(handleCancelContextTask)}
                disabled={contextTask?.status === "done" || contextTask?.status === "cancelled"}
              >
                <XCircle className="h-4 w-4" />
                取消此任务
              </CommandItem>
              <CommandItem
                value={`restart-task ${context.id}`}
                onSelect={run(handleRestartContextTask)}
              >
                <RotateCw className="h-4 w-4" />
                重启此任务（从当前阶段）
              </CommandItem>
            </CommandGroup>
            <CommandSeparator />
          </>
        )}

        <CommandGroup heading="操作">
          <CommandItem onSelect={run(onNewTask)}>
            <Plus className="h-4 w-4" />
            新建任务
            <CommandShortcut>N</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={run(toggle)}>
            {resolved === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            切换{resolved === "dark" ? "亮色" : "暗色"}模式
          </CommandItem>
        </CommandGroup>

        <CommandSeparator />

        <CommandGroup heading="页面">
          {pages.map((p) => (
            <CommandItem key={p.path} onSelect={run(() => onNavigate(p.path))}>
              <p.icon className="h-4 w-4" />
              {p.label}
            </CommandItem>
          ))}
        </CommandGroup>

        {tasks.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="最近任务">
              {tasks.slice(0, 10).map((t) => (
                <CommandItem
                  key={t.id}
                  value={`${t.id} ${t.title}`}
                  onSelect={run(() => onSelectTask(t.id))}
                >
                  <FileText className="h-4 w-4" />
                  <span className="font-mono text-xs text-muted-foreground shrink-0 whitespace-nowrap">{t.id}</span>
                  <span className="truncate min-w-0 flex-1">{t.title}</span>
                  <CommandShortcut>{t.status}</CommandShortcut>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

        {requirements.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="最近需求">
              {requirements.slice(0, 10).map((r) => (
                <CommandItem
                  key={r.id}
                  value={`${r.id} ${r.title}`}
                  onSelect={run(() => onNavigate(`/requirements/${r.id}`))}
                >
                  <MessageCircle className="h-4 w-4" />
                  <span className="font-mono text-xs text-muted-foreground shrink-0 whitespace-nowrap">{r.id}</span>
                  <span className="truncate min-w-0 flex-1">{r.title}</span>
                  <CommandShortcut>{r.status}</CommandShortcut>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

        {projects.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="项目">
              {projects.slice(0, 10).map((p) => (
                <CommandItem
                  key={p.id}
                  value={`${p.id} ${p.name}`}
                  onSelect={run(() => onNavigate(`/projects/${p.id}`))}
                >
                  <Folder className="h-4 w-4" />
                  <span className="font-mono text-xs text-muted-foreground shrink-0 whitespace-nowrap">{p.id}</span>
                  <span className="truncate min-w-0 flex-1">{p.name}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

        {workflows.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="工作流">
              {workflows.map((w) => (
                <CommandItem key={w.name} onSelect={run(() => onNavigate("/workflows"))}>
                  <Workflow className="h-4 w-4" />
                  {w.name}
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}
      </CommandList>
    </>
  );
}
