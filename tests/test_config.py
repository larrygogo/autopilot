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
        cfg_file.write_text("my_key: my_value\n", encoding="utf-8")

        with mock.patch.dict(os.environ, {"DEV_WORKFLOW_CONFIG": str(cfg_file)}):
            config = load_config()
        assert config.get("my_key") == "my_value"

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
        cfg_file.write_text("timeout: 600\nretries: 3\n", encoding="utf-8")

        with mock.patch.dict(os.environ, {"DEV_WORKFLOW_CONFIG": str(cfg_file)}):
            config = load_config()
        assert config["timeout"] == 600
        assert config["retries"] == 3


class TestValidateConfig:
    """配置校验"""

    def test_empty_config_passes(self):
        """空配置通过校验"""
        errors, warnings = validate_config({})
        assert errors == []
        assert warnings == []

    def test_unknown_keys_produce_warnings(self):
        """框架 schema 为空，所有 key 产生 warning"""
        config = {"some_key": "value", "another": 123}
        errors, warnings = validate_config(config)
        assert errors == []
        assert len(warnings) == 2

    def test_non_dict_config_error(self):
        """非 dict 配置产生 error"""
        errors, warnings = validate_config("not a dict")
        assert len(errors) == 1
        assert warnings == []
