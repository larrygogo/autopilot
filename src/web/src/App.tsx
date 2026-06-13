import React, { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useNotifications } from "./hooks/useNotifications";
import { useDesktopNotify } from "./hooks/useDesktopNotify";
import {
  Routes,
  Route,
  Navigate,
  NavLink,
  Link,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { useWebSocket } from "./hooks/useWebSocket";
import { ToastProvider } from "./components/Toast";
import { Toaster } from "./components/ui/sonner";
import { TooltipProvider, Tooltip, TooltipContent, TooltipTrigger } from "./components/ui/tooltip";
import { Button } from "./components/ui/button";
import { Separator } from "./components/ui/separator";
import { CommandPalette, CommandPaletteContent } from "./components/CommandPalette";
import { Command } from "./components/ui/command";
import { NotificationsPanel } from "./components/NotificationsPanel";
import { ProjectSwitcher } from "./components/ProjectSwitcher";
import { QuickCreateMenu } from "./components/QuickCreateMenu";
import { RunningTasksIndicator } from "./components/RunningTasksIndicator";
import { DaemonOfflineBanner } from "./components/DaemonOfflineBanner";
import { PageLoader } from "./components/PageLoader";
import { useTheme } from "./lib/theme";
import { cn } from "./lib/utils";
import { modShortcut } from "./lib/platform";
import {
  Sliders,
  FilePlus,
  FolderOpen,
  FolderGit2,
  FileText,
  ArrowLeft,
  Plug,
  Gauge,
  Globe,
  Server,
  Moon,
  Sun,
  Search,
  Menu,
  Circle,
  GitBranch,
  Inbox,
  ListChecks,
  X,
} from "lucide-react";
import { api } from "./hooks/useApi";

const Start = lazy(() => import("./pages/Start").then((m) => ({ default: m.Start })));
const Library = lazy(() => import("./pages/Library").then((m) => ({ default: m.Library })));
const SettingsHub = lazy(() => import("./pages/SettingsHub").then((m) => ({ default: m.SettingsHub })));
const Setup = lazy(() => import("./pages/Setup").then((m) => ({ default: m.Setup })));
const NewWorkflowWithAI = lazy(() => import("./pages/NewWorkflowWithAI").then((m) => ({ default: m.NewWorkflowWithAI })));
const Workflows = lazy(() => import("./pages/Workflows").then((m) => ({ default: m.Workflows })));
const WorkflowDetail = lazy(() => import("./pages/WorkflowDetail").then((m) => ({ default: m.WorkflowDetail })));
const Tasks = lazy(() => import("./pages/Tasks").then((m) => ({ default: m.Tasks })));
const TaskDetail = lazy(() =>
  import("./pages/TaskDetail").then((m) => ({ default: m.TaskDetail })),
);
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

interface NavGroupDef {
  /** 分组标题（mono 字体小字，对应一组导航项） */
  title: string;
  items: NavItem[];
}

/** 项目上下文侧栏导航（Supabase 式：进入项目后左侧菜单换成项目级） */
function projectNavGroups(id: string): NavGroupDef[] {
  return [
    {
      title: "项目",
      items: [
        { path: `/projects/${id}/requirements`, label: "需求", icon: FileText },
        { path: `/projects/${id}/workspaces`, label: "代码库", icon: FolderGit2 },
        { path: `/projects/${id}/settings`, label: "设置", icon: Sliders },
      ],
    },
  ];
}

/** 设置上下文侧栏导航（同 Supabase Settings：进入设置后左侧菜单换成设置分区） */
const SETTINGS_NAV_GROUPS: NavGroupDef[] = [
  {
    title: "设置",
    items: [
      { path: "/settings", label: "通用", icon: Sliders, end: true },
      { path: "/settings/providers", label: "提供商", icon: Plug },
      { path: "/settings/scheduler", label: "任务调度", icon: Gauge },
      { path: "/settings/network", label: "网络访问", icon: Globe },
      { path: "/settings/daemon", label: "Daemon", icon: Server },
    ],
  },
];

const NAV_GROUPS: NavGroupDef[] = [
  {
    title: "任务",
    items: [
      { path: "/start", label: "开始", icon: FilePlus, end: true },
      { path: "/tasks", label: "流水线", icon: ListChecks, end: true },
      { path: "/library", label: "项目", icon: FolderOpen },
    ],
  },
  {
    title: "编排",
    items: [
      { path: "/workflows", label: "工作流", icon: GitBranch },
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
  if (pathname.startsWith("/start")) return "开始";
  if (pathname === "/tasks") return "流水线";
  if (pathname.startsWith("/tasks/")) {
    const id = pathname.slice("/tasks/".length);
    return id ? `任务 · ${id}` : "流水线";
  }
  if (pathname.startsWith("/library")) return "项目";
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
  return "";
}

type MobileDrawerTab = "nav" | "now" | "search";

// 通知面板宽度边界（px）：下限保证卡片可读，上限防止挤垮主内容区
const PANEL_MIN_W = 320;
const PANEL_MAX_W = 720;

/** 移动端浮动 dock / 抽屉 pill 共用的三入口（Supabase 式） */
const MOBILE_TABS: Array<{ key: MobileDrawerTab; icon: React.ComponentType<{ className?: string }>; label: string }> = [
  { key: "search", icon: Search, label: "搜索" },
  { key: "now", icon: Inbox, label: "通知" },
  { key: "nav", icon: Menu, label: "菜单" },
];

function AppInner() {
  const location = useLocation();
  const navigate = useNavigate();
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);
  const [mobileTab, setMobileTab] = useState<MobileDrawerTab>("nav");
  const [cmdOpen, setCmdOpen] = useState(false);
  const { state: wsState, subscribe } = useWebSocket();
  const { resolved: themeResolved, toggle: toggleTheme } = useTheme();
  const notifications = useNotifications();
  const activeCount = notifications.unread;
  useDesktopNotify(notifications.items);

  // Now 决策面板（Supabase Advisor 式右侧栏）：桌面端内联右栏记住状态，小屏走抽屉
  const [nowOpen, setNowOpen] = useState<boolean>(() => {
    try {
      const v = localStorage.getItem("now.panel.open");
      return v === null ? true : v === "1";
    } catch {
      return true;
    }
  });
  useEffect(() => {
    try { localStorage.setItem("now.panel.open", nowOpen ? "1" : "0"); } catch { /* ignore */ }
  }, [nowOpen]);

  // 通知面板宽度：左缘拖拽调节，记住偏好
  const [panelWidth, setPanelWidth] = useState<number>(() => {
    try {
      const v = parseInt(localStorage.getItem("now.panel.width") ?? "", 10);
      return Number.isFinite(v) ? Math.min(PANEL_MAX_W, Math.max(PANEL_MIN_W, v)) : 380;
    } catch {
      return 380;
    }
  });
  useEffect(() => {
    try { localStorage.setItem("now.panel.width", String(panelWidth)); } catch { /* ignore */ }
  }, [panelWidth]);
  const startPanelResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = panelWidth;
    const onMove = (ev: PointerEvent) =>
      setPanelWidth(Math.min(PANEL_MAX_W, Math.max(PANEL_MIN_W, startW + (startX - ev.clientX))));
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  // 进入任务/需求详情页 = 已查看该实体，自动消化其未读通知（daemon 广播
  // notification:read 回流刷新列表与 badge）。unread 进 deps：停留期间新到的
  // 同实体通知也即时消化（已读后 RPC 幂等返回空，不会循环）。
  useEffect(() => {
    if (notifications.unread === 0) return;
    const task = location.pathname.match(/^\/tasks\/([^/]+)/);
    const req = location.pathname.match(/^\/requirements\/([^/]+)/);
    if (task) void notifications.markReadByRelated("task", task[1]).catch(() => {});
    else if (req) void notifications.markReadByRelated("requirement", req[1]).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname, notifications.unread]);

  const isDesktop = () =>
    typeof window !== "undefined" && window.matchMedia("(min-width: 1024px)").matches;
  const toggleNowPanel = () => {
    if (isDesktop()) setNowOpen((v) => !v);
    else {
      setMobileTab("now");
      setMobileDrawerOpen((v) => !(v && mobileTab === "now"));
    }
  };
  const openNowPanel = useCallback(() => {
    if (isDesktop()) setNowOpen(true);
    else {
      setMobileTab("now");
      setMobileDrawerOpen(true);
    }
  }, []);

  // 路由切换时关闭移动端底部抽屉
  useEffect(() => {
    setMobileDrawerOpen(false);
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

  // 项目上下文：/projects/:id[/:section] → 顶栏换项目切换器、侧栏换项目级导航
  const projectCtx = useMemo(() => {
    const m = location.pathname.match(/^\/projects\/([^/]+)(?:\/([^/]+))?/);
    return m ? { id: m[1], section: m[2] } : null;
  }, [location.pathname]);

  // 侧栏导航按上下文切换（Supabase 式）：项目 / 设置 / 全局
  const sidebarNav = useMemo(() => {
    if (projectCtx) {
      return {
        groups: projectNavGroups(projectCtx.id),
        back: { to: "/library", label: "项目列表" },
      };
    }
    if (location.pathname.startsWith("/settings")) {
      return { groups: SETTINGS_NAV_GROUPS, back: { to: "/tasks", label: "返回" } };
    }
    return { groups: NAV_GROUPS, back: null };
  }, [projectCtx, location.pathname]);

  return (
    <TooltipProvider delayDuration={150}>
      <div className="flex h-dvh w-full flex-col overflow-hidden bg-background text-foreground">
        {/* Supabase 式全宽顶栏：logo + 面包屑在左，工具区在右；侧栏下沉到顶栏之下 */}
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-background px-3 md:px-4">
          <Link to="/tasks" className="flex shrink-0 items-center gap-2">
            <div className="bp-num-block h-6 w-6 text-xs">A</div>
            <span className="hidden text-sm font-bold sm:inline">Autopilot</span>
          </Link>
          {projectCtx ? (
            <>
              <span className="select-none text-muted-foreground/40" aria-hidden="true">
                /
              </span>
              <ProjectSwitcher projectId={projectCtx.id} section={projectCtx.section} />
            </>
          ) : headerTitle ? (
            <>
              <span className="select-none text-muted-foreground/40" aria-hidden="true">
                /
              </span>
              <h1 className="truncate text-sm font-medium">{headerTitle}</h1>
            </>
          ) : null}
          <div className="ml-3 hidden md:block">
            <RunningTasksIndicator />
          </div>
          <div className="ml-auto flex items-center gap-1">
            <QuickCreateMenu />
            <Button
              variant="outline"
              size="sm"
              className="hidden h-8 gap-2 pr-2 text-muted-foreground lg:inline-flex"
              onClick={() => setCmdOpen(true)}
            >
              <Search className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">搜索 / 命令</span>
              <kbd className="ml-2 hidden items-center rounded-md border border-border bg-muted px-1.5 py-px font-mono text-[10px] text-muted-foreground sm:inline-flex">
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
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="relative hidden h-8 w-8 lg:inline-flex"
                  onClick={toggleNowPanel}
                  aria-label="通知"
                >
                  <Inbox className="h-4 w-4" />
                  {activeCount > 0 && (
                    <span
                      className="absolute -right-0.5 -top-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-red-600 px-1 font-mono text-[9px] font-bold leading-none text-white tabular-nums"
                      aria-label={`${activeCount} 件待处理`}
                    >
                      {activeCount > 99 ? "99+" : activeCount}
                    </span>
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">通知</TooltipContent>
            </Tooltip>
            {/* 移动端：右侧单入口，打开底部抽屉（菜单 / 现在 / 搜索） */}
            <Button
              variant="ghost"
              size="icon"
              className="relative h-8 w-8 lg:hidden"
              onClick={() => {
                setMobileTab("nav");
                setMobileDrawerOpen(true);
              }}
              aria-label="打开菜单"
            >
              <Menu className="h-5 w-5" />
              {activeCount > 0 && (
                <span
                  className="absolute -right-0.5 -top-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-red-600 px-1 font-mono text-[9px] font-bold leading-none text-white tabular-nums"
                  aria-label={`${activeCount} 件待处理`}
                >
                  {activeCount > 99 ? "99+" : activeCount}
                </span>
              )}
            </Button>
          </div>
        </header>

        {/* daemon 失联横幅：disconnected 持续 5s 才显示，避免短暂闪断吓人 */}
        <DaemonOfflineBanner wsState={wsState} />

        <div className="flex min-h-0 flex-1">
          <aside className="hidden w-56 shrink-0 flex-col border-r border-border bg-sidebar text-sidebar-foreground lg:flex">
            <SidebarContent wsState={wsState} groups={sidebarNav.groups} back={sidebarNav.back} />
          </aside>

          <main className="min-w-0 flex-1 overflow-y-auto scrollbar-thin">
            <Suspense fallback={<PageLoader />}>
              <Routes>
                <Route path="/" element={<Navigate to="/tasks" replace />} />
                {/* /now 已彻底面板化：重定向到流水线并自动展开右侧面板 */}
                <Route path="/now" element={<NowRedirect onOpen={openNowPanel} />} />
                <Route path="/start" element={<Start />} />
                <Route path="/library" element={<Library />} />
                <Route path="/settings" element={<SettingsRoute />} />
                <Route path="/settings/:section" element={<SettingsRoute />} />
                <Route
                  path="/tasks/:id"
                  element={<TaskDetailRoute subscribe={subscribe} />}
                />
                <Route path="/projects/:id" element={<ProjectDetailRoute />} />
                <Route path="/projects/:id/:section" element={<ProjectDetailRoute />} />
                <Route path="/requirements/:id" element={<RequirementDetail />} />
                <Route path="/projects" element={<Navigate to="/library?tab=projects" replace />} />
                <Route path="/tasks" element={<Tasks />} />
                <Route path="/workflows/new-with-ai" element={<NewWorkflowWithAI />} />
                <Route path="/workflows/:name" element={<WorkflowDetail />} />
                <Route path="/workflows" element={<Workflows />} />
                {/* /agents 旧入口：命名复用 agent 已删除，agent 配置下放到 phase 内联编辑（工作流编辑器） */}
                <Route path="/agents" element={<Navigate to="/workflows" replace />} />
                <Route path="/providers" element={<Navigate to="/settings/providers" replace />} />
                <Route path="/setup" element={<Setup />} />
                <Route path="*" element={<Navigate to="/tasks" replace />} />
              </Routes>
            </Suspense>
          </main>

          {/* 通知面板：桌面端内联右栏（Supabase Advisor 式） */}
          {nowOpen && (
            <aside
              className="relative hidden shrink-0 border-l border-border bg-background lg:block"
              style={{ width: panelWidth }}
            >
              {/* 左缘拖拽柄：调节面板宽度 */}
              <div
                className="absolute inset-y-0 left-0 z-10 w-1.5 cursor-col-resize transition-colors hover:bg-accent/40"
                onPointerDown={startPanelResize}
                role="separator"
                aria-orientation="vertical"
                aria-label="调节通知面板宽度"
              />
              <NotificationsPanel notifications={notifications} onClose={() => setNowOpen(false)} />
            </aside>
          )}

        </div>

        {/* 移动端 dock + 抽屉（Supabase 式）：容器锚定底部、pill 在面板上方 ——
            面板高度展开时容器顶边上移，pill 跟着抽屉一起从底部滑到顶部（连续动画，非换位） */}
        <>
            {/* 抽屉上方区域的玻璃遮罩（含 action bar 背后）：点击收起 */}
            {mobileDrawerOpen && (
              <div
                className="fixed inset-0 z-30 bg-background/40 backdrop-blur-md lg:hidden"
                onClick={() => setMobileDrawerOpen(false)}
                aria-hidden="true"
              />
            )}
          <div className="pointer-events-none fixed inset-x-0 bottom-0 z-40 flex flex-col lg:hidden">
            {/* action bar：无自带背景，悬浮在玻璃遮罩上，随展开一起上移；收起时离底部留一段距离 */}
            <div
              className={cn(
                "pointer-events-auto flex h-16 shrink-0 items-center justify-center gap-3 px-4",
                !mobileDrawerOpen && "mb-4",
              )}
            >
              <div className="flex items-center gap-1 rounded-full border border-border bg-card/95 p-1 shadow-lg backdrop-blur">
                {MOBILE_TABS.map((t) => {
                  const active = mobileDrawerOpen && mobileTab === t.key;
                  return (
                    <button
                      key={t.key}
                      type="button"
                      aria-label={t.label}
                      onClick={() => {
                        if (active) {
                          setMobileDrawerOpen(false);
                        } else {
                          setMobileTab(t.key);
                          setMobileDrawerOpen(true);
                        }
                      }}
                      className={cn(
                        "relative flex h-10 w-10 items-center justify-center rounded-full transition-colors",
                        active
                          ? "bg-foreground text-background"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      <t.icon className="h-4 w-4" />
                      {t.key === "now" && activeCount > 0 && (
                        <span
                          className="absolute right-1 top-1 h-2 w-2 rounded-full bg-red-600"
                          aria-label={`${activeCount} 件待处理`}
                        />
                      )}
                    </button>
                  );
                })}
              </div>
              {mobileDrawerOpen && (
                <button
                  type="button"
                  aria-label="关闭"
                  onClick={() => setMobileDrawerOpen(false)}
                  className="flex h-10 w-10 items-center justify-center rounded-full border border-border bg-card text-muted-foreground shadow-sm transition-colors hover:text-foreground"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>

            {/* 展开面板：圆角卡片本体，在 action bar 下方，高度 0 → 约 90vh；容器锚底，增高即整体上移 */}
            <div
              className={cn(
                "pointer-events-auto flex min-h-0 flex-col overflow-hidden rounded-t-2xl bg-background transition-[height,opacity] duration-300 ease-out",
                mobileDrawerOpen ? "h-[calc(90dvh-4rem)] border-t border-border opacity-100" : "h-0 opacity-0",
              )}
            >
              {mobileTab === "nav" && (
                <div className="h-full bg-sidebar text-sidebar-foreground">
                  <SidebarContent wsState={wsState} groups={sidebarNav.groups} back={sidebarNav.back} />
                </div>
              )}
              {mobileTab === "now" && (
                <NotificationsPanel notifications={notifications} onClose={() => setMobileDrawerOpen(false)} />
              )}
              {mobileTab === "search" && (
                <Command className="h-full rounded-none bg-transparent [&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-2 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group]]:px-2 [&_[cmdk-input-wrapper]_svg]:h-4 [&_[cmdk-input-wrapper]_svg]:w-4 [&_[cmdk-input]]:h-12 [&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-2 [&_[cmdk-item]_svg]:h-4 [&_[cmdk-item]_svg]:w-4">
                  <CommandPaletteContent
                    active={mobileDrawerOpen && mobileTab === "search"}
                    onClose={() => setMobileDrawerOpen(false)}
                    onNavigate={(path) => navigate(path)}
                    onSelectTask={(id) => navigate(`/tasks/${id}`)}
                    pathname={location.pathname}
                    listClassName="max-h-none flex-1"
                  />
                </Command>
              )}
            </div>
          </div>
        </>
      </div>

      <CommandPalette
        open={cmdOpen}
        onOpenChange={setCmdOpen}
        onNavigate={(path) => navigate(path)}
        onSelectTask={(id) => navigate(`/tasks/${id}`)}
        pathname={location.pathname}
      />

      <Toaster position="top-center" closeButton />
    </TooltipProvider>
  );
}

/** /now 旧路由：展开右侧 Now 面板并落到流水线页 */
function NowRedirect({ onOpen }: { onOpen: () => void }) {
  useEffect(() => {
    onOpen();
  }, [onOpen]);
  return <Navigate to="/tasks" replace />;
}

/**
 * /tasks/:id —— v2 R6：单 run 深链接（通知 view_task / 书签可达）。
 * 不再重定向到需求页；直接整页渲染该 run 详情，页头由 TaskDetail 自带面包屑回需求页
 * （有 requirement_id 时「← 需求 <reqId> · 执行 #N」；孤儿任务退回「返回」按钮）。
 */
function TaskDetailRoute({
  subscribe,
}: {
  subscribe: (channel: string, handler: (event: any) => void) => () => void;
}) {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  if (!id) return <Navigate to="/tasks" replace />;
  return <TaskDetail key={id} taskId={id} onBack={() => navigate("/tasks")} subscribe={subscribe} />;
}

const SETTINGS_SECTIONS = new Set(["providers", "scheduler", "network", "daemon"]);

function SettingsRoute() {
  const { section } = useParams<{ section?: string }>();
  const [params] = useSearchParams();

  // 旧链接兼容：API 密钥分区已于 2026-06-13 并入「提供商」
  if (section === "api-keys") {
    return <Navigate to="/settings/providers" replace />;
  }

  // 旧链接兼容：/settings?tab=providers → /settings/providers
  const legacyTab = params.get("tab");
  if (!section && legacyTab && (SETTINGS_SECTIONS.has(legacyTab) || legacyTab === "api-keys")) {
    return <Navigate to={`/settings/${legacyTab === "api-keys" ? "providers" : legacyTab}`} replace />;
  }
  if (section && !SETTINGS_SECTIONS.has(section)) {
    return <Navigate to="/settings" replace />;
  }
  return (
    <SettingsHub
      section={(section as "providers" | "scheduler" | "network" | "daemon" | undefined) ?? "general"}
    />
  );
}

const PROJECT_SECTIONS = new Set(["requirements", "workspaces", "settings"]);

function ProjectDetailRoute() {
  const { id, section } = useParams<{ id: string; section?: string }>();
  if (!id) return <Navigate to="/projects" replace />;
  // 项目无概览页：裸 /projects/:id（或非法 section）直接落需求子页
  if (!section || !PROJECT_SECTIONS.has(section)) {
    return <Navigate to={`/projects/${id}/requirements`} replace />;
  }
  return (
    <ProjectDetail
      key={id}
      projectId={id}
      section={section as "requirements" | "workspaces" | "settings"}
    />
  );
}

function SidebarContent({
  wsState,
  groups,
  back,
}: {
  wsState: "connected" | "connecting" | "disconnected";
  groups: NavGroupDef[];
  back: { to: string; label: string } | null;
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
      {/* logo 已上移到全宽顶栏，侧栏从导航直接开始（Supabase 式） */}
      <nav className="flex-1 space-y-4 overflow-y-auto scrollbar-thin p-3 pt-4">
        {/* 上下文导航（项目 / 设置）：顶部返回入口 */}
        {back && (
          <NavLink
            to={back.to}
            className="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-sidebar-accent/50 hover:text-foreground"
          >
            <ArrowLeft className="h-3.5 w-3.5 shrink-0" />
            {back.label}
          </NavLink>
        )}
        {groups.map((group) => (
          <div key={group.title}>
            <div className="mb-1.5 px-2.5 bp-label text-muted-foreground/70">
              {group.title}
            </div>
            <NavGroup items={group.items} />
          </div>
        ))}
      </nav>

      <div className="border-t border-border" />

      <div className="flex h-10 shrink-0 items-center gap-2 px-4 bp-label">
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
          <NavLinkItem item={item} />
        </li>
      ))}
    </ul>
  );
}

function NavLinkItem({ item }: { item: NavItem }) {
  return (
    <NavLink
      to={item.path}
      end={item.end}
      className={({ isActive }) =>
        cn(
          "group relative flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium transition-all",
          isActive
            ? "bg-sidebar-accent text-foreground"
            : "text-muted-foreground hover:bg-sidebar-accent/50 hover:text-foreground",
        )
      }
    >
      {({ isActive }) => (
        <>
          <item.icon
            className={cn("h-4 w-4 shrink-0", isActive ? "text-accent" : "text-foreground/60")}
          />
          <span className="flex-1">{item.label}</span>
        </>
      )}
    </NavLink>
  );
}

export function App() {
  return (
    <ToastProvider>
      <AppInner />
    </ToastProvider>
  );
}
