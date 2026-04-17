import React, { useEffect, useState } from "react";
import { useWebSocket } from "./hooks/useWebSocket";
import { ToastProvider } from "./components/Toast";
import { Dashboard } from "./pages/Dashboard";
import { Tasks } from "./pages/Tasks";
import { TaskDetail } from "./pages/TaskDetail";
import { Workflows } from "./pages/Workflows";
import { Config } from "./pages/Config";

type Page =
  | "dashboard"
  | "tasks"
  | "workflows"
  | "config"
  | { type: "task-detail"; id: string };

function AppInner() {
  const [page, setPage] = useState<Page>("dashboard");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const { state: wsState, subscribe } = useWebSocket();

  const currentPage = typeof page === "string" ? page : page.type;

  const navItems: { key: string; label: string; page: Page }[] = [
    { key: "dashboard", label: "Dashboard", page: "dashboard" },
    { key: "tasks", label: "任务", page: "tasks" },
    { key: "workflows", label: "工作流", page: "workflows" },
    { key: "config", label: "配置", page: "config" },
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

      {page === "dashboard" && (
        <Dashboard onSelectTask={(id) => setPage({ type: "task-detail", id })} />
      )}
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
      {page === "workflows" && (
        <Workflows onJumpToAgent={() => setPage("config")} />
      )}
      {page === "config" && <Config />}
    </>
  );
}

