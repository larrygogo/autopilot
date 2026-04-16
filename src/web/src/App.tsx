import React, { useEffect, useState } from "react";
import { useWebSocket } from "./hooks/useWebSocket";
import { Dashboard } from "./pages/Dashboard";
import { Tasks } from "./pages/Tasks";
import { TaskDetail } from "./pages/TaskDetail";
import { Workflows } from "./pages/Workflows";
import { Settings } from "./pages/Settings";

type Page = "dashboard" | "tasks" | "workflows" | "settings" | { type: "task-detail"; id: string };

export function App() {
  const [page, setPage] = useState<Page>("dashboard");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const { state: wsState, subscribe } = useWebSocket();

  const currentPage = typeof page === "string" ? page : page.type;

  const navItems: { key: string; label: string; page: Page }[] = [
    { key: "dashboard", label: "Dashboard", page: "dashboard" },
    { key: "tasks", label: "任务", page: "tasks" },
    { key: "workflows", label: "工作流", page: "workflows" },
    { key: "settings", label: "设置", page: "settings" },
  ];

  const wsColor = wsState === "connected" ? "#34d399" : wsState === "connecting" ? "#fbbf24" : "#f87171";

  const navigate = (p: Page) => {
    setPage(p);
    setDrawerOpen(false);
  };

  // drawer 打开时锁滚动 + ESC 关闭
  useEffect(() => {
    if (!drawerOpen) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDrawerOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [drawerOpen]);

  return (
    <>
      <style>{GLOBAL_CSS}</style>
      <nav className="topbar">
        <button
          type="button"
          className="hamburger"
          aria-label="打开菜单"
          aria-expanded={drawerOpen}
          onClick={() => setDrawerOpen(true)}
        >
          <span /><span /><span />
        </button>
        <div className="logo">
          <span className="dot" style={{ background: wsColor, boxShadow: `0 0 8px ${wsColor}` }} />
          AUTOPILOT
        </div>
        <div className="links desktop-nav">
          {navItems.map((item) => (
            <button
              key={item.key}
              type="button"
              className={currentPage === item.key ? "active" : ""}
              onClick={() => navigate(item.page)}
            >
              {item.label}
            </button>
          ))}
        </div>
      </nav>

      {drawerOpen && (
        <>
          <div className="drawer-overlay" onClick={() => setDrawerOpen(false)} />
          <aside className="drawer" role="dialog" aria-label="导航菜单">
            <div className="drawer-header">
              <span className="drawer-title">菜单</span>
              <button
                type="button"
                className="drawer-close"
                aria-label="关闭菜单"
                onClick={() => setDrawerOpen(false)}
              >
                ×
              </button>
            </div>
            <nav className="drawer-links">
              {navItems.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  className={currentPage === item.key ? "active" : ""}
                  onClick={() => navigate(item.page)}
                >
                  {item.label}
                </button>
              ))}
            </nav>
          </aside>
        </>
      )}

      {page === "dashboard" && <Dashboard />}
      {page === "tasks" && (
        <Tasks
          onSelect={(id) => setPage({ type: "task-detail", id })}
          subscribe={subscribe}
        />
      )}
      {typeof page !== "string" && page.type === "task-detail" && (
        <TaskDetail
          taskId={page.id}
          onBack={() => setPage("tasks")}
          subscribe={subscribe}
        />
      )}
      {page === "workflows" && <Workflows />}
      {page === "settings" && <Settings />}
    </>
  );
}

