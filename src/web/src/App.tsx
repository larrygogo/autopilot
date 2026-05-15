import React, { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { useNowCards } from "./hooks/useNowCards";
import { countActiveCards } from "./lib/active-cards";
import { useDesktopNotify } from "./hooks/useDesktopNotify";
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
import { FloatingChat } from "./components/FloatingChat";
import { NewTaskDialog } from "./components/NewTaskDialog";
import { PageLoader } from "./components/PageLoader";
import { useTheme } from "./lib/theme";
import { cn } from "./lib/utils";
import { modShortcut } from "./lib/platform";
import {
  Sliders,
  Sparkles,
  FilePlus,
  FolderOpen,
  Moon,
  Sun,
  Search,
  Menu,
  Circle,
  GitBranch,
  CalendarClock,
  ChevronDown,
  ChevronRight,
  Folder,
} from "lucide-react";
import { api, type Project } from "./hooks/useApi";

const Now = lazy(() => import("./pages/Now").then((m) => ({ default: m.Now })));
const Start = lazy(() => import("./pages/Start").then((m) => ({ default: m.Start })));
const Library = lazy(() => import("./pages/Library").then((m) => ({ default: m.Library })));
const SettingsHub = lazy(() => import("./pages/SettingsHub").then((m) => ({ default: m.SettingsHub })));
const Setup = lazy(() => import("./pages/Setup").then((m) => ({ default: m.Setup })));
const NewWorkflowWithAI = lazy(() => import("./pages/NewWorkflowWithAI").then((m) => ({ default: m.NewWorkflowWithAI })));
const Workflows = lazy(() => import("./pages/Workflows").then((m) => ({ default: m.Workflows })));
const Schedules = lazy(() => import("./pages/Schedules").then((m) => ({ default: m.Schedules })));
const TaskDetail = lazy(() =>
  import("./pages/TaskDetail").then((m) => ({ default: m.TaskDetail })),
);
const Chat = lazy(() => import("./pages/Chat").then((m) => ({ default: m.Chat })));
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
  /** 标记可折叠节点（侧栏会渲染 chevron + 子项区域，数据由 SidebarContent 注入） */
  expandable?: "projects";
}

interface NavGroupDef {
  /** 分组标题（mono 字体小字，对应一组导航项） */
  title: string;
  items: NavItem[];
}

const NAV_GROUPS: NavGroupDef[] = [
  {
    title: "任务",
    items: [
      { path: "/now", label: "现在", icon: Sparkles, end: true },
      { path: "/start", label: "开始", icon: FilePlus, end: true },
      { path: "/library", label: "项目", icon: FolderOpen, expandable: "projects" },
    ],
  },
  {
    title: "编排",
    items: [
      { path: "/workflows", label: "工作流", icon: GitBranch },
      { path: "/schedules", label: "定时任务", icon: CalendarClock },
    ],
  },
  {
    title: "系统",
    items: [
      { path: "/settings", label: "设置", icon: Sliders },
    ],
  },
];

