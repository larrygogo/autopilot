import React, { useEffect, useMemo, useState } from "react";
import { MessageSquare, ListTodo, Workflow, Plug, Bot, Sliders, Moon, Sun, Plus, FileText, Clock } from "lucide-react";
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

interface Task {
  id: string;
  title: string;
  workflow: string;
  status: string;
}

interface Workflow {
  name: string;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 传入目标路径（如 "/tasks"、"/settings"） */
  onNavigate: (path: string) => void;
  onSelectTask: (id: string) => void;
  onNewTask: () => void;
}

export function CommandPalette({ open, onOpenChange, onNavigate, onSelectTask, onNewTask }: Props) {
  const { resolved, toggle } = useTheme();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);

  useEffect(() => {
    if (!open) return;
    api.listTasks({ limit: "30" }).then((list) => setTasks(list as Task[])).catch(() => {});
    api.listWorkflows().then((list: any) => setWorkflows((list ?? []) as Workflow[])).catch(() => {});
  }, [open]);

  const run = (fn: () => void) => () => {
    onOpenChange(false);
    fn();
  };

  const pages = useMemo(
    () => [
      { path: "/chat", label: "对话", icon: MessageSquare },
      { path: "/tasks", label: "任务", icon: ListTodo },
      { path: "/schedules", label: "定时任务", icon: Clock },
      { path: "/workflows", label: "工作流", icon: Workflow },
      { path: "/providers", label: "提供商", icon: Plug },
      { path: "/agents", label: "智能体", icon: Bot },
      { path: "/settings", label: "通用设置", icon: Sliders },
    ],
    [],
  );

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput placeholder="跳转、搜索任务、执行命令…" />
      <CommandList>
        <CommandEmpty>没有匹配结果</CommandEmpty>

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
                  <span className="font-mono text-xs text-muted-foreground">{t.id}</span>
                  <span className="truncate">{t.title}</span>
                  <CommandShortcut>{t.status}</CommandShortcut>
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
    </CommandDialog>
  );
}
