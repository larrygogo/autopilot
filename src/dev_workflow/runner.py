"""
Runner：启动各阶段 agent，完成后触发下一个状态转换（push 模型）
"""
import json, subprocess, sys, os, fcntl, re, time
from pathlib import Path
from datetime import datetime, timezone

from dev_workflow.db import get_task, get_conn, now, WORKSPACE, CONFIG
from dev_workflow.state_machine import transition, InvalidTransitionError

# 路径（基于 WORKSPACE）
PROMPTS_DIR = Path(__file__).parent.parent.parent / 'prompts'
DEVTASKS_DIR = WORKSPACE / 'runtime/dev-tasks'
PROJECTS_DIR = WORKSPACE / 'runtime/projects'

# ReqGenie 配置（config.yaml > 环境变量 > 默认值）
_rq_cfg = CONFIG.get('reqgenie', {})
REQGENIE_BASE_URL = os.environ.get('REQGENIE_BASE_URL') or _rq_cfg.get('base_url', 'https://reqgenie.reverse-game.ltd')
REQGENIE_MCP_URL = f'{REQGENIE_BASE_URL}/mcp'
REQGENIE_REQ_URL = f'{REQGENIE_BASE_URL}/requirements'
OP_VAULT = os.environ.get('OP_VAULT') or _rq_cfg.get('op_vault', 'openclaw')
OP_REQGENIE_ITEM = os.environ.get('OP_REQGENIE_ITEM') or _rq_cfg.get('op_item', 'reqgenie 需求系统')

# 通知配置
_notify_cfg = CONFIG.get('notify', {})
DEFAULT_NOTIFY_CHANNEL = _notify_cfg.get('channel', 'telegram')
DEFAULT_NOTIFY_TARGET = _notify_cfg.get('target', '')

REVIEW_RESULT_PASS = 'REVIEW_RESULT: PASS'
REVIEW_RESULT_REJECT = 'REVIEW_RESULT: REJECT'

# ──────────────────────────────────────────────────────────
# 锁机制（fcntl.flock，原子操作，进程退出自动释放）
# ──────────────────────────────────────────────────────────

_lock_fds = {}  # task_id -> fd，持有引用防止 GC

def is_locked(task_id):
    """检查任务是否已有进程持有锁（非阻塞尝试）"""
    lock_path = f'/tmp/wf_task_{task_id}.lock'
    try:
        fd = open(lock_path, 'w')
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        # 能拿到锁说明没有其他进程持有
        fcntl.flock(fd, fcntl.LOCK_UN)
        fd.close()
        return False
    except BlockingIOError:
        return True
    except Exception:
        return False

def acquire_lock(task_id):
    """原子获取锁，成功返回 fd，失败返回 None"""
    lock_path = f'/tmp/wf_task_{task_id}.lock'
    try:
        fd = open(lock_path, 'w')
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        fd.write(str(os.getpid()))
        fd.flush()
        _lock_fds[task_id] = fd  # 持有引用
        return fd
    except BlockingIOError:
        fd.close()
        return None

def release_lock(task_id):
    """释放锁"""
    fd = _lock_fds.pop(task_id, None)
    if fd:
        try:
            fcntl.flock(fd, fcntl.LOCK_UN)
            fd.close()
        except Exception:
            pass

# ──────────────────────────────────────────────────────────
# 通知
# ──────────────────────────────────────────────────────────

def notify(task, message, media_path=None):
    target = task.get('notify_target', '')
    channel = task.get('channel', 'telegram')
    subprocess.run(['openclaw', 'message', 'send',
        '--channel', channel, '--target', target, '--message', message], check=False)
    if media_path and Path(media_path).exists():
        subprocess.run(['openclaw', 'message', 'send',
            '--channel', channel, '--target', target,
            '--media', media_path,
            '--message', Path(media_path).name], check=False)

# ──────────────────────────────────────────────────────────
# Agent 执行
# ──────────────────────────────────────────────────────────

def run_claude(prompt, repo_path=None, timeout=900):
    r = subprocess.run(
        ['claude', '--permission-mode', 'bypassPermissions', '--print', prompt],
        capture_output=True, text=True, timeout=timeout,
        cwd=repo_path if repo_path and Path(repo_path).exists() else None
    )
    if r.returncode != 0:
        raise RuntimeError(f'claude failed: {r.stderr[:500]}')
    return r.stdout.strip()