function titleForPath(pathname: string): string {
  if (pathname.startsWith("/now")) return "现在";
  if (pathname.startsWith("/start")) return "开始";
  if (pathname.startsWith("/library")) return "项目";
  if (pathname.startsWith("/tasks/")) {
    const id = pathname.slice("/tasks/".length);
    return id ? `任务 · ${id}` : "任务";
  }
  if (pathname.startsWith("/chat")) return "对话";
  if (pathname.startsWith("/schedules")) return "定时任务";
  if (pathname.startsWith("/workflows")) return "工作流";
  if (pathname.startsWith("/projects/")) {
    const id = pathname.slice("/projects/".length);
    return id ? `项目工作台 · ${id}` : "项目";
  }
  if (pathname.startsWith("/projects")) return "项目";
  if (pathname.startsWith("/providers")) return "提供商";
  if (pathname.startsWith("/agents")) return "智能体";
  if (pathname.startsWith("/settings")) return "设置";
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
  const { cards: nowCards } = useNowCards();
  const activeCount = useMemo(() => countActiveCards(nowCards), [nowCards]);
  useDesktopNotify(nowCards);

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

  // tab title 加未读数前缀
  useEffect(() => {
    const base = "autopilot";
    document.title = activeCount > 0 ? `(${activeCount}) ${base}` : base;
  }, [activeCount]);

  const headerTitle = titleForPath(location.pathname);
  const isChatRoute = location.pathname.startsWith("/chat");

  return (
    <TooltipProvider delayDuration={150}>
      <div className="flex h-dvh w-full overflow-hidden bg-background text-foreground">
        <aside className="hidden w-60 shrink-0 flex-col border-r-[1.5px] border-foreground/30 bg-sidebar text-sidebar-foreground lg:flex">
          <SidebarContent wsState={wsState} activeCount={activeCount} />
        </aside>

        <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
          <SheetContent side="left" className="w-64 bg-sidebar p-0 text-sidebar-foreground">
            <SidebarContent wsState={wsState} activeCount={activeCount} />
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
                <Route path="/" element={<Navigate to="/now" replace />} />
                <Route path="/now" element={<Now />} />
                <Route path="/start" element={<Start />} />
                <Route path="/library" element={<Library />} />
                <Route path="/settings" element={<SettingsHub />} />
                <Route
                  path="/tasks/:id"
                  element={<TaskDetailRoute subscribe={subscribe} />}
                />
                <Route
                  path="/chat"
                  element={
                    <div className="h-full">
                      <Chat subscribe={subscribe} />
                    </div>
                  }
                />
                <Route path="/projects/:id" element={<ProjectDetailRoute />} />
                <Route path="/requirements/:id" element={<RequirementDetail />} />
                <Route path="/projects" element={<Navigate to="/library?tab=projects" replace />} />
                <Route path="/workflows/new-with-ai" element={<NewWorkflowWithAI />} />
                <Route path="/workflows" element={<Workflows />} />
                <Route path="/schedules" element={<SchedulesRoute subscribe={subscribe} />} />
                <Route path="/agents" element={<Navigate to="/settings?tab=agents" replace />} />
                <Route path="/providers" element={<Navigate to="/settings?tab=providers" replace />} />
                <Route path="/setup" element={<Setup />} />
                <Route path="*" element={<Navigate to="/now" replace />} />
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
      <FloatingChat />
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
  if (!id) return <Navigate to="/now" replace />;
  return <TaskDetail taskId={id} onBack={() => navigate("/now")} subscribe={subscribe} />;
}

function ProjectDetailRoute() {
  const { id } = useParams<{ id: string }>();
  if (!id) return <Navigate to="/projects" replace />;
  return <ProjectDetail projectId={id} />;
}

function SchedulesRoute({
  subscribe,
}: {
  subscribe: (channel: string, handler: (event: any) => void) => () => void;
}) {
  const navigate = useNavigate();
  return <Schedules subscribe={subscribe} onSelectTask={(id) => navigate(`/tasks/${id}`)} />;
}

function SidebarContent({
  wsState,
  activeCount = 0,
}: {
  wsState: "connected" | "connecting" | "disconnected";
  activeCount?: number;
}) {
  const wsColor =
    wsState === "connected"
      ? "text-success"
      : wsState === "connecting"
      ? "text-warning"
      : "text-destructive";
  const wsLabel =
    wsState === "connected" ? "已连接" : wsState === "connecting" ? "连接中…" : "未连接";

  // 项目列表（注入到 expandable="projects" 节点）
  const [projects, setProjects] = useState<Project[]>([]);
  useEffect(() => {
    let cancelled = false;
    api.listProjects()
      .then((list) => { if (!cancelled) setProjects(list); })
      .catch(() => { /* 静默：失败时菜单二级为空 */ });
    return () => { cancelled = true; };
  }, []);

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

      <nav className="flex-1 space-y-4 overflow-y-auto scrollbar-thin p-3">
        {NAV_GROUPS.map((group) => (
          <div key={group.title}>
            <div className="mb-1.5 px-2.5 font-mono text-[9px] uppercase tracking-[0.22em] text-muted-foreground/70">
              {group.title}
            </div>
            <NavGroup items={group.items} badges={{ "/now": activeCount }} projects={projects} />
          </div>
        ))}
      </nav>

      <div className="border-t border-dashed border-foreground/30" />

      <div className="flex h-10 shrink-0 items-center gap-2 px-4 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
        <Circle className={cn("h-2 w-2 fill-current", wsColor)} />
        <span>{wsLabel}</span>
      </div>
    </div>
  );
}

