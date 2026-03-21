"""
通知系统测试：环境变量展开、模板渲染、事件路由、webhook/command 后端、分发调度、配置校验
"""

from __future__ import annotations

import os
from unittest import mock
from unittest.mock import MagicMock, patch

from core.notify import (
    _matches_event,
    _send_command,
    _send_webhook,
    dispatch,
    expand_env_vars,
    render_template,
    validate_backends,
)


class TestExpandEnvVars:
    """环境变量展开"""

    def test_single_var(self):
        with mock.patch.dict(os.environ, {"MY_TOKEN": "abc123"}):
            assert expand_env_vars("Bearer ${MY_TOKEN}") == "Bearer abc123"

    def test_multiple_vars(self):
        with mock.patch.dict(os.environ, {"HOST": "example.com", "PORT": "8080"}):
            assert expand_env_vars("${HOST}:${PORT}") == "example.com:8080"

    def test_missing_var_keeps_original(self):
        env = {k: v for k, v in os.environ.items() if k != "NONEXISTENT_VAR_XYZ"}
        with mock.patch.dict(os.environ, env, clear=True):
            assert expand_env_vars("${NONEXISTENT_VAR_XYZ}") == "${NONEXISTENT_VAR_XYZ}"

    def test_no_vars(self):
        assert expand_env_vars("plain text") == "plain text"

    def test_empty_string(self):
        assert expand_env_vars("") == ""


class TestRenderTemplate:
    """模板渲染"""

    def test_variable_replacement(self):
        result = render_template("Hello {{name}}", {"name": "World"})
        assert result == "Hello World"

    def test_multiple_variables(self):
        result = render_template("{{a}} and {{b}}", {"a": "X", "b": "Y"})
        assert result == "X and Y"

    def test_missing_variable_becomes_empty(self):
        result = render_template("Hello {{name}}", {})
        assert result == "Hello "

    def test_conditional_block_with_value(self):
        result = render_template('cmd {{#flag}}--flag "{{flag}}"{{/flag}}', {"flag": "value"})
        assert result == 'cmd --flag "value"'

    def test_conditional_block_without_value(self):
        result = render_template('cmd {{#flag}}--flag "{{flag}}"{{/flag}}', {})
        assert result == "cmd "

    def test_conditional_block_empty_value(self):
        result = render_template('cmd {{#flag}}--flag "{{flag}}"{{/flag}}', {"flag": ""})
        assert result == "cmd "

    def test_multiple_conditional_blocks(self):
        template = "{{#a}}A={{a}}{{/a}} {{#b}}B={{b}}{{/b}}"
        result = render_template(template, {"a": "1", "b": ""})
        assert result == "A=1 "

    def test_nested_variable_in_block(self):
        template = '{{#media}}--media "{{media}}" --name "{{name}}"{{/media}}'
        result = render_template(template, {"media": "/path/to/file", "name": "doc.pdf"})
        assert result == '--media "/path/to/file" --name "doc.pdf"'


class TestMatchesEvent:
    """事件路由匹配"""

    def test_no_events_field_matches_all(self):
        assert _matches_event({}, "error") is True

    def test_wildcard_matches_all(self):
        assert _matches_event({"events": ["*"]}, "error") is True
        assert _matches_event({"events": ["*"]}, "info") is True

    def test_matching_event(self):
        assert _matches_event({"events": ["error", "success"]}, "error") is True

    def test_non_matching_event(self):
        assert _matches_event({"events": ["error"]}, "info") is False

    def test_empty_events_list(self):
        assert _matches_event({"events": []}, "error") is False

    def test_none_events(self):
        assert _matches_event({"events": None}, "error") is True


