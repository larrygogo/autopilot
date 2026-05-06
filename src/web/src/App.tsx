import React, { lazy, Suspense, useEffect, useState } from "react";
import {
  Routes,
  Route,
  Navigate,
  NavLink,
  useLocation,
  useNavigate,
  useParams,
} from "react-router-dom";
import { useWebSocket } from "./hooks/useWebSocket";
import { ToastProvider } from "./components/Toast";
import { Toaster } from "./components/ui/sonner";
import { TooltipProvider, Tooltip, TooltipContent, TooltipTrigger } from "./components/ui/tooltip";
import { Sheet, SheetContent } from "./components/ui/sheet";
import { Button } from "./components/ui/button";
import { Separator } from "./components/ui/separator";
import { CommandPalette } from "./components/CommandPalette";
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
  Clock,
  FolderGit2,
  Inbox,
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
const Schedules = lazy(() => import("./pages/Schedules").then((m) => ({ default: m.Schedules })));
const Repos = lazy(() => import("./pages/Repos").then((m) => ({ default: m.Repos })));
const Requirements = lazy(() =>
  import("./pages/Requirements").then((m) => ({ default: m.Requirements })),
);
const RequirementDetail = lazy(() =>
  import("./pages/RequirementDetail").then((m) => ({ default: m.RequirementDetail })),
);

interface NavItem {
  path: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  /** 只在严格匹配时激活；不设则前缀匹配（子路由也激活父项） */
  end?: boolean;
}

const MAIN_NAV: NavItem[] = [
  { path: "/chat", label: "对话", icon: MessageSquare, end: true },
  { path: "/tasks", label: "任务", icon: ListTodo },
  { path: "/schedules", label: "定时", icon: Clock, end: true },
  { path: "/workflows", label: "工作流", icon: WorkflowIcon, end: true },
  { path: "/repos", label: "仓库", icon: FolderGit2, end: true },
  { path: "/requirements", label: "需求", icon: Inbox, end: true },
];

const SETTINGS_NAV: NavItem[] = [
  { path: "/providers", label: "提供商", icon: Plug, end: true },
  { path: "/agents", label: "智能体", icon: Bot, end: true },
  { path: "/settings", label: "通用", icon: Sliders, end: true },
];

function titleForPath(pathname: string): string {
  if (pathname.startsWith("/tasks/")) {
    const id = pathname.slice("/tasks/".length);
    return id ? `任务 · ${id}` : "任务";
  }
  if (pathname.startsWith("/chat")) return "对话";
  if (pathname.startsWith("/tasks")) return "任务";
  if (pathname.startsWith("/schedules")) return "定时任务";
  if (pathname.startsWith("/workflows")) return "工作流";
  if (pathname.startsWith("/providers")) return "提供商";
  if (pathname.startsWith("/agents")) return "智能体";
  if (pathname.startsWith("/settings")) return "通用设置";
  if (pathname.startsWith("/repos")) return "仓库管理";
  if (pathname.startsWith("/requirements/")) return "需求详情";
  if (pathname.startsWith("/requirements")) return "需求池";
  return "Autopilot";
}

