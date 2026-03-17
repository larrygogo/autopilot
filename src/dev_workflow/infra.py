"""
基础设施层：从 runner.py 提取的公共工具函数
包含 git 操作、Claude CLI 调用、通知、锁机制、需求拉取等
"""
from __future__ import annotations

import json, subprocess, sys, os, tempfile
from pathlib import Path
from typing import IO

from dev_workflow.db import WORKSPACE, CONFIG
from dev_workflow.logger import get_logger

log = get_logger()

# ──────────────────────────────────────────────────────────
# 路径常量
# ──────────────────────────────────────────────────────────

PROMPTS_DIR = Path(__file__).parent.parent.parent / 'prompts'
DEVTASKS_DIR = WORKSPACE / 'runtime/dev-tasks'
PROJECTS_DIR = WORKSPACE / 'runtime/projects'

# ──────────────────────────────────────────────────────────
# ReqGenie 配置（config.yaml > 环境变量 > 默认值）
# ──────────────────────────────────────────────────────────

_rq_cfg = CONFIG.get('reqgenie', {})
REQGENIE_BASE_URL = os.environ.get('REQGENIE_BASE_URL') or _rq_cfg.get('base_url', 'https://reqgenie.reverse-game.ltd')
REQGENIE_MCP_URL = f'{REQGENIE_BASE_URL}/mcp'
REQGENIE_REQ_URL = f'{REQGENIE_BASE_URL}/requirements'
OP_VAULT = os.environ.get('OP_VAULT') or _rq_cfg.get('op_vault', 'openclaw')
OP_REQGENIE_ITEM = os.environ.get('OP_REQGENIE_ITEM') or _rq_cfg.get('op_item', 'reqgenie 需求系统')

# ──────────────────────────────────────────────────────────
# 通知配置
# ──────────────────────────────────────────────────────────

_notify_cfg = CONFIG.get('notify', {})
DEFAULT_NOTIFY_CHANNEL = _notify_cfg.get('channel', 'telegram')
DEFAULT_NOTIFY_TARGET = _notify_cfg.get('target', '')

# ──────────────────────────────────────────────────────────
# 超时配置（config.yaml > 默认值）
# ──────────────────────────────────────────────────────────

_timeout_cfg = CONFIG.get('timeouts', {})
TIMEOUT_DESIGN = _timeout_cfg.get('design', 900)
TIMEOUT_REVIEW = _timeout_cfg.get('review', 900)
TIMEOUT_DEV = _timeout_cfg.get('development', 1800)
TIMEOUT_CODE_REVIEW = _timeout_cfg.get('code_review', 1200)
TIMEOUT_PR_DESC = _timeout_cfg.get('pr_description', 300)

# 评审结果常量
REVIEW_RESULT_PASS = 'REVIEW_RESULT: PASS'
REVIEW_RESULT_REJECT = 'REVIEW_RESULT: REJECT'

# ──────────────────────────────────────────────────────────
# Git 操作
# ──────────────────────────────────────────────────────────

def _run_git(args: list[str], cwd: str, check: bool = True) -> subprocess.CompletedProcess:
    """执行 git 命令，失败时抛出有意义的异常"""
    cmd_str = ' '.join(['git'] + args)
    log.debug('执行: %s (cwd=%s)', cmd_str, cwd)
    r = subprocess.run(['git'] + args, capture_output=True, text=True, cwd=cwd, encoding='utf-8', errors='replace')
    if check and r.returncode != 0:
        raise RuntimeError(f'git 命令失败：{cmd_str}\nstderr: {r.stderr.strip()}')
    return r

# ──────────────────────────────────────────────────────────
# 锁机制（跨平台：fcntl.flock on Unix / msvcrt.locking on Windows）
# ──────────────────────────────────────────────────────────

_IS_WINDOWS = sys.platform == 'win32'
if _IS_WINDOWS:
    import msvcrt
    _LOCK_DIR = Path(tempfile.gettempdir())
else:
    import fcntl
    _LOCK_DIR = Path('/tmp')

_lock_fds = {}  # task_id -> fd，持有引用防止 GC


def _lock_path(task_id: str) -> str:
    return str(_LOCK_DIR / f'wf_task_{task_id}.lock')