export function App() {
  return (
    <ToastProvider>
      <AppInner />
    </ToastProvider>
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
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-primary { background: var(--accent); color: #fff; }
.btn-primary:hover:not(:disabled) { background: var(--accent2); }
.btn-secondary { background: var(--bg3); color: var(--text2); border: 1px solid var(--border); }
.btn-secondary:hover:not(:disabled) { background: var(--border); color: var(--text); }
.btn-danger { background: transparent; color: var(--red); border: 1px solid rgba(248,113,113,0.3); }
.btn-danger:hover:not(:disabled) { background: rgba(248,113,113,0.12); }

.form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0.9rem; }
.form-grid label { display: flex; flex-direction: column; gap: 0.3rem; font-size: 0.82rem; color: var(--text2); }
.form-grid label > span { font-weight: 500; }
.form-grid label small { font-size: 0.72rem; }
.form-grid .col-span-2 { grid-column: span 2; }
.form-grid .required { color: var(--red); }

.text-input { width: 100%; padding: 0.55rem 0.75rem; background: var(--bg0); border: 1px solid var(--border); border-radius: 6px; color: var(--text); font-size: 16px; min-height: 40px; transition: border-color 0.15s; }
.text-input:focus { outline: none; border-color: var(--cyan); }
.text-input:disabled { opacity: 0.6; cursor: not-allowed; }
.text-input::placeholder { color: var(--muted); }

.switch { display: flex; align-items: center; gap: 0.5rem; cursor: pointer; font-size: 0.82rem; color: var(--text2); }
.switch input[type="checkbox"] { appearance: none; width: 36px; height: 20px; background: var(--bg3); border: 1px solid var(--border); border-radius: 10px; position: relative; cursor: pointer; transition: background 0.15s; }
.switch input[type="checkbox"]::after { content: ""; position: absolute; top: 1px; left: 1px; width: 16px; height: 16px; border-radius: 50%; background: var(--text2); transition: transform 0.15s, background 0.15s; }
.switch input[type="checkbox"]:checked { background: var(--accent-dim); border-color: var(--accent); }
.switch input[type="checkbox"]:checked::after { transform: translateX(16px); background: var(--accent2); }

.provider-list { display: grid; grid-template-columns: 1fr; gap: 1rem; }
.provider-card .card-header h3 { font-size: 1rem; color: var(--cyan); }
.status-pill { font-size: 0.7rem; padding: 0.15rem 0.55rem; border: 1px solid; }
.status-unknown { background: var(--bg3); color: var(--muted); border-color: var(--border); }
.status-ok { background: rgba(52,211,153,0.12); color: var(--green); border-color: rgba(52,211,153,0.3); }
.status-warn { background: rgba(251,191,36,0.12); color: var(--yellow); border-color: rgba(251,191,36,0.3); }
.status-missing { background: rgba(248,113,113,0.12); color: var(--red); border-color: rgba(248,113,113,0.3); }
.status-detail { background: var(--bg0); border: 1px solid var(--border); border-radius: 6px; padding: 0.6rem 0.75rem; margin-bottom: 0.75rem; word-break: break-all; }
.status-detail-error { border-color: rgba(248,113,113,0.3); background: rgba(248,113,113,0.06); color: var(--red); }

.agent-list { display: grid; grid-template-columns: 1fr; gap: 0.75rem; }
.agent-card-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 0.75rem; flex-wrap: wrap; }
.agent-card-head h3 { font-size: 1rem; margin-bottom: 0.35rem; }
.agent-meta { font-size: 0.78rem; display: flex; gap: 0.5rem; flex-wrap: wrap; }
.agent-actions { display: flex; gap: 0.5rem; flex-shrink: 0; }
.agent-prompt { margin-top: 0.6rem; font-size: 0.82rem; line-height: 1.5; white-space: pre-wrap; word-break: break-word; }

.btn-danger-solid { background: var(--red); color: #fff; }
.btn-danger-solid:hover:not(:disabled) { background: #ef5959; }

.empty-state { text-align: center; padding: 2.5rem 1rem; display: flex; flex-direction: column; align-items: center; gap: 1rem; }
.empty-state p { margin: 0; }

.subtabs { display: flex; gap: 2px; border-bottom: 1px solid var(--border); margin-bottom: 1.25rem; overflow-x: auto; -webkit-overflow-scrolling: touch; scrollbar-width: none; }
.subtabs::-webkit-scrollbar { display: none; }
.subtab { background: transparent; border: none; padding: 0.7rem 1.1rem; color: var(--muted); font-size: 0.88rem; font-weight: 500; font-family: inherit; cursor: pointer; border-bottom: 2px solid transparent; margin-bottom: -1px; white-space: nowrap; min-height: 40px; }
.subtab:hover { color: var(--text2); }
.subtab.active { color: var(--cyan); border-bottom-color: var(--cyan); }
.subtab-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; margin-bottom: 1rem; flex-wrap: wrap; }

.modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.6); z-index: 300; animation: fadeIn 0.15s ease; }
.modal { position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); background: var(--bg2); border: 1px solid var(--border2); border-radius: var(--radius); z-index: 301; width: calc(100vw - 2rem); max-height: calc(100vh - 2rem); display: flex; flex-direction: column; box-shadow: 0 20px 60px rgba(0,0,0,0.6); animation: modalIn 0.15s ease; outline: none; }
.modal-sm { max-width: 420px; }
.modal-md { max-width: 560px; }
.modal-lg { max-width: 800px; }
.modal-header { display: flex; align-items: center; justify-content: space-between; padding: 1rem 1.25rem; border-bottom: 1px solid var(--border); }
.modal-header h3 { font-size: 1rem; font-weight: 600; margin: 0; }
.modal-close { background: none; border: none; color: var(--text2); font-size: 1.6rem; line-height: 1; width: 32px; height: 32px; border-radius: 6px; cursor: pointer; display: flex; align-items: center; justify-content: center; }
.modal-close:hover { background: var(--bg3); color: var(--text); }
.modal-body { padding: 1.25rem; overflow-y: auto; font-size: 0.9rem; }
.modal-actions { display: flex; gap: 0.5rem; justify-content: flex-end; padding: 0.75rem 1.25rem; border-top: 1px solid var(--border); flex-wrap: wrap; }
@keyframes modalIn { from { opacity: 0; transform: translate(-50%, -48%); } to { opacity: 1; transform: translate(-50%, -50%); } }

