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

        # 动态路由：/api/tasks/<id> 和 /api/tasks/<id>/logs
        if path.startswith("/api/tasks/") and path != "/api/tasks/":
            parts = path.split("/")
            if len(parts) == 4:
                # /api/tasks/<id>
                self._api_task_detail(parts[3])
                return
            if len(parts) == 5 and parts[4] == "logs":
                # /api/tasks/<id>/logs
                self._api_task_logs(parts[3])
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

        workflows = registry.list_workflows()
        self._send_json(workflows)

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