def get_task_dir(task_id):
    d = DEVTASKS_DIR / task_id
    d.mkdir(parents=True, exist_ok=True)
    return d

# ──────────────────────────────────────────────────────────
# 工具：实时拉取需求
# ──────────────────────────────────────────────────────────

def fetch_req(req_id):
    import tempfile
    key_r = subprocess.run(
        ['op', 'item', 'get', OP_REQGENIE_ITEM, '--vault', OP_VAULT, '--fields', 'label=api_key'],
        capture_output=True, text=True)
    if key_r.returncode != 0:
        return None
    key = key_r.stdout.strip()
    cfg = {'mcpServers': {'reqgenie': {
        'baseUrl': REQGENIE_MCP_URL,
        'headers': {'Authorization': f'Bearer {key}'}
    }}}
    # 用 TemporaryDirectory，退出上下文（含异常）时整个目录自动删除
    with tempfile.TemporaryDirectory() as tmpdir:
        cfg_path = os.path.join(tmpdir, 'config.json')
        out_path = os.path.join(tmpdir, 'result.json')
        with open(cfg_path, 'w') as f:
            json.dump(cfg, f)
        r = subprocess.run(
            f'mcporter --config {cfg_path} call reqgenie.get_requirement id={req_id} --output json > {out_path}',
            shell=True, timeout=60)
        if r.returncode == 0 and Path(out_path).exists():
            data = json.loads(Path(out_path).read_text())
            return data.get('data', data) if 'id' not in data else data
    return None

# ──────────────────────────────────────────────────────────
# 各阶段执行函数
# ──────────────────────────────────────────────────────────

def run_plan_design(task_id):
    """方案设计"""
    task = get_task(task_id)
    task_dir = get_task_dir(task_id)
    repo_path = task['repo_path']

    # 更新仓库
    subprocess.run(['git', 'checkout', 'master'], capture_output=True, cwd=repo_path)
    subprocess.run(['git', 'pull', '--ff-only'], capture_output=True, cwd=repo_path)

    # 读取需求
    req = fetch_req(task['req_id'])
    if not req:
        raise RuntimeError('无法拉取需求详情')

    # 读取历史驳回的评审报告（如有）
    rejection_history = ''
    review_path = task_dir / 'plan_review.md'
    if review_path.exists() and task['rejection_count'] > 0:
        rejection_history = f'\n## 上一次评审的驳回意见（第{task["rejection_count"]}次驳回）\n{review_path.read_text()}'

    # 拼装提示词
    template = (PROMPTS_DIR / 'plan-design.md').read_text()
    description = req.get('description', '')
    org = req.get('organized_content') or {}
    acceptance = '\n'.join(org.get('acceptance_criteria', []))

    knowledge = ''
    knowledge_path = PROJECTS_DIR / task['project'] / 'knowledge.md'
    if knowledge_path.exists():
        knowledge = knowledge_path.read_text()

    prompt = template
    for k, v in {
        '{{project}}': task['project'],
        '{{tech_stack}}': 'Rust (backend) + TypeScript/React (frontend) + PostgreSQL',
        '{{repo_path}}': repo_path,
        '{{title}}': task['title'],
        '{{url}}': f'{REQGENIE_REQ_URL}/{task["req_id"]}',
        '{{description}}': description,
        '{{acceptance_criteria}}': acceptance,
    }.items():
        prompt = prompt.replace(k, v)
    prompt = prompt.replace('{{#knowledge}}\n项目知识库：\n{{knowledge}}\n{{/knowledge}}',
                            f'项目知识库：\n{knowledge}' if knowledge else '')
    if rejection_history:
        prompt += rejection_history

    result = run_claude(prompt, repo_path, timeout=900)

    # 保存方案
    plan_path = task_dir / 'plan.md'
    plan_path.write_text(f'<!-- generated:{now()} -->\n{result}')

    # 状态转换
    transition(task_id, 'design_complete', note='方案设计完成')
    notify(task, f'📋 方案设计完成：《{task["title"]}》\n\n等待方案评审...', str(plan_path))