.toast-stack { position: fixed; top: 60px; right: 1rem; z-index: 400; display: flex; flex-direction: column; gap: 0.5rem; width: min(380px, calc(100vw - 2rem)); pointer-events: none; }
.toast-item { pointer-events: auto; border-radius: 8px; padding: 0.7rem 0.9rem; font-size: 0.84rem; border: 1px solid; animation: slideIn 0.2s ease; box-shadow: 0 6px 20px rgba(0,0,0,0.3); }
.toast-row { display: flex; align-items: center; gap: 0.5rem; }
.toast-msg { flex: 1; word-break: break-word; }
.toast-row-actions { display: flex; gap: 0.25rem; flex-shrink: 0; }
.toast-btn { background: transparent; border: 1px solid transparent; color: inherit; opacity: 0.75; padding: 0.2rem 0.5rem; border-radius: 4px; font-size: 0.75rem; cursor: pointer; font-family: inherit; }
.toast-btn:hover { opacity: 1; background: rgba(255,255,255,0.1); }
.toast-close { font-size: 1.1rem; line-height: 1; padding: 0 0.4rem; }
.toast-detail { margin-top: 0.5rem; padding: 0.5rem; background: rgba(0,0,0,0.3); border-radius: 4px; font-size: 0.75rem; font-family: var(--mono); white-space: pre-wrap; word-break: break-word; max-height: 200px; overflow: auto; }
.toast-success { background: rgba(52,211,153,0.12); color: var(--green); border-color: rgba(52,211,153,0.3); }
.toast-info { background: rgba(96,165,250,0.12); color: var(--blue); border-color: rgba(96,165,250,0.3); }
.toast-warning { background: rgba(251,191,36,0.12); color: var(--yellow); border-color: rgba(251,191,36,0.3); }
.toast-error { background: rgba(248,113,113,0.12); color: var(--red); border-color: rgba(248,113,113,0.3); }
@keyframes slideIn { from { transform: translateX(20px); opacity: 0; } to { transform: translateX(0); opacity: 1; } }

kbd { background: var(--bg3); border: 1px solid var(--border); border-radius: 4px; padding: 0.1rem 0.4rem; font-family: var(--mono); font-size: 0.78em; color: var(--text2); }

.pill { display: inline-flex; align-items: center; padding: 0.12rem 0.55rem; border-radius: 10px; font-size: 0.72rem; font-weight: 500; }
.pill-cyan { background: var(--cyan-dim); color: var(--cyan); border: 1px solid rgba(34,211,238,0.25); }
.pill-accent { background: var(--accent-dim); color: var(--accent2); border: 1px solid rgba(99,102,241,0.3); }
.usage-pills { margin-top: 0.6rem; display: flex; align-items: center; flex-wrap: wrap; gap: 0.3rem; }
.usage-label { font-size: 0.76rem; color: var(--muted); margin-right: 0.25rem; }

.alert-card { border-color: rgba(251,191,36,0.35); background: rgba(251,191,36,0.06); }
.alert-head { display: flex; align-items: baseline; justify-content: space-between; gap: 0.5rem; margin-bottom: 0.75rem; flex-wrap: wrap; }
.alert-head strong { color: var(--yellow); }

.task-inline-list { list-style: none; display: flex; flex-direction: column; gap: 0.35rem; }
.task-inline-list li { display: flex; align-items: center; gap: 0.75rem; padding: 0.4rem 0.5rem; border-radius: 6px; cursor: pointer; font-size: 0.85rem; flex-wrap: wrap; }
.task-inline-list li:hover { background: var(--bg3); }
.task-inline-title { flex: 1; min-width: 120px; }

.workflow-card.active { border-color: var(--cyan); }

.filter-bar { display: grid; grid-template-columns: 1fr auto auto; gap: 0.6rem; margin-bottom: 1rem; align-items: center; }
.filter-chips { display: flex; gap: 4px; overflow-x: auto; -webkit-overflow-scrolling: touch; scrollbar-width: none; }
.filter-chips::-webkit-scrollbar { display: none; }
.chip { background: var(--bg2); border: 1px solid var(--border); color: var(--text2); padding: 0.35rem 0.75rem; border-radius: 16px; font-size: 0.78rem; font-family: inherit; cursor: pointer; white-space: nowrap; min-height: 32px; transition: all 0.15s; }
.chip:hover { color: var(--text); border-color: var(--border2); }
.chip.active { background: var(--cyan-dim); color: var(--cyan); border-color: rgba(34,211,238,0.35); }
.filter-wf { min-width: 140px; max-width: 220px; }

.task-card-list { display: flex; flex-direction: column; gap: 0.6rem; }
.task-card { cursor: pointer; transition: border-color 0.15s; padding: 0.9rem; }
.task-card:hover { border-color: var(--border2); }
.task-card-top { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.4rem; gap: 0.5rem; }
.task-card-id { color: var(--cyan); font-size: 0.85rem; }
.task-card-title { font-size: 0.92rem; margin-bottom: 0.35rem; word-break: break-word; }
.task-card-meta { display: flex; justify-content: space-between; gap: 0.5rem; font-size: 0.76rem; flex-wrap: wrap; }

