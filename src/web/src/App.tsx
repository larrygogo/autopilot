import React, { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { useWebSocket } from "./hooks/useWebSocket";
import { ToastProvider } from "./components/Toast";
import { Toaster } from "./components/ui/sonner";
import { TooltipProvider, Tooltip, TooltipContent, TooltipTrigger } from "./components/ui/tooltip";
import { Sheet, SheetContent } from "./components/ui/sheet";
import { Button } from "./components/ui/button";
import { Separator } from "./components/ui/separator";
import { CommandPalette, type NavKey } from "./components/CommandPalette";
import { NewTaskDialog } from "./components/NewTaskDialog";
import { PageLoader } from "./components/PageLoader";
import { useTheme } from "./lib/theme";
import { cn } from "./lib/utils";
import {
  MessageSquare,
  ListTodo,
  Workflow as WorkflowIcon,
  Plug,
  Bot,
  Sliders,
  Moon,
  Sun,
  Search,
  Menu,
  Circle,
} from "lucide-react";

const Tasks = lazy(() => import("./pages/Tasks").then((m) => ({ default: m.Tasks })));
const TaskDetail = lazy(() =>
  import("./pages/TaskDetail").then((m) => ({ default: m.TaskDetail })),
);
const Workflows = lazy(() => import("./pages/Workflows").then((m) => ({ default: m.Workflows })));
const Chat = lazy(() => import("./pages/Chat").then((m) => ({ default: m.Chat })));
const Providers = lazy(() => import("./pages/Providers").then((m) => ({ default: m.Providers })));
const Agents = lazy(() => import("./pages/Agents").then((m) => ({ default: m.Agents })));
const Settings = lazy(() => import("./pages/Settings").then((m) => ({ default: m.Settings })));

type Page =
  | NavKey
  | { type: "task-detail"; id: string };

interface NavItem {
  key: NavKey;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

const MAIN_NAV: NavItem[] = [
  { key: "chat", label: "对话", icon: MessageSquare },
  { key: "tasks", label: "任务", icon: ListTodo },
  { key: "workflows", label: "工作流", icon: WorkflowIcon },
];

const SETTINGS_NAV: NavItem[] = [
  { key: "providers", label: "提供商", icon: Plug },
  { key: "agents", label: "智能体", icon: Bot },
  { key: "settings", label: "通用", icon: Sliders },
];

const PAGE_TITLES: Record<NavKey, string> = {
  chat: "对话",
  tasks: "任务",
  workflows: "工作流",
  providers: "提供商",
  agents: "智能体",
  settings: "通用设置",
};

function AppInner() {
  const [page, setPage] = useState<Page>("tasks");
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [cmdOpen, setCmdOpen] = useState(false);
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const { state: wsState, subscribe } = useWebSocket();
  const { resolved: themeResolved, toggle: toggleTheme } = useTheme();

  const currentKey: NavKey | "task-detail" = typeof page === "string" ? page : page.type;

  const openPage = (p: Page) => {
    setPage(p);
    setMobileNavOpen(false);
  };

  // Cmd/Ctrl+K 打开命令面板
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCmdOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const headerTitle =
    currentKey === "task-detail" && typeof page !== "string"
      ? `任务 · ${page.id}`
      : PAGE_TITLES[currentKey as NavKey];

  return (
    <TooltipProvider delayDuration={150}>
      <div className="flex h-dvh w-full overflow-hidden bg-background text-foreground">
        {/* Desktop sidebar */}
        <aside className="hidden w-60 shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground lg:flex">
          <SidebarContent
            currentKey={currentKey}
            wsState={wsState}
            onNavigate={(k) => openPage(k)}
          />
        </aside>

        {/* Mobile drawer */}
        <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
          <SheetContent side="left" className="w-64 bg-sidebar p-0 text-sidebar-foreground">
            <SidebarContent
              currentKey={currentKey}
              wsState={wsState}
              onNavigate={(k) => openPage(k)}
            />
          </SheetContent>
        </Sheet>

        {/* Main column */}
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-12 shrink-0 items-center gap-2 border-b bg-background px-3 md:px-5">
            <Button
              variant="ghost"
              size="icon"
              className="lg:hidden"
              onClick={() => setMobileNavOpen(true)}
              aria-label="打开菜单"
            >
              <Menu className="h-5 w-5" />
            </Button>
            <h1 className="truncate text-sm font-semibold tracking-tight">{headerTitle}</h1>
            <div className="ml-auto flex items-center gap-1">
              <Button
                variant="outline"
                size="sm"
                className="h-8 gap-2 pr-2 text-muted-foreground"
                onClick={() => setCmdOpen(true)}
              >
                <Search className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">搜索 / 命令</span>
                <kbd className="ml-2 hidden items-center rounded border bg-muted px-1.5 py-px font-mono text-[10px] text-muted-foreground sm:inline-flex">
                  ⌘K
                </kbd>
              </Button>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    onClick={toggleTheme}
                    aria-label="切换主题"
                  >
                    {themeResolved === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">切换亮/暗模式</TooltipContent>
              </Tooltip>
            </div>
          </header>

          <main
            className={cn(
              "min-w-0 flex-1 scrollbar-thin",
              currentKey === "chat" ? "overflow-hidden" : "overflow-y-auto",
            )}
          >
            <Suspense fallback={<PageLoader />}>
              {currentKey === "tasks" && typeof page === "string" && (
                <Tasks
                  onSelect={(id) => openPage({ type: "task-detail", id })}
                  subscribe={subscribe}
                />
              )}
              {currentKey === "task-detail" && typeof page !== "string" && (
                <TaskDetail
                  taskId={page.id}
                  onBack={() => openPage("tasks")}
                  subscribe={subscribe}
                />
              )}
              {currentKey === "workflows" && (
                <Workflows onJumpToAgent={() => openPage("agents")} />
              )}
              {currentKey === "chat" && (
                <div className="h-full">
                  <Chat subscribe={subscribe} />
                </div>
              )}
              {currentKey === "providers" && <Providers />}
              {currentKey === "agents" && <Agents />}
              {currentKey === "settings" && <Settings />}
            </Suspense>
          </main>
        </div>
      </div>

      <CommandPalette
        open={cmdOpen}
        onOpenChange={setCmdOpen}
        onNavigate={(k) => openPage(k)}
        onSelectTask={(id) => openPage({ type: "task-detail", id })}
        onNewTask={() => setNewTaskOpen(true)}
      />

      <NewTaskDialog
        open={newTaskOpen}
        onClose={() => setNewTaskOpen(false)}
        onCreated={(id) => openPage({ type: "task-detail", id })}
      />

      <Toaster position="top-center" richColors closeButton />
    </TooltipProvider>
  );
}

function SidebarContent({
  currentKey,
  wsState,
  onNavigate,
}: {
  currentKey: NavKey | "task-detail";
  wsState: "connected" | "connecting" | "disconnected";
  onNavigate: (k: NavKey) => void;
}) {
  const activeKey: NavKey | null = currentKey === "task-detail" ? "tasks" : currentKey;
  const wsColor =
    wsState === "connected"
      ? "text-emerald-500"
      : wsState === "connecting"
      ? "text-amber-500"
      : "text-rose-500";
  const wsLabel =
    wsState === "connected" ? "已连接" : wsState === "connecting" ? "连接中…" : "未连接";

  return (
    <div className="flex h-full flex-col">
      {/* Logo */}
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-sidebar-border px-4">
        <div className="flex h-6 w-6 items-center justify-center rounded-md bg-sidebar-primary text-sidebar-primary-foreground">
          <span className="text-[11px] font-bold">A</span>
        </div>
        <span className="text-sm font-semibold tracking-tight">Autopilot</span>
      </div>

      {/* Nav */}
      <nav className="flex-1 space-y-6 overflow-y-auto scrollbar-thin p-3">
        <NavGroup items={MAIN_NAV} activeKey={activeKey} onNavigate={onNavigate} />
        <div className="space-y-1">
          <div className="px-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            设置
          </div>
          <NavGroup items={SETTINGS_NAV} activeKey={activeKey} onNavigate={onNavigate} />
        </div>
      </nav>

      <Separator className="bg-sidebar-border" />

      {/* Status footer */}
      <div className="flex h-10 shrink-0 items-center gap-2 px-4 text-xs text-muted-foreground">
        <Circle className={cn("h-2 w-2 fill-current", wsColor)} />
        <span>{wsLabel}</span>
      </div>
    </div>
  );
}

function NavGroup({
  items,
  activeKey,
  onNavigate,
}: {
  items: NavItem[];
  activeKey: NavKey | null;
  onNavigate: (k: NavKey) => void;
}) {
  return (
    <ul className="space-y-0.5">
      {items.map((item) => {
        const active = activeKey === item.key;
        return (
          <li key={item.key}>
            <button
              type="button"
              onClick={() => onNavigate(item.key)}
              className={cn(
                "group flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm font-medium transition-colors",
                active
                  ? "bg-sidebar-accent text-sidebar-accent-foreground"
                  : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
              )}
            >
              <item.icon className={cn("h-4 w-4 shrink-0", active && "text-sidebar-primary")} />
              <span>{item.label}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export function App() {
  return (
    <ToastProvider>
      <AppInner />
    </ToastProvider>
  );
}