function AppInner() {
  const location = useLocation();
  const navigate = useNavigate();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [cmdOpen, setCmdOpen] = useState(false);
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const { state: wsState, subscribe } = useWebSocket();
  const { resolved: themeResolved, toggle: toggleTheme } = useTheme();

  // 路由切换时关闭手机抽屉
  useEffect(() => {
    setMobileNavOpen(false);
  }, [location.pathname]);

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

  const headerTitle = titleForPath(location.pathname);
  const isChatRoute = location.pathname.startsWith("/chat");

  return (
    <TooltipProvider delayDuration={150}>
      <div className="flex h-dvh w-full overflow-hidden bg-background text-foreground">
        <aside className="hidden w-60 shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground lg:flex">
          <SidebarContent wsState={wsState} />
        </aside>

        <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
          <SheetContent side="left" className="w-64 bg-sidebar p-0 text-sidebar-foreground">
            <SidebarContent wsState={wsState} />
          </SheetContent>
        </Sheet>

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
              isChatRoute ? "overflow-hidden" : "overflow-y-auto",
            )}
          >
            <Suspense fallback={<PageLoader />}>
              <Routes>
                <Route path="/" element={<Navigate to="/tasks" replace />} />
                <Route
                  path="/tasks"
                  element={
                    <Tasks
                      onSelect={(id) => navigate(`/tasks/${id}`)}
                      subscribe={subscribe}
                    />
                  }
                />
                <Route
                  path="/tasks/:id"
                  element={<TaskDetailRoute subscribe={subscribe} />}
                />
                <Route
                  path="/schedules"
                  element={
                    <Schedules
                      onSelectTask={(id) => navigate(`/tasks/${id}`)}
                      subscribe={subscribe}
                    />
                  }
                />
                <Route
                  path="/workflows"
                  element={<Workflows onJumpToAgent={() => navigate("/agents")} />}
                />
                <Route
                  path="/chat"
                  element={
                    <div className="h-full">
                      <Chat subscribe={subscribe} />
                    </div>
                  }
                />
                <Route path="/providers" element={<Providers />} />
                <Route path="/agents" element={<Agents />} />
                <Route path="/settings" element={<Settings />} />
                <Route path="/repos" element={<Repos />} />
                <Route path="/requirements" element={<Requirements />} />
                <Route path="/requirements/:id" element={<RequirementDetail />} />
                <Route path="*" element={<Navigate to="/tasks" replace />} />
              </Routes>
            </Suspense>
          </main>
        </div>
      </div>

      <CommandPalette
        open={cmdOpen}
        onOpenChange={setCmdOpen}
        onNavigate={(path) => navigate(path)}
        onSelectTask={(id) => navigate(`/tasks/${id}`)}
        onNewTask={() => setNewTaskOpen(true)}
      />

      <NewTaskDialog
        open={newTaskOpen}
        onClose={() => setNewTaskOpen(false)}
        onCreated={(id) => navigate(`/tasks/${id}`)}
      />

      <Toaster position="top-center" richColors closeButton />
    </TooltipProvider>
  );
}

function TaskDetailRoute({
  subscribe,
}: {
  subscribe: (channel: string, handler: (event: any) => void) => () => void;
}) {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  if (!id) return <Navigate to="/tasks" replace />;
  return <TaskDetail taskId={id} onBack={() => navigate("/tasks")} subscribe={subscribe} />;
}

function SidebarContent({
  wsState,
}: {
  wsState: "connected" | "connecting" | "disconnected";
}) {
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
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-sidebar-border px-4">
        <div className="flex h-6 w-6 items-center justify-center rounded-md bg-sidebar-primary text-sidebar-primary-foreground">
          <span className="text-[11px] font-bold">A</span>
        </div>
        <span className="text-sm font-semibold tracking-tight">Autopilot</span>
      </div>

      <nav className="flex-1 space-y-6 overflow-y-auto scrollbar-thin p-3">
        <NavGroup items={MAIN_NAV} />
        <div className="space-y-1">
          <div className="px-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            设置
          </div>
          <NavGroup items={SETTINGS_NAV} />
        </div>
      </nav>

      <Separator className="bg-sidebar-border" />

      <div className="flex h-10 shrink-0 items-center gap-2 px-4 text-xs text-muted-foreground">
        <Circle className={cn("h-2 w-2 fill-current", wsColor)} />
        <span>{wsLabel}</span>
      </div>
    </div>
  );
}

function NavGroup({ items }: { items: NavItem[] }) {
  return (
    <ul className="space-y-0.5">
      {items.map((item) => (
        <li key={item.path}>
          <NavLink
            to={item.path}
            end={item.end}
            className={({ isActive }) =>
              cn(
                "group flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm font-medium transition-colors",
                isActive
                  ? "bg-sidebar-accent text-sidebar-accent-foreground"
                  : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
              )
            }
          >
            {({ isActive }) => (
              <>
                <item.icon className={cn("h-4 w-4 shrink-0", isActive && "text-sidebar-primary")} />
                <span>{item.label}</span>
              </>
            )}
          </NavLink>
        </li>
      ))}
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