def run_plan_review(task_id):
    """方案评审"""
    task = get_task(task_id)
    task_dir = get_task_dir(task_id)
    repo_path = task['repo_path']

    plan_content = (task_dir / 'plan.md').read_text()
    template = (PROMPTS_DIR / 'plan-review.md').read_text()
    prompt = template.replace('{{title}}', task['title'])
    prompt = prompt.replace('{{url}}', f'{REQGENIE_REQ_URL}/{task["req_id"]}')
    prompt = prompt.replace('{{plan_content}}', plan_content)

    result = run_claude(prompt, repo_path, timeout=900)

    # 保存评审报告
    review_path = task_dir / 'plan_review.md'
    review_path.write_text(f'<!-- generated:{now()} -->\n{result}')

    # 解析结论
    passed = REVIEW_RESULT_PASS in result
    rejected = REVIEW_RESULT_REJECT in result

    if passed:
        transition(task_id, 'review_pass', note='方案评审通过')
        notify(task, f'✅ 方案评审通过：《{task["title"]}》\n\n开始开发...', str(review_path))
        # Push：直接启动开发
        run_in_background(task_id, 'dev')

    elif rejected:
        reason_match = re.search(r'## 驳回理由\n(.*?)(?=\n## |\Z)', result, re.DOTALL)
        reason = reason_match.group(1).strip() if reason_match else '请查看评审报告'
        new_count = task['rejection_count'] + 1

        if new_count >= 10:
            transition(task_id, 'cancel',
                note=f'方案评审驳回 {new_count} 次，已取消',
                extra_updates={'rejection_count': new_count, 'rejection_reason': reason})
            notify(task, f'⚠️ 方案评审驳回 {new_count} 次：《{task["title"]}》\n\n已超过上限，任务取消。', str(review_path))
        else:
            transition(task_id, 'review_reject',
                note=f'方案评审驳回（第{new_count}次）',
                extra_updates={'rejection_count': new_count, 'rejection_reason': reason})
            notify(task, f'❌ 方案评审驳回（第{new_count}次）：《{task["title"]}》\n\n自动重新设计...', str(review_path))
            # Push：自动重新设计
            run_in_background(task_id, 'design')
    else:
        raise RuntimeError(f'无法解析评审结论，请检查报告')


def run_development(task_id):
    """开发执行"""
    task = get_task(task_id)
    task_dir = get_task_dir(task_id)
    repo_path = task['repo_path']
    branch = task['branch']

    # 切换分支
    subprocess.run(['git', 'checkout', 'master'], capture_output=True, cwd=repo_path)
    subprocess.run(['git', 'pull', '--ff-only'], capture_output=True, cwd=repo_path)
    r = subprocess.run(['git', 'checkout', '-b', branch], capture_output=True, cwd=repo_path)
    if r.returncode != 0:
        subprocess.run(['git', 'checkout', branch], capture_output=True, cwd=repo_path)

    plan_content = (task_dir / 'plan.md').read_text()
    template = (PROMPTS_DIR / 'development.md').read_text()
    prompt = template
    for k, v in {
        '{{project}}': task['project'],
        '{{repo_path}}': repo_path,
        '{{branch}}': branch,
        '{{title}}': task['title'],
        '{{url}}': f'{REQGENIE_REQ_URL}/{task["req_id"]}',
        '{{plan_content}}': plan_content,
    }.items():
        prompt = prompt.replace(k, v)
    prompt = prompt.replace('{{#knowledge}}\n项目知识库：\n{{knowledge}}\n{{/knowledge}}', '')

    result = run_claude(prompt, repo_path, timeout=1800)

    report_path = task_dir / 'dev_report.md'
    report_path.write_text(f'<!-- generated:{now()} -->\n{result}')

    transition(task_id, 'dev_complete', note='开发完成')
    notify(task, f'🔨 开发完成：《{task["title"]}》\n\n启动代码审查...', str(report_path))

    # Push：直接启动代码审查
    run_in_background(task_id, 'code_review')


