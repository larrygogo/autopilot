"""
配置加载与校验测试：env var 优先级、文件缺失、空 YAML、schema 校验
"""

import os
from pathlib import Path
from unittest import mock

from core.config import load_config, validate_config


class TestLoadConfig:
    """配置加载"""

    def test_env_var_priority(self, tmp_path):
        """环境变量指定的配置文件优先"""
        cfg_file = tmp_path / "env_config.yaml"
        cfg_file.write_text("default_branch: develop\n", encoding="utf-8")

        with mock.patch.dict(os.environ, {"DEV_WORKFLOW_CONFIG": str(cfg_file)}):
            config = load_config()
        assert config.get("default_branch") == "develop"

    def test_missing_file_returns_empty(self):
        """所有配置文件都不存在时返回空 dict"""
        with (
            mock.patch.dict(os.environ, {"DEV_WORKFLOW_CONFIG": "/nonexistent/config.yaml"}),
            mock.patch("core.config.AUTOPILOT_HOME", Path("/nonexistent/autopilot")),
        ):
            config = load_config()
        assert config == {}

    def test_empty_yaml_returns_empty(self, tmp_path):
        """空 YAML 文件返回空 dict"""
        cfg_file = tmp_path / "empty.yaml"
        cfg_file.write_text("", encoding="utf-8")

        with mock.patch.dict(os.environ, {"DEV_WORKFLOW_CONFIG": str(cfg_file)}):
            config = load_config()
        assert config == {}

    def test_valid_config_loads_values(self, tmp_path):
        """有效配置加载所有值"""
        cfg_file = tmp_path / "valid.yaml"
        cfg_file.write_text("default_branch: main\ntimeouts:\n  design: 600\n", encoding="utf-8")

        with mock.patch.dict(os.environ, {"DEV_WORKFLOW_CONFIG": str(cfg_file)}):
            config = load_config()
        assert config["default_branch"] == "main"
        assert config["timeouts"]["design"] == 600


class TestValidateConfig:
    """配置校验"""

    def test_valid_config_no_errors(self):
        """有效配置无 errors 和 warnings"""
        config = {"default_branch": "main"}
        errors, warnings = validate_config(config)
        assert errors == []
        assert warnings == []

    def test_unknown_key_warning(self):
        """未知配置项产生 warning"""
        config = {"default_branch": "main", "unknown_key": "value"}
        errors, warnings = validate_config(config)
        assert errors == []
        assert len(warnings) == 1
        assert "unknown_key" in warnings[0]

    def test_wrong_type_error(self):
        """类型错误产生 error"""
        config = {"default_branch": 123}
        errors, warnings = validate_config(config)
        assert len(errors) == 1
        assert "default_branch" in errors[0]
        assert warnings == []

    def test_workflow_config_treated_as_unknown(self):
        """工作流专属配置项产生 warning（框架不校验）"""
        config = {"default_branch": "main", "timeouts": {"design": 600}}
        errors, warnings = validate_config(config)
        assert errors == []
        assert len(warnings) == 1
        assert "timeouts" in warnings[0]

    def test_empty_config_passes(self):
        """空配置通过校验"""
        errors, warnings = validate_config({})
        assert errors == []
        assert warnings == []

    def test_non_dict_config_error(self):
        """非 dict 配置产生 error"""
        errors, warnings = validate_config("not a dict")
        assert len(errors) == 1
        assert warnings == []