def is_locked(task_id: str) -> bool:
    """检查任务是否已有进程持有锁（非阻塞尝试）"""
    path = _lock_path(task_id)
    try:
        fd = open(path, 'w')
        if _IS_WINDOWS:
            msvcrt.locking(fd.fileno(), msvcrt.LK_NBLCK, 1)
            msvcrt.locking(fd.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            fcntl.flock(fd, fcntl.LOCK_UN)
        fd.close()
        return False
    except (BlockingIOError, OSError):
        return True
    except Exception:
        return False


def acquire_lock(task_id: str) -> IO | None:
    """原子获取锁，成功返回 fd，失败返回 None"""
    path = _lock_path(task_id)
    try:
        fd = open(path, 'w')
        if _IS_WINDOWS:
            msvcrt.locking(fd.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        fd.write(str(os.getpid()))
        fd.flush()
        _lock_fds[task_id] = fd  # 持有引用
        return fd
    except (BlockingIOError, OSError):
        fd.close()
        return None


def release_lock(task_id: str) -> None:
    """释放锁"""
    fd = _lock_fds.pop(task_id, None)
    if fd:
        try:
            if _IS_WINDOWS:
                msvcrt.locking(fd.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(fd, fcntl.LOCK_UN)
            fd.close()
        except Exception:
            pass

# ──────────────────────────────────────────────────────────
# 通知
# ──────────────────────────────────────────────────────────

def notify(task: dict, message: str, media_path: str | None = None) -> None:
    target = task.get('notify_target', '')
    channel = task.get('channel', 'telegram')
    try:
        subprocess.run(['openclaw', 'message', 'send',
            '--channel', channel, '--target', target, '--message', message], check=False)
        if media_path and Path(media_path).exists():
            subprocess.run(['openclaw', 'message', 'send',
                '--channel', channel, '--target', target,
                '--media', media_path,
                '--message', Path(media_path).name], check=False)
    except FileNotFoundError:
        log.warning('openclaw 未安装，通知跳过：%s', message[:80])

# ──────────────────────────────────────────────────────────
# Agent 执行
# ──────────────────────────────────────────────────────────

def run_claude(prompt: str, repo_path: str | None = None, timeout: int = 900) -> str:
    log.info('调用 Claude CLI (timeout=%ds, cwd=%s)', timeout, repo_path or 'None')
    try:
        r = subprocess.run(
            ['claude', '--permission-mode', 'bypassPermissions', '--print', prompt],
            capture_output=True, text=True, timeout=timeout,
            cwd=repo_path if repo_path and Path(repo_path).exists() else None,
            encoding='utf-8', errors='replace'
        )
    except subprocess.TimeoutExpired:
        raise RuntimeError(f'Claude CLI 超时（{timeout}s），prompt 长度 {len(prompt)} 字符')
    if r.returncode != 0:
        raise RuntimeError(f'Claude CLI 失败: {r.stderr[:500]}')
    return r.stdout.strip()

def get_task_dir(task_id: str) -> Path:
    d = DEVTASKS_DIR / task_id
    d.mkdir(parents=True, exist_ok=True)
    return d

# ──────────────────────────────────────────────────────────
# 工具：实时拉取需求
# ──────────────────────────────────────────────────────────

def fetch_req(req_id: str) -> dict | None:
    try:
        key_r = subprocess.run(
            ['op', 'item', 'get', OP_REQGENIE_ITEM, '--vault', OP_VAULT, '--fields', 'label=api_key'],
            capture_output=True, text=True)
    except FileNotFoundError:
        log.warning('op CLI 未安装，跳过 ReqGenie')
        return None
    if key_r.returncode != 0:
        return None
    key = key_r.stdout.strip()
    cfg = {'mcpServers': {'reqgenie': {
        'baseUrl': REQGENIE_MCP_URL,
        'headers': {'Authorization': f'Bearer {key}'}
    }}}
    with tempfile.TemporaryDirectory() as tmpdir:
        cfg_path = os.path.join(tmpdir, 'config.json')
        out_path = os.path.join(tmpdir, 'result.json')
        with open(cfg_path, 'w') as f:
            json.dump(cfg, f)
        r = subprocess.run(
            f'mcporter --config {cfg_path} call reqgenie.get_requirement id={req_id} --output json > {out_path}',
            shell=True, timeout=60)
        if r.returncode == 0 and Path(out_path).exists():
            data = json.loads(Path(out_path).read_text(encoding='utf-8'))
            return data.get('data', data) if 'id' not in data else data
    return None