def run_code_review(task_id):
    """代码审查"""
    task = get_task(task_id)
    task_dir = get_task_dir(task_id)
    repo_path = task['repo_path']
    branch = task['branch']

    # 获取 diff
    r = subprocess.run(['git', 'diff', 'master...HEAD', '--no-ext-diff'],
                       capture_output=True, text=True, cwd=repo_path)
    git_diff = r.stdout[:80000]

    plan_content = (task_dir / 'plan.md').read_text()
    template = (PROMPTS_DIR / 'code-review.md').read_text()
    prompt = template
    for k, v in {
        '{{title}}': task['title'],
        '{{url}}': f'{REQGENIE_REQ_URL}/{task["req_id"]}',
        '{{plan_content}}': plan_content,
        '{{git_diff}}': git_diff,
    }.items():
        prompt = prompt.replace(k, v)
    prompt = re.sub(r'{{#screenshots}}.*?{{/screenshots}}', '', prompt, flags=re.DOTALL)

    result = run_claude(prompt, repo_path, timeout=1200)

    review_path = task_dir / 'code_review_report.md'
    review_path.write_text(f'<!-- generated:{now()} -->\n{result}')

    passed = REVIEW_RESULT_PASS in result
    rejected = REVIEW_RESULT_REJECT in result

    if passed:
        transition(task_id, 'code_pass', note='代码审查通过')
        notify(task, f'✅ 代码审查通过：《{task["title"]}》\n\n提交 PR...', str(review_path))
        run_in_background(task_id, 'pr')

    elif rejected:
        reason_match = re.search(r'## 不通过理由\n(.*?)(?=\n## |\Z)', result, re.DOTALL)
        reason = reason_match.group(1).strip() if reason_match else '请查看审查报告'
        new_count = task['code_rejection_count'] + 1

        if new_count >= 10:
            transition(task_id, 'cancel',
                note=f'代码审查驳回 {new_count} 次，已取消',
                extra_updates={'code_rejection_count': new_count, 'rejection_reason': reason})
            notify(task, f'⚠️ 代码审查驳回 {new_count} 次：《{task["title"]}》\n\n已超过上限，任务取消。', str(review_path))
        else:
            transition(task_id, 'code_reject',
                note=f'代码审查驳回（第{new_count}次）',
                extra_updates={'code_rejection_count': new_count, 'rejection_reason': reason})
            notify(task, f'❌ 代码审查驳回（第{new_count}次）：《{task["title"]}》\n\n自动返工...', str(review_path))
            run_in_background(task_id, 'dev')
    else:
        raise RuntimeError('无法解析审查结论，请检查报告')


def run_submit_pr(task_id):
    """提交 PR"""
    task = get_task(task_id)
    task_dir = get_task_dir(task_id)
    repo_path = task['repo_path']
    branch = task['branch']

    # push 分支
    subprocess.run(['git', 'push', '-u', 'origin', branch],
                   capture_output=True, text=True, cwd=repo_path)

    # 生成 PR 描述（调 claude）
    plan_content = (task_dir / 'plan.md').read_text() if (task_dir / 'plan.md').exists() else ''
    dev_report = (task_dir / 'dev_report.md').read_text() if (task_dir / 'dev_report.md').exists() else ''
    diff_r = subprocess.run(['git', 'diff', 'master...HEAD', '--stat'],
                            capture_output=True, text=True, cwd=repo_path)
    git_diff = diff_r.stdout[:3000]

    template = (PROMPTS_DIR / 'pr-description.md').read_text()
    prompt = template.replace('{{title}}', task['title'])
    prompt = prompt.replace('{{url}}', f'{REQGENIE_REQ_URL}/{task["req_id"]}')
    prompt = prompt.replace('{{plan_content}}', plan_content[:4000])
    prompt = prompt.replace('{{dev_report}}', dev_report[:2000])
    prompt = prompt.replace('{{git_diff}}', git_diff)

    # 判断有无前端改动
    name_r = subprocess.run(['git', 'diff', 'master...HEAD', '--name-only'],
                            capture_output=True, text=True, cwd=repo_path)
    has_frontend = any(f.endswith(('.tsx', '.ts', '.css', '.html'))
                       for f in name_r.stdout.split('\n'))
    if has_frontend:
        prompt = prompt.replace('{{#has_frontend}}\n', '').replace('\n{{/has_frontend}}', '')
        prompt = re.sub(r'{{.has_frontend}}.*?{{/has_frontend}}', '', prompt, flags=re.DOTALL)
    else:
        prompt = re.sub(r'{{#has_frontend}}.*?{{/has_frontend}}', '', prompt, flags=re.DOTALL)
        prompt = prompt.replace('{{^has_frontend}}\n（无前端视觉改动）\n{{/has_frontend}}', '（无前端视觉改动）')

    pr_body = subprocess.run(
        ['claude', '--permission-mode', 'bypassPermissions', '--print', prompt],
        capture_output=True, text=True, timeout=300, cwd=repo_path
    )
    body = pr_body.stdout.strip() if pr_body.returncode == 0 else f'完成需求：{task["title"]}'

    # 检查是否已有 PR
    existing = subprocess.run(['gh', 'pr', 'view', '--json', 'url'],
                              capture_output=True, text=True, cwd=repo_path)
    if existing.returncode == 0:
        pr_url = json.loads(existing.stdout).get('url', '')
        subprocess.run(['gh', 'pr', 'edit', '--body', body],
                       capture_output=True, cwd=repo_path)
    else:
        r = subprocess.run(
            ['gh', 'pr', 'create', '--title', task['title'], '--body', body,
             '--base', 'master', '--head', branch],
            capture_output=True, text=True, cwd=repo_path
        )
        if r.returncode != 0:
            raise RuntimeError(f'创建 PR 失败：{r.stderr}')
        pr_url = r.stdout.strip()

    with get_conn() as conn:
        conn.execute('UPDATE tasks SET pr_url = ?, updated_at = ? WHERE id = ?',
                     (pr_url, now(), task_id))

    notify(task, f'🎉 PR 已提交：《{task["title"]}》\n\n{pr_url}')


