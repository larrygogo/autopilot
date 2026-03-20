"""
工作流包：触发用户工作流发现
"""

from core.plugin import discover as discover_plugins
from core.registry import discover

discover()
discover_plugins()