const GLOBAL_CSS = `
:root {
  --bg0: #0a0a0f; --bg1: #0f1117; --bg2: #161822; --bg3: #1e2030;
  --border: #252838; --border2: #2e3348;
  --text: #e2e4ea; --text2: #a0a4b8; --muted: #636882;
  --accent: #6366f1; --accent2: #818cf8; --accent-dim: rgba(99,102,241,0.12);
  --cyan: #22d3ee; --cyan-dim: rgba(34,211,238,0.1);
  --green: #34d399; --red: #f87171; --blue: #60a5fa; --yellow: #fbbf24;
  --radius: 10px;
  --mono: 'Cascadia Code', 'Fira Code', 'Consolas', 'SF Mono', 'Menlo', monospace;
  --sans: system-ui, 'Microsoft YaHei UI', 'PingFang SC', sans-serif;
}
* { margin: 0; padding: 0; box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }
body { font-family: var(--sans); background: var(--bg0); color: var(--text); line-height: 1.6; -webkit-font-smoothing: antialiased; overflow-x: hidden; }
::selection { background: var(--accent); color: #fff; }
a { cursor: pointer; }

.topbar { background: var(--bg1); border-bottom: 1px solid var(--border); padding: 0 2rem; display: flex; align-items: center; height: 52px; position: sticky; top: 0; z-index: 100; gap: 0.5rem; }
.topbar .logo { font-family: var(--mono); font-weight: 700; font-size: 0.95rem; color: var(--cyan); margin-right: 2.5rem; display: flex; align-items: center; gap: 0.6rem; flex-shrink: 0; }
.topbar .logo .dot { width: 7px; height: 7px; border-radius: 50%; }
.topbar .links { display: flex; gap: 2px; }
.topbar .links button { color: var(--muted); background: transparent; border: none; padding: 0.4rem 0.9rem; border-radius: 6px; font-size: 0.84rem; font-weight: 500; font-family: inherit; cursor: pointer; transition: all 0.15s; white-space: nowrap; }
.topbar .links button:hover { color: var(--text2); background: var(--bg3); }
.topbar .links button.active { color: var(--cyan); background: var(--cyan-dim); }

.topbar .hamburger { display: none; flex-direction: column; justify-content: center; gap: 4px; width: 40px; height: 40px; padding: 10px; border: none; background: transparent; cursor: pointer; border-radius: 6px; flex-shrink: 0; }
.topbar .hamburger:hover { background: var(--bg3); }
.topbar .hamburger span { display: block; width: 20px; height: 2px; background: var(--text2); border-radius: 1px; transition: background 0.15s; }

.drawer-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.55); z-index: 199; animation: fadeIn 0.15s ease; }
.drawer { position: fixed; top: 0; left: 0; bottom: 0; width: 78vw; max-width: 300px; background: var(--bg1); border-right: 1px solid var(--border); z-index: 200; display: flex; flex-direction: column; animation: slideRight 0.2s ease; box-shadow: 4px 0 24px rgba(0,0,0,0.4); }
.drawer-header { display: flex; align-items: center; justify-content: space-between; padding: 0 1rem; height: 52px; border-bottom: 1px solid var(--border); }
.drawer-title { font-family: var(--mono); font-weight: 700; font-size: 0.9rem; color: var(--cyan); }
.drawer-close { background: none; border: none; color: var(--text2); font-size: 1.6rem; line-height: 1; width: 36px; height: 36px; border-radius: 6px; cursor: pointer; display: flex; align-items: center; justify-content: center; }
.drawer-close:hover { background: var(--bg3); color: var(--text); }
.drawer-links { display: flex; flex-direction: column; padding: 0.75rem 0.5rem; gap: 2px; }
.drawer-links button { text-align: left; color: var(--text2); background: transparent; border: none; padding: 0.75rem 1rem; border-radius: 8px; font-size: 0.95rem; font-weight: 500; font-family: inherit; cursor: pointer; min-height: 44px; }
.drawer-links button:hover { background: var(--bg3); color: var(--text); }
.drawer-links button.active { color: var(--cyan); background: var(--cyan-dim); }
@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
@keyframes slideRight { from { transform: translateX(-100%); } to { transform: translateX(0); } }

.container { max-width: 1120px; margin: 0 auto; padding: 1.5rem 1.25rem; }
.page-hdr { margin-bottom: 1.5rem; display: flex; align-items: baseline; gap: 0.75rem; flex-wrap: wrap; }
.page-hdr h2 { font-size: 1.25rem; font-weight: 700; }
.page-hdr span { font-size: 0.8rem; color: var(--muted); font-family: var(--mono); }
.muted { color: var(--muted); }
.mono { font-family: var(--mono); }

.stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.75rem; margin-bottom: 1.25rem; }
.stat { background: var(--bg2); border: 1px solid var(--border); border-radius: var(--radius); padding: 1.1rem 1.3rem; }
.stat .lbl { font-size: 0.72rem; font-weight: 600; color: var(--muted); letter-spacing: 0.04em; text-transform: uppercase; }
.stat .val { font-size: 1.8rem; font-weight: 700; font-family: var(--mono); margin-top: 0.3rem; }

.card { background: var(--bg2); border: 1px solid var(--border); border-radius: var(--radius); padding: 1.2rem; }
.card h3 { font-size: 0.9rem; font-weight: 600; margin-bottom: 0.5rem; }

.table-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; margin: 0 -0.25rem; }
.task-table { width: 100%; border-collapse: collapse; }
.task-table th { text-align: left; padding: 0.6rem 0.75rem; font-size: 0.72rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; border-bottom: 1px solid var(--border); white-space: nowrap; }
.task-table td { padding: 0.6rem 0.75rem; border-bottom: 1px solid var(--border); font-size: 0.85rem; white-space: nowrap; }
.task-table tr:hover { background: var(--bg3); }

.info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0.5rem; }
.task-info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0.5rem; word-break: break-word; }

.btn-back { background: none; border: 1px solid var(--border); color: var(--text2); padding: 0.4rem 0.9rem; border-radius: 6px; cursor: pointer; font-size: 0.82rem; min-height: 36px; }
.btn-back:hover { background: var(--bg3); }

.workflow-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 0.75rem; }
.workflow-card { cursor: pointer; transition: border-color 0.15s; }
.workflow-card:hover { border-color: var(--cyan); }

.live-log { font-family: var(--mono); font-size: 0.78rem; max-height: 300px; overflow-y: auto; overflow-x: auto; -webkit-overflow-scrolling: touch; }
.log-line { padding: 0.15rem 0; color: var(--text2); white-space: pre; }

.graph-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; margin: 0 -0.25rem; }
.graph-wrap svg { display: block; max-width: none; }

.card-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.75rem; gap: 0.5rem; flex-wrap: wrap; }
.card-header h3 { margin-bottom: 0; }
.card-actions { display: flex; gap: 0.5rem; margin-top: 0.75rem; flex-wrap: wrap; }

.settings-info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0.5rem; margin-top: 0.5rem; word-break: break-word; }

.yaml-editor { width: 100%; min-height: 250px; background: var(--bg0); border: 1px solid var(--border); border-radius: 6px; color: var(--text); font-family: var(--mono); font-size: 16px; padding: 0.75rem; resize: vertical; line-height: 1.5; tab-size: 2; }
.yaml-editor:focus { outline: none; border-color: var(--cyan); }
.yaml-editor::placeholder { color: var(--muted); }

.wf-select { width: 100%; padding: 0.5rem 0.75rem; background: var(--bg0); border: 1px solid var(--border); border-radius: 6px; color: var(--text); font-size: 16px; cursor: pointer; min-height: 40px; }
.wf-select:focus { outline: none; border-color: var(--cyan); }
.wf-select option { background: var(--bg1); color: var(--text); }

.btn { padding: 0.55rem 1.2rem; border-radius: 6px; font-size: 0.85rem; font-weight: 500; cursor: pointer; border: none; transition: all 0.15s; min-height: 40px; }
.btn-primary { background: var(--accent); color: #fff; }
.btn-primary:hover { background: var(--accent2); }
.btn-secondary { background: var(--bg3); color: var(--text2); border: 1px solid var(--border); }
.btn-secondary:hover { background: var(--border); color: var(--text); }

.toast { position: fixed; top: 60px; right: 1.5rem; padding: 0.6rem 1.2rem; border-radius: 8px; font-size: 0.82rem; font-weight: 500; z-index: 200; animation: slideIn 0.2s ease; max-width: calc(100vw - 3rem); }
.toast-success { background: rgba(52,211,153,0.15); color: var(--green); border: 1px solid rgba(52,211,153,0.3); }
.toast-error { background: rgba(248,113,113,0.15); color: var(--red); border: 1px solid rgba(248,113,113,0.3); }
@keyframes slideIn { from { transform: translateX(20px); opacity: 0; } to { transform: translateX(0); opacity: 1; } }

@media (max-width: 640px) {
  .topbar { padding: 0 0.75rem; height: 48px; }
  .topbar .logo { margin-right: 0; font-size: 0.85rem; flex: 1; }
  .topbar .hamburger { display: flex; }
  .topbar .desktop-nav { display: none; }

  .container { padding: 1rem 0.875rem; }
  .page-hdr { margin-bottom: 1rem; gap: 0.5rem; }
  .page-hdr h2 { font-size: 1.1rem; }

  .stats { grid-template-columns: 1fr 1fr; gap: 0.5rem; margin-bottom: 1rem; }
  .stat { padding: 0.85rem 1rem; }
  .stat .val { font-size: 1.4rem; }

  .card { padding: 0.9rem; }

  .info-grid,
  .task-info-grid,
  .settings-info-grid { grid-template-columns: 1fr; gap: 0.35rem; }

  .workflow-grid { grid-template-columns: 1fr; }

  .toast { top: auto; bottom: 1rem; left: 1rem; right: 1rem; max-width: none; text-align: center; }
}

@media (max-width: 380px) {
  .stats { grid-template-columns: 1fr; }
}
`;
