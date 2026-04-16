import React, { useState } from "react";
import { useWebSocket } from "./hooks/useWebSocket";
import { Dashboard } from "./pages/Dashboard";
import { Tasks } from "./pages/Tasks";
import { TaskDetail } from "./pages/TaskDetail";
import { Workflows } from "./pages/Workflows";
import { Settings } from "./pages/Settings";

type Page = "dashboard" | "tasks" | "workflows" | "settings" | { type: "task-detail"; id: string };

export function App() {
  const [page, setPage] = useState<Page>("dashboard");
  const { state: wsState, subscribe } = useWebSocket();

  const currentPage = typeof page === "string" ? page : page.type;

  const navItems: { key: string; label: string; page: Page }[] = [
    { key: "dashboard", label: "Dashboard", page: "dashboard" },
    { key: "tasks", label: "任务", page: "tasks" },
    { key: "workflows", label: "工作流", page: "workflows" },
    { key: "settings", label: "设置", page: "settings" },
  ];

  const wsColor = wsState === "connected" ? "#34d399" : wsState === "connecting" ? "#fbbf24" : "#f87171";

  return (
    <>
      <style>{GLOBAL_CSS}</style>
      <nav>
        <div className="logo">
          <span className="dot" style={{ background: wsColor, boxShadow: `0 0 8px ${wsColor}` }} />
          AUTOPILOT
        </div>
        <div className="links">
          {navItems.map((item) => (
            <a
              key={item.key}
              className={currentPage === item.key ? "active" : ""}
              onClick={() => setPage(item.page)}
              href="#"
            >
              {item.label}
            </a>
          ))}
        </div>
      </nav>

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
body { font-family: var(--sans); background: var(--bg0); color: var(--text); line-height: 1.6; -webkit-font-smoothing: antialiased; }
::selection { background: var(--accent); color: #fff; }
a { cursor: pointer; }

nav { background: var(--bg1); border-bottom: 1px solid var(--border); padding: 0 2rem; display: flex; align-items: center; height: 52px; position: sticky; top: 0; z-index: 100; }
nav .logo { font-family: var(--mono); font-weight: 700; font-size: 0.95rem; color: var(--cyan); margin-right: 2.5rem; display: flex; align-items: center; gap: 0.6rem; }
nav .logo .dot { width: 7px; height: 7px; border-radius: 50%; }
nav .links { display: flex; gap: 2px; }
nav a { color: var(--muted); text-decoration: none; padding: 0.4rem 0.9rem; border-radius: 6px; font-size: 0.84rem; font-weight: 500; transition: all 0.15s; }
nav a:hover { color: var(--text2); background: var(--bg3); }
nav a.active { color: var(--cyan); background: var(--cyan-dim); }

.container { max-width: 1120px; margin: 0 auto; padding: 1.5rem 1.25rem; }
.page-hdr { margin-bottom: 1.5rem; display: flex; align-items: baseline; gap: 0.75rem; }
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

.task-table { width: 100%; border-collapse: collapse; }
.task-table th { text-align: left; padding: 0.6rem 0.75rem; font-size: 0.72rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; border-bottom: 1px solid var(--border); }
.task-table td { padding: 0.6rem 0.75rem; border-bottom: 1px solid var(--border); font-size: 0.85rem; }
.task-table tr:hover { background: var(--bg3); }

.task-info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0.5rem; }

.btn-back { background: none; border: 1px solid var(--border); color: var(--text2); padding: 0.3rem 0.8rem; border-radius: 6px; cursor: pointer; font-size: 0.82rem; }
.btn-back:hover { background: var(--bg3); }

.workflow-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 0.75rem; }
.workflow-card { cursor: pointer; transition: border-color 0.15s; }
.workflow-card:hover { border-color: var(--cyan); }

.live-log { font-family: var(--mono); font-size: 0.78rem; max-height: 300px; overflow-y: auto; }
.log-line { padding: 0.15rem 0; color: var(--text2); white-space: pre; }

.card-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.75rem; }
.card-header h3 { margin-bottom: 0; }
.card-actions { display: flex; gap: 0.5rem; margin-top: 0.75rem; }

.settings-info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0.5rem; margin-top: 0.5rem; }

.yaml-editor { width: 100%; min-height: 250px; background: var(--bg0); border: 1px solid var(--border); border-radius: 6px; color: var(--text); font-family: var(--mono); font-size: 0.82rem; padding: 0.75rem; resize: vertical; line-height: 1.5; tab-size: 2; }
.yaml-editor:focus { outline: none; border-color: var(--cyan); }
.yaml-editor::placeholder { color: var(--muted); }

.wf-select { width: 100%; padding: 0.5rem 0.75rem; background: var(--bg0); border: 1px solid var(--border); border-radius: 6px; color: var(--text); font-size: 0.85rem; cursor: pointer; }
.wf-select:focus { outline: none; border-color: var(--cyan); }
.wf-select option { background: var(--bg1); color: var(--text); }

.btn { padding: 0.5rem 1.2rem; border-radius: 6px; font-size: 0.82rem; font-weight: 500; cursor: pointer; border: none; transition: all 0.15s; }
.btn-primary { background: var(--accent); color: #fff; }
.btn-primary:hover { background: var(--accent2); }
.btn-secondary { background: var(--bg3); color: var(--text2); border: 1px solid var(--border); }
.btn-secondary:hover { background: var(--border); color: var(--text); }

.toast { position: fixed; top: 60px; right: 1.5rem; padding: 0.6rem 1.2rem; border-radius: 8px; font-size: 0.82rem; font-weight: 500; z-index: 200; animation: slideIn 0.2s ease; }
.toast-success { background: rgba(52,211,153,0.15); color: var(--green); border: 1px solid rgba(52,211,153,0.3); }
.toast-error { background: rgba(248,113,113,0.15); color: var(--red); border: 1px solid rgba(248,113,113,0.3); }
@keyframes slideIn { from { transform: translateX(20px); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
`;