class TestSendWebhook:
    """webhook 后端"""

    @patch("core.notify.urllib.request.urlopen")
    def test_sends_request(self, mock_urlopen):
        mock_resp = MagicMock()
        mock_resp.status = 200
        mock_resp.__enter__ = MagicMock(return_value=mock_resp)
        mock_resp.__exit__ = MagicMock(return_value=False)
        mock_urlopen.return_value = mock_resp

        backend = {
            "name": "test",
            "type": "webhook",
            "url": "https://example.com/hook",
            "method": "POST",
            "headers": {"Content-Type": "application/json"},
            "body": '{"text": "{{message}}"}',
        }
        variables = {"message": "hello"}

        _send_webhook(backend, variables)

        mock_urlopen.assert_called_once()
        req = mock_urlopen.call_args[0][0]
        assert req.full_url == "https://example.com/hook"
        assert req.method == "POST"
        assert req.get_header("Content-type") == "application/json"
        assert req.data == b'{"text": "hello"}'

    @patch("core.notify.urllib.request.urlopen")
    def test_default_method_is_post(self, mock_urlopen):
        mock_resp = MagicMock()
        mock_resp.status = 200
        mock_resp.__enter__ = MagicMock(return_value=mock_resp)
        mock_resp.__exit__ = MagicMock(return_value=False)
        mock_urlopen.return_value = mock_resp

        backend = {"name": "test", "url": "https://example.com/hook", "body": "test"}
        _send_webhook(backend, {})

        req = mock_urlopen.call_args[0][0]
        assert req.method == "POST"

    @patch("core.notify.urllib.request.urlopen")
    def test_env_var_in_url(self, mock_urlopen):
        mock_resp = MagicMock()
        mock_resp.status = 200
        mock_resp.__enter__ = MagicMock(return_value=mock_resp)
        mock_resp.__exit__ = MagicMock(return_value=False)
        mock_urlopen.return_value = mock_resp

        with mock.patch.dict(os.environ, {"BOT_TOKEN": "secret123"}):
            backend = {"name": "test", "url": "https://api.example.com/bot${BOT_TOKEN}/send", "body": "{}"}
            _send_webhook(backend, {})

        req = mock_urlopen.call_args[0][0]
        assert "secret123" in req.full_url

    @patch("core.notify.urllib.request.urlopen", side_effect=Exception("connection error"))
    def test_failure_logged_not_raised(self, mock_urlopen):
        backend = {"name": "fail-test", "url": "https://example.com/hook", "body": "{}"}
        # Should not raise
        _send_webhook(backend, {})


class TestSendCommand:
    """command 后端"""

    @patch("core.notify.subprocess.run")
    def test_renders_and_executes(self, mock_run):
        mock_run.return_value = MagicMock(returncode=0)

        backend = {
            "name": "test-cmd",
            "command": 'echo "{{message}}" --target {{target}}',
        }
        variables = {"message": "hello", "target": "user123"}

        _send_command(backend, variables)

        mock_run.assert_called_once()
        cmd = mock_run.call_args[0][0]
        # shell=False 模式下，shlex.split 解析为列表 / In shell=False mode, shlex.split parses to list
        assert cmd == ["echo", "hello", "--target", "user123"]

    @patch("core.notify.subprocess.run")
    def test_conditional_block_in_command(self, mock_run):
        mock_run.return_value = MagicMock(returncode=0)

        backend = {
            "name": "test-cmd",
            "command": 'send --msg "{{message}}" {{#media_path}}--media "{{media_path}}"{{/media_path}}',
        }
        # Without media_path
        _send_command(backend, {"message": "hi", "media_path": ""})
        cmd = mock_run.call_args[0][0]
        assert "--media" not in cmd

        # With media_path
        _send_command(backend, {"message": "hi", "media_path": "/tmp/file.png"})
        cmd = mock_run.call_args[0][0]
        assert "/tmp/file.png" in cmd

    @patch("core.notify.subprocess.run")
    def test_failure_logged_not_raised(self, mock_run):
        mock_run.return_value = MagicMock(returncode=1, stderr="error output")

        backend = {"name": "fail-cmd", "command": "false"}
        # Should not raise
        _send_command(backend, {})

    @patch("core.notify.subprocess.run", side_effect=Exception("exec error"))
    def test_exception_logged_not_raised(self, mock_run):
        backend = {"name": "exc-cmd", "command": "bad_cmd"}
        # Should not raise
        _send_command(backend, {})