.mobile-only { display: none; }
.desktop-only { display: block; }

.phase-list { display: flex; flex-direction: column; gap: 0.5rem; }
.phase-row { display: flex; gap: 0.75rem; align-items: flex-start; background: var(--bg0); border: 1px solid var(--border); border-radius: 8px; padding: 0.75rem 0.9rem; }
.phase-row-parallel { border-color: rgba(99,102,241,0.35); background: rgba(99,102,241,0.04); }
.phase-row-main { display: flex; gap: 0.75rem; align-items: flex-start; flex: 1; min-width: 0; }
.phase-idx { background: var(--bg3); color: var(--text2); border-radius: 50%; width: 26px; height: 26px; font-size: 0.78rem; font-family: var(--mono); display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
.phase-body { flex: 1; min-width: 0; }
.phase-title { display: flex; align-items: center; margin-bottom: 0.4rem; flex-wrap: wrap; }
.phase-fields { display: flex; gap: 0.75rem; flex-wrap: wrap; }
.phase-fields label { display: flex; flex-direction: column; gap: 0.2rem; font-size: 0.76rem; }
.phase-fields label > span { font-size: 0.72rem; }
.phase-input { min-height: 32px; padding: 0.35rem 0.6rem; font-size: 0.85rem; min-width: 100px; }
.phase-name-input { min-height: 28px; padding: 0.2rem 0.5rem; font-size: 0.9rem; font-weight: 600; color: var(--cyan); background: transparent; border-color: transparent; min-width: 100px; max-width: 260px; }
.phase-name-input:hover { border-color: var(--border); background: var(--bg0); }
.phase-name-input:focus { border-color: var(--cyan); background: var(--bg0); }

.code-viewer { background: var(--bg0); border: 1px solid var(--border); border-radius: 6px; font-family: var(--mono); font-size: 0.8rem; line-height: 1.55; max-height: 480px; overflow: auto; }
.code-line { display: flex; padding: 0 0.25rem 0 0; white-space: pre; }
.code-line:hover { background: rgba(255,255,255,0.02); }
.code-gutter { flex-shrink: 0; padding: 0 0.6rem; color: var(--muted); user-select: none; text-align: right; background: var(--bg1); border-right: 1px solid var(--border); }
.code-content { padding-left: 0.75rem; white-space: pre; overflow-x: visible; }
.code-comment { color: var(--muted); font-style: italic; }
.code-string { color: #a5d6a7; }
.code-keyword { color: var(--accent2); }
.code-number { color: #f39c6b; }
.code-fn { color: var(--cyan); }
.code-fn-hl { background: rgba(129,140,248,0.2); border-radius: 3px; padding: 0 2px; }

.orphan-alert { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; flex-wrap: wrap; padding: 0.6rem 0.9rem; background: rgba(251,191,36,0.08); border: 1px solid rgba(251,191,36,0.3); border-radius: 6px; margin-bottom: 0.75rem; font-size: 0.85rem; color: var(--yellow); }
.orphan-alert code { background: rgba(251,191,36,0.12); padding: 0.1rem 0.35rem; border-radius: 3px; font-size: 0.82rem; }
.phase-subgrid { display: flex; gap: 0.5rem; flex-wrap: wrap; margin-top: 0.3rem; }
.phase-sub { background: var(--bg2); padding: 0.25rem 0.6rem; border-radius: 4px; font-size: 0.8rem; display: flex; gap: 0.4rem; align-items: center; }
.phase-actions { display: flex; gap: 0.2rem; flex-shrink: 0; align-self: center; }

.btn-icon { width: 30px; height: 30px; display: flex; align-items: center; justify-content: center; background: transparent; border: 1px solid var(--border); border-radius: 5px; color: var(--text2); cursor: pointer; font-size: 0.9rem; padding: 0; font-family: inherit; transition: all 0.12s; }
.btn-icon:hover:not(:disabled) { background: var(--bg3); color: var(--text); }
.btn-icon:disabled { opacity: 0.3; cursor: not-allowed; }
.btn-icon-danger { color: var(--red); border-color: rgba(248,113,113,0.3); }
.btn-icon-danger:hover:not(:disabled) { background: rgba(248,113,113,0.12); color: var(--red); }

.parallel-children { margin-top: 0.6rem; margin-left: 34px; padding-left: 0.75rem; border-left: 2px dashed rgba(99,102,241,0.3); display: flex; flex-direction: column; gap: 0.4rem; }
.parallel-child { background: var(--bg2); padding: 0.5rem 0.7rem; }
.phase-idx-small { font-size: 0.7rem; padding-top: 0.5rem; min-width: 32px; }

.phase-row.highlight { border-color: var(--accent2); box-shadow: 0 0 0 1px rgba(99,102,241,0.3); }

.pipeline-wrap { padding: 0.25rem 0; }
.pipeline { display: flex; align-items: center; gap: 0.5rem; overflow-x: auto; -webkit-overflow-scrolling: touch; padding: 0.5rem 0.25rem 0.75rem; }
.pipeline-arrow { color: var(--muted); font-size: 1.1rem; flex-shrink: 0; user-select: none; }
.pipeline-node { background: var(--bg0); border: 1px solid var(--border2); border-radius: 8px; padding: 0.5rem 0.85rem; min-width: 100px; text-align: center; cursor: pointer; transition: all 0.12s; flex-shrink: 0; }
.pipeline-node:hover, .pipeline-node.highlight { border-color: var(--accent2); transform: translateY(-1px); box-shadow: 0 4px 12px rgba(99,102,241,0.2); }
.pipeline-node.current { border-color: var(--cyan); background: var(--cyan-dim); }
.pipeline-node-name { font-size: 0.85rem; color: var(--text); white-space: nowrap; }
.pipeline-node-meta { font-size: 0.7rem; margin-top: 0.15rem; }

.pipeline-parallel { display: flex; flex-direction: column; gap: 0.4rem; padding: 0.4rem 0.5rem; border: 1px dashed rgba(99,102,241,0.5); border-radius: 10px; background: rgba(99,102,241,0.04); flex-shrink: 0; }
.pipeline-parallel-head { display: flex; align-items: center; gap: 0.4rem; padding: 0.1rem 0.2rem; cursor: pointer; transition: color 0.12s; }
.pipeline-parallel-head.highlight { color: var(--accent2); }
.pipeline-parallel-body { display: flex; flex-direction: column; gap: 0.3rem; }
.pipeline-parallel-body .pipeline-node { min-width: 110px; }

.pipeline-rejects { display: flex; flex-wrap: wrap; gap: 0.5rem 0.9rem; padding: 0.5rem 0.25rem; border-top: 1px dashed var(--border); margin-top: 0.25rem; align-items: center; }
.pipeline-reject { display: flex; align-items: center; gap: 0.25rem; font-size: 0.8rem; }

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

  .form-grid { grid-template-columns: 1fr; gap: 0.75rem; }
  .form-grid .col-span-2 { grid-column: auto; }

  .agent-card-head { flex-direction: column; align-items: stretch; }
  .agent-actions { justify-content: flex-end; }

  .workflow-grid { grid-template-columns: 1fr; }

  .toast-stack { top: auto; bottom: 0.75rem; right: 0.75rem; left: 0.75rem; width: auto; }

  .modal { width: calc(100vw - 1rem); }
  .modal-header, .modal-body, .modal-actions { padding-left: 1rem; padding-right: 1rem; }

  .filter-bar { grid-template-columns: 1fr; gap: 0.5rem; }
  .filter-wf { min-width: 0; max-width: none; width: 100%; }

  .mobile-only { display: flex; flex-direction: column; }
  .desktop-only { display: none; }

  .task-inline-list li { gap: 0.5rem; font-size: 0.8rem; }

  .phase-row { flex-direction: column; gap: 0.5rem; }
  .phase-row-main { flex: initial; }
  .phase-actions { align-self: flex-end; }
  .phase-fields label { flex: 1; }
  .phase-input { width: 100%; }

  .parallel-children { margin-left: 0; padding-left: 0.5rem; }
}

@media (max-width: 380px) {
  .stats { grid-template-columns: 1fr; }
}
`;
