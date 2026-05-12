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
import { modShortcut } from "./lib/platform";
import {
  MessageSquare,
  ListTodo,
  Workflow as WorkflowIcon,
  Plug,
  Bot,
  Sliders,
  Sparkles,
  Moon,
  Sun,
  Search,
  Menu,
  Circle,
  Clock,
  Layers,
} from "lucide-react";

const Now = lazy(() => import("./pages/Now").then((m) => ({ default: m.Now })));
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
const Projects = lazy(() => import("./pages/Projects").then((m) => ({ default: m.Projects })));
const ProjectDetail = lazy(() =>
  import("./pages/ProjectDetail").then((m) => ({ default: m.ProjectDetail })),
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
  { path: "/now", label: "现在", icon: Sparkles, end: true },
  { path: "/chat", label: "对话", icon: MessageSquare, end: true },
  { path: "/tasks", label: "任务", icon: ListTodo },
  { path: "/schedules", label: "定时", icon: Clock, end: true },
  { path: "/workflows", label: "工作流", icon: WorkflowIcon, end: true },
  { path: "/projects", label: "项目", icon: Layers },
];

const SETTINGS_NAV: NavItem[] = [
  { path: "/providers", label: "提供商", icon: Plug, end: true },
  { path: "/agents", label: "智能体", icon: Bot, end: true },
  { path: "/settings", label: "通用", icon: Sliders, end: true },
];

function titleForPath(pathname: string): string {
  if (pathname.startsWith("/now")) return "现在";
  if (pathname.startsWith("/tasks/")) {
    const id = pathname.slice("/tasks/".length);
    return id ? `任务 · ${id}` : "任务";
  }
  if (pathname.startsWith("/chat")) return "对话";
  if (pathname.startsWith("/tasks")) return "任务";
  if (pathname.startsWith("/schedules")) return "定时任务";
  if (pathname.startsWith("/workflows")) return "工作流";
  if (pathname.startsWith("/projects/")) {
    const id = pathname.slice("/projects/".length);
    return id ? `项目工作台 · ${id}` : "项目";
  }
  if (pathname.startsWith("/projects")) return "项目";
  if (pathname.startsWith("/providers")) return "提供商";
  if (pathname.startsWith("/agents")) return "智能体";
  if (pathname.startsWith("/settings")) return "通用设置";
  if (pathname.startsWith("/requirements/")) return "需求详情";
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
        <aside className="hidden w-60 shrink-0 flex-col border-r-[1.5px] border-foreground/30 bg-sidebar text-sidebar-foreground lg:flex">
          <SidebarContent wsState={wsState} />
        </aside>

        <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
          <SheetContent side="left" className="w-64 bg-sidebar p-0 text-sidebar-foreground">
            <SidebarContent wsState={wsState} />
          </SheetContent>
        </Sheet>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-12 shrink-0 items-center gap-2 border-b-[1.5px] border-foreground/30 bg-background px-3 md:px-5">
            <Button
              variant="ghost"
              size="icon"
              className="lg:hidden"
              onClick={() => setMobileNavOpen(true)}
              aria-label="打开菜单"
            >
              <Menu className="h-5 w-5" />
            </Button>
            <h1 className="truncate font-display text-base font-bold uppercase tracking-wider">
              {headerTitle}
            </h1>
            <div className="ml-auto flex items-center gap-1">
              <Button
                variant="outline"
                size="sm"
                className="h-8 gap-2 pr-2 text-muted-foreground"
                onClick={() => setCmdOpen(true)}
              >
                <Search className="h-3.5 w-3.5" />
                <span className="hidden sm:inline tracking-wider">搜索 / 命令</span>
                <kbd className="ml-2 hidden items-center rounded-none border border-foreground/40 bg-muted px-1.5 py-px font-mono text-[10px] text-muted-foreground sm:inline-flex">
                  {modShortcut("K")}
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
                <Route path="/now" element={<Now />} />
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
                <Route path="/projects" element={<Projects />} />
                <Route path="/projects/:id" element={<ProjectDetailRoute />} />
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

      <Toaster position="top-center" closeButton />
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

function ProjectDetailRoute() {
  const { id } = useParams<{ id: string }>();
  if (!id) return <Navigate to="/projects" replace />;
  return <ProjectDetail projectId={id} />;
}

function SidebarContent({
  wsState,
}: {
  wsState: "connected" | "connecting" | "disconnected";
}) {
  const wsColor =
    wsState === "connected"
      ? "text-success"
      : wsState === "connecting"
      ? "text-warning"
      : "text-destructive";
  const wsLabel =
    wsState === "connected" ? "已连接" : wsState === "connecting" ? "连接中…" : "未连接";

  return (
    <div className="flex h-full flex-col">
      {/* 蓝图风 logo block：方块编号 + display 字体品牌名 */}
      <div className="flex h-12 shrink-0 items-center gap-2.5 border-b-[1.5px] border-foreground/30 px-4">
        <div className="bp-num-block h-7 w-7 text-sm">A</div>
        <div className="flex flex-col leading-none">
          <span className="font-display text-base font-bold uppercase tracking-wider">
            Autopilot
          </span>
          <span className="font-mono text-[9px] uppercase tracking-[0.25em] text-muted-foreground mt-0.5">
            CTRL · v1.0
          </span>
        </div>
      </div>

      <nav className="flex-1 space-y-5 overflow-y-auto scrollbar-thin p-3">
        <NavGroup items={MAIN_NAV} />
        <div className="space-y-1.5">
          <div className="bp-label px-2.5 flex items-center gap-2">
            <span>设置 · CONFIG</span>
            <span className="h-px flex-1 border-t border-dashed border-foreground/30" />
          </div>
          <NavGroup items={SETTINGS_NAV} />
        </div>
      </nav>

      <div className="border-t border-dashed border-foreground/30" />

      <div className="flex h-10 shrink-0 items-center gap-2 px-4 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
        <Circle className={cn("h-2 w-2 fill-current", wsColor)} />
        <span>{wsLabel}</span>
      </div>
    </div>
  );
}

function NavGroup({ items }: { items: NavItem[] }) {
  return (
    <ul className="space-y-0">
      {items.map((item) => (
        <li key={item.path}>
          <NavLink
            to={item.path}
            end={item.end}
            className={({ isActive }) =>
              cn(
                "group relative flex w-full items-center gap-2.5 rounded-none border-l-2 px-2.5 py-2 font-mono text-xs uppercase tracking-[0.12em] font-medium transition-all",
                isActive
                  ? "border-accent bg-sidebar-accent text-foreground"
                  : "border-transparent text-muted-foreground hover:border-foreground/40 hover:bg-sidebar-accent/50 hover:text-foreground",
              )
            }
          >
            {({ isActive }) => (
              <>
                <item.icon
                  className={cn("h-4 w-4 shrink-0", isActive ? "text-accent" : "text-foreground/60")}
                />
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
