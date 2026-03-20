"""WebUI HTTP 服务器：基于标准库 http.server，零外部依赖。
WebUI HTTP server: based on stdlib http.server, zero external dependencies."""

from __future__ import annotations

import json
from functools import partial
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import click

TEMPLATES_DIR = Path(__file__).parent / "templates"


class WebUIHandler(BaseHTTPRequestHandler):
    """处理 WebUI 的 HTTP 请求。
    Handle HTTP requests for the WebUI."""

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/") or "/"
        query = parse_qs(parsed.query)

        routes: dict[str, callable] = {
            "/": self._serve_index,
            "/api/tasks": partial(self._api_tasks, query),
            "/api/stats": self._api_stats,
            "/api/workflows": self._api_workflows,
        }

        # 动态路由 / Dynamic routes
        if path.startswith("/api/tasks/") and path != "/api/tasks/":
            parts = path.split("/")
            if len(parts) == 4:
                self._api_task_detail(parts[3])
                return
            if len(parts) == 5 and parts[4] == "logs":
                self._api_task_logs(parts[3])
                return
        if path.startswith("/api/workflows/") and path != "/api/workflows/":
            parts = path.split("/")
            if len(parts) == 5 and parts[4] == "graph":
                # /api/workflows/<name>/graph
                self._api_workflow_graph(parts[3])
                return

        handler = routes.get(path)
        if handler:
            handler()
        else:
            self._send_json({"error": "Not Found"}, status=404)

    def _serve_index(self) -> None:
        index_path = TEMPLATES_DIR / "index.html"
        content = index_path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    def _api_tasks(self, query: dict) -> None:
        from core import db

        status = query.get("status", [None])[0]
        workflow = query.get("workflow", [None])[0]
        limit_str = query.get("limit", ["50"])[0]
        try:
            limit = int(limit_str)
        except (ValueError, TypeError):
            limit = 50
        tasks = db.list_tasks(status=status, workflow=workflow, limit=limit)
        self._send_json(tasks)

    def _api_task_detail(self, task_id: str) -> None:
        from core import db

        task = db.get_task(task_id)
        if task is None:
            self._send_json({"error": "Task not found"}, status=404)
        else:
            self._send_json(task)

    def _api_task_logs(self, task_id: str) -> None:
        from core import db

        logs = db.get_task_logs(task_id)
        self._send_json(logs)

    def _api_stats(self) -> None:
        from core import db

        stats = db.get_task_stats()
        self._send_json(stats)

    def _api_workflows(self) -> None:
        from core import registry

        result = []
        for wf_info in registry.list_workflows():
            wf = registry.get_workflow(wf_info["name"])
            phases = []
            if wf:
                for p in wf.get("phases", []):
                    if "parallel" in p:
                        par = p["parallel"]
                        phases.append(f"[parallel] {par['name']}")
                        for sub in par.get("phases", []):
                            phases.append(f"  {sub['name']}")
                    else:
                        phases.append(p["name"])
            result.append({**wf_info, "phases": phases})
        self._send_json(result)

    def _api_workflow_graph(self, workflow_name: str) -> None:
        from core import registry

        wf = registry.get_workflow(workflow_name)
        if not wf:
            self._send_json({"error": "Workflow not found"}, status=404)
            return

        transitions = registry.build_transitions(workflow_name)
        all_states = registry.get_all_states(workflow_name)
        terminal_states = registry.get_terminal_states(workflow_name)
        initial_state = wf.get("initial_state", "")

        # 构建 edges 列表 / Build edges list
        edges = []
        for from_state, trans_list in transitions.items():
            for trigger, to_state in trans_list:
                edges.append({"from": from_state, "to": to_state, "trigger": trigger})

        # 补充 edges 中出现但不在 all_states 的状态
        edge_states = set()
        for e in edges:
            edge_states.add(e["from"])
            edge_states.add(e["to"])
        all_states_set = set(all_states)
        for s in edge_states:
            if s not in all_states_set:
                all_states.append(s)

        # 节点分类 / Classify nodes
        nodes = []
        for s in all_states:
            node_type = "normal"
            if s == initial_state:
                node_type = "initial"
            elif s in terminal_states:
                node_type = "terminal"
            elif "pending" in s:
                node_type = "pending"
            elif "running" in s:
                node_type = "running"
            elif "rejected" in s:
                node_type = "rejected"
            elif "waiting" in s:
                node_type = "waiting"
            nodes.append({"id": s, "type": node_type})

        self._send_json({
            "name": workflow_name,
            "initial_state": initial_state,
            "terminal_states": terminal_states,
            "nodes": nodes,
            "edges": edges,
        })

    def _send_json(self, data: object, *, status: int = 200) -> None:
        body = json.dumps(data, ensure_ascii=False, default=str).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args: object) -> None:  # noqa: A002
        click.echo(f"[webui] {args[0]} {args[1]} {args[2]}")


@click.command("webui")
@click.option("--host", default="127.0.0.1", help="绑定地址 / Bind address")
@click.option("--port", default=8080, type=int, help="端口号 / Port number")
def webui_cmd(host: str, port: int) -> None:
    """启动 WebUI 管理界面 / Start the WebUI management interface."""
    from core import db

    db.init_db()

    # 触发工作流发现 / Trigger workflow discovery
    try:
        import core.workflows  # noqa: F401
    except Exception:
        pass

    server = ThreadingHTTPServer((host, port), WebUIHandler)
    click.echo(f"WebUI 启动：http://{host}:{port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        click.echo("\nWebUI 已停止")
        server.shutdown()