# ──────────────────────────────────────────────────────────
# 后台启动（push 模型的核心）
# ──────────────────────────────────────────────────────────

PHASE_FUNCS = {
    'design':      ('start_design',   run_plan_design),
    'review':      ('start_review',   run_plan_review),
    'dev':         ('start_dev',      run_development),
    'code_review': (None,             run_code_review),  # 由 dev_complete 直接调
    'pr':          (None,             run_submit_pr),
}

def run_in_background(task_id, phase):
    """在后台子进程中运行下一阶段（非阻塞，输出写日志文件）"""
    script = Path(__file__).parent / 'run_phase.py'
    task_dir = get_task_dir(task_id)
    log_path = task_dir / f'{phase}_{int(time.time())}.log'
    log_f = open(log_path, 'w')
    subprocess.Popen(
        ['python3', str(script), task_id, phase],
        stdout=log_f,
        stderr=log_f
    )
    # log_f 不在这里关闭：子进程持有它，退出时自动关闭


RUNNING_STATES = {'designing', 'reviewing', 'in_development', 'code_reviewing'}

# 每个 phase 对应的 trigger 和合法的"已在运行中"状态
PHASE_CONFIG = {
    'design':      {'trigger': 'start_design',  'running': 'designing'},
    'review':      {'trigger': 'start_review',  'running': 'reviewing'},
    'dev':         {'trigger': 'start_dev',      'running': 'in_development'},
    'code_review': {'trigger': None,             'running': 'code_reviewing'},
    'pr':          {'trigger': None,             'running': None},
}

def execute_phase(task_id, phase):
    """执行指定阶段（带原子锁保护，防止双重状态转换）"""
    fd = acquire_lock(task_id)
    if fd is None:
        print(f'[{task_id}] 已有进程在运行，跳过 {phase}', file=sys.stderr)
        return

    try:
        task = get_task(task_id)
        if not task:
            print(f'[{task_id}] 任务不存在', file=sys.stderr)
            return

        current_status = task['status']
        config = PHASE_CONFIG.get(phase, {})
        trigger = config.get('trigger')
        running_state = config.get('running')

        # 如果已经是 running 状态（watcher 重试时），跳过 trigger，直接执行
        if running_state and current_status == running_state:
            print(f'[{task_id}] 已在 {running_state}，跳过 trigger 直接执行', file=sys.stderr)
        elif trigger:
            transition(task_id, trigger)

        # 执行阶段函数
        phase_func = {
            'design':      run_plan_design,
            'review':      run_plan_review,
            'dev':         run_development,
            'code_review': run_code_review,
            'pr':          run_submit_pr,
        }.get(phase)

        if phase_func:
            phase_func(task_id)
        else:
            print(f'[{task_id}] 未知阶段：{phase}', file=sys.stderr)

    except InvalidTransitionError as e:
        print(f'[{task_id}] 状态转换失败：{e}', file=sys.stderr)
    except Exception as e:
        print(f'[{task_id}] 阶段 {phase} 执行失败：{e}', file=sys.stderr)
        # 记录失败到数据库
        with get_conn() as conn:
            conn.execute('UPDATE tasks SET failure_count = failure_count + 1, updated_at = ? WHERE id = ?',
                         (now(), task_id))
    finally:
        release_lock(task_id)