function NavGroup({
  items,
  badges,
  projects,
}: {
  items: NavItem[];
  badges?: Record<string, number>;
  projects?: Project[];
}) {
  return (
    <ul className="space-y-0">
      {items.map((item) => {
        const badgeCount = badges?.[item.path] ?? 0;
        if (item.expandable === "projects" && projects) {
          return (
            <li key={item.path}>
              <ExpandableNavItem item={item} children={projects} />
            </li>
          );
        }
        return (
          <li key={item.path}>
            <NavLinkItem item={item} badgeCount={badgeCount} />
          </li>
        );
      })}
    </ul>
  );
}

function NavLinkItem({ item, badgeCount }: { item: NavItem; badgeCount: number }) {
  return (
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
          <span className="flex-1">{item.label}</span>
          {badgeCount > 0 && (
            <span
              className="inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-red-600 px-1 font-mono text-[10px] font-bold leading-none text-white"
              aria-label={`${badgeCount} 件待处理`}
            >
              {badgeCount > 99 ? "99+" : badgeCount}
            </span>
          )}
        </>
      )}
    </NavLink>
  );
}

/**
 * 可展开的导航节点（当前仅"项目"用）。
 * - 整行点击 → 跳转父路径（顶层"项目"列表页 /library）
 * - 右侧 chevron 单独控制展开 / 收起，不影响父级 navigation
 * - 展开后列出每个项目，点击 → /projects/:id
 * - 默认展开（首次进入想看到项目列表）；本地 storage 记忆用户上次状态
 */
function ExpandableNavItem({ item, children }: { item: NavItem; children: Project[] }) {
  const location = useLocation();
  const storageKey = `sidebar.expand.${item.path}`;
  const [expanded, setExpanded] = useState<boolean>(() => {
    try {
      const v = localStorage.getItem(storageKey);
      return v === null ? true : v === "1";
    } catch {
      return true;
    }
  });
  useEffect(() => {
    try { localStorage.setItem(storageKey, expanded ? "1" : "0"); } catch { /* ignore */ }
  }, [expanded, storageKey]);

  const parentActive = location.pathname === item.path || location.pathname.startsWith(item.path + "/");
  return (
    <div>
      <div
        className={cn(
          "relative flex w-full items-center gap-2.5 rounded-none border-l-2 pr-1 font-mono text-xs uppercase tracking-[0.12em] font-medium transition-all",
          parentActive
            ? "border-accent bg-sidebar-accent text-foreground"
            : "border-transparent text-muted-foreground hover:border-foreground/40 hover:bg-sidebar-accent/50 hover:text-foreground",
        )}
      >
        <NavLink
          to={item.path}
          end={item.end}
          className="flex flex-1 items-center gap-2.5 px-2.5 py-2"
        >
          <item.icon className={cn("h-4 w-4 shrink-0", parentActive ? "text-accent" : "text-foreground/60")} />
          <span className="flex-1">{item.label}</span>
        </NavLink>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-label={expanded ? "收起" : "展开"}
          className="flex h-7 w-7 items-center justify-center text-muted-foreground hover:text-foreground"
        >
          {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        </button>
      </div>
      {expanded && (
        <ul className="mt-0.5 space-y-0.5 pl-4">
          {children.length === 0 ? (
            <li className="px-2 py-1 font-mono text-[10px] text-muted-foreground">
              （空）
            </li>
          ) : (
            children.map((p) => (
              <li key={p.id}>
                <NavLink
                  to={`/projects/${p.id}`}
                  className={({ isActive }) =>
                    cn(
                      "flex items-center gap-2 rounded-none border-l-2 px-2 py-1.5 font-mono text-[11px] transition-colors",
                      isActive
                        ? "border-accent bg-sidebar-accent text-foreground"
                        : "border-transparent text-muted-foreground hover:border-foreground/40 hover:bg-sidebar-accent/50 hover:text-foreground",
                    )
                  }
                  title={p.description ?? p.name}
                >
                  <Folder className="h-3 w-3 shrink-0" />
                  <span className="truncate normal-case tracking-normal">{p.name}</span>
                </NavLink>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}

export function App() {
  return (
    <ToastProvider>
      <AppInner />
    </ToastProvider>
  );
}