class TestDispatch:
    """分发调度"""

    def _make_task(self, **kwargs):
        base = {
            "id": "test-001",
            "title": "测试任务",
            "workflow": "dev",
            "status": "designing",
            "notify_target": "user123",
            "channel": "telegram",
        }
        base.update(kwargs)
        return base

    def _mock_registry(self, backends):
        """mock registry.get_workflow 返回带 notify_backends 的工作流"""
        wf = {"name": "dev", "notify_backends": backends} if backends is not None else {"name": "dev"}
        return patch("core.registry.get_workflow", return_value=wf)

    def test_no_backends_returns_false(self):
        with self._mock_registry(None):
            result = dispatch(self._make_task(), "test message", event="info")
        assert result is False

    def test_empty_backends_returns_false(self):
        with self._mock_registry([]):
            result = dispatch(self._make_task(), "test message", event="info")
        assert result is False

    def test_single_webhook_backend(self):
        backends = [{"name": "test", "type": "webhook", "url": "https://example.com/hook", "body": "{{message}}"}]
        with (
            self._mock_registry(backends),
            patch("core.notify._send_webhook") as mock_send,
        ):
            result = dispatch(self._make_task(), "hello", event="info")

        assert result is True
        mock_send.assert_called_once()
        variables = mock_send.call_args[0][1]
        assert variables["message"] == "hello"
        assert variables["task_id"] == "test-001"

    def test_multiple_backends(self):
        backends = [
            {"name": "wh", "type": "webhook", "url": "https://example.com", "body": "{}"},
            {"name": "cmd", "type": "command", "command": "echo {{message}}"},
        ]
        with (
            self._mock_registry(backends),
            patch("core.notify._send_webhook") as mock_wh,
            patch("core.notify._send_command") as mock_cmd,
        ):
            result = dispatch(self._make_task(), "test", event="error")

        assert result is True
        mock_wh.assert_called_once()
        mock_cmd.assert_called_once()

    def test_event_filtering(self):
        backends = [
            {"name": "error-only", "type": "webhook", "url": "https://example.com", "body": "{}", "events": ["error"]},
        ]
        with (
            self._mock_registry(backends),
            patch("core.notify._send_webhook") as mock_send,
        ):
            result = dispatch(self._make_task(), "info msg", event="info")

        assert result is False
        mock_send.assert_not_called()

    def test_error_isolation(self):
        """一个后端失败不影响其他后端"""
        backends = [
            {"name": "fail", "type": "webhook", "url": "https://example.com", "body": "{}"},
            {"name": "ok", "type": "command", "command": "echo ok"},
        ]
        with (
            self._mock_registry(backends),
            patch("core.notify._send_webhook", side_effect=Exception("boom")),
            patch("core.notify._send_command") as mock_cmd,
        ):
            result = dispatch(self._make_task(), "test", event="error")

        assert result is True
        mock_cmd.assert_called_once()

    def test_variables_populated(self):
        backends = [{"name": "test", "type": "command", "command": "echo"}]
        with (
            self._mock_registry(backends),
            patch("core.notify._send_command") as mock_cmd,
        ):
            dispatch(
                self._make_task(),
                "msg",
                event="success",
                media_path="/tmp/file.png",
                extra_vars={"custom": "val"},
            )

        variables = mock_cmd.call_args[0][1]
        assert variables["message"] == "msg"
        assert variables["event"] == "success"
        assert variables["media_path"] == "/tmp/file.png"
        assert variables["media_name"] == "file.png"
        assert variables["custom"] == "val"
        assert variables["workflow"] == "dev"
        assert variables["target"] == "user123"


class TestValidateBackends:
    """配置校验"""

    def test_valid_webhook(self):
        backends = [{"name": "test", "type": "webhook", "url": "https://example.com", "events": ["error"]}]
        errors, warnings = validate_backends(backends)
        assert errors == []
        assert warnings == []

    def test_valid_command(self):
        backends = [{"name": "test", "type": "command", "command": "echo hello", "events": ["*"]}]
        errors, warnings = validate_backends(backends)
        assert errors == []
        assert warnings == []

    def test_not_a_list(self):
        errors, warnings = validate_backends("not a list")
        assert len(errors) == 1
        assert "列表" in errors[0]

    def test_missing_type(self):
        backends = [{"name": "test", "url": "https://example.com"}]
        errors, warnings = validate_backends(backends)
        assert any("type" in e for e in errors)

    def test_invalid_type(self):
        backends = [{"name": "test", "type": "email"}]
        errors, warnings = validate_backends(backends)
        assert any("type 无效" in e for e in errors)

    def test_webhook_missing_url(self):
        backends = [{"name": "test", "type": "webhook"}]
        errors, warnings = validate_backends(backends)
        assert any("url" in e for e in errors)

    def test_command_missing_command(self):
        backends = [{"name": "test", "type": "command"}]
        errors, warnings = validate_backends(backends)
        assert any("command" in e for e in errors)

    def test_unknown_event_warning(self):
        backends = [{"name": "test", "type": "webhook", "url": "https://example.com", "events": ["unknown_event"]}]
        errors, warnings = validate_backends(backends)
        assert errors == []
        assert any("unknown_event" in w for w in warnings)

    def test_invalid_events_type(self):
        backends = [{"name": "test", "type": "webhook", "url": "https://example.com", "events": "error"}]
        errors, warnings = validate_backends(backends)
        assert any("events" in e and "列表" in e for e in errors)

    def test_backend_not_dict(self):
        backends = ["not a dict"]
        errors, warnings = validate_backends(backends)
        assert any("字典" in e for e in errors)

    def test_multiple_backends_mixed(self):
        backends = [
            {"name": "ok", "type": "webhook", "url": "https://example.com"},
            {"name": "bad", "type": "unknown_type"},
        ]
        errors, warnings = validate_backends(backends)
        assert len(errors) == 1  # Only the bad one
