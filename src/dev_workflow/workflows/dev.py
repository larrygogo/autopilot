"""
完整开发工作流：方案设计 → 方案评审 → 开发 → 代码审查 → PR 提交
从 runner.py 迁移的 5 个阶段函数
"""
from __future__ import annotations

import json, re, subprocess
from pathlib import Path

from dev_workflow.db import get_task, get_conn, now, get_default_branch
from dev_workflow.state_machine import transition
from dev_workflow.infra import (
    _run_git, run_claude, notify, fetch_req, get_task_dir,
    PROMPTS_DIR, PROJECTS_DIR, REQGENIE_REQ_URL,
    TIMEOUT_DESIGN, TIMEOUT_REVIEW, TIMEOUT_DEV, TIMEOUT_CODE_REVIEW, TIMEOUT_PR_DESC,
    REVIEW_RESULT_PASS, REVIEW_RESULT_REJECT,
)
from dev_workflow.logger import get_logger

log = get_logger()


# ──────────────────────────────────────────────────────────
# 阶段函数
# ──────────────────────────────────────────────────────────

def run_plan_design(task_id: str) -> None:
    """方案设计"""
    task = get_task(task_id)
    task_dir = get_task_dir(task_id)
    repo_path = task['repo_path']

    # 更新仓库
    default_branch = get_default_branch(task['project'])
    _run_git(['checkout', default_branch], cwd=repo_path)
    _run_git(['pull', '--ff-only'], cwd=repo_path)

    # 读取需求（优先远程，fallback 到本地文件）
    req = fetch_req(task['req_id'])
    if not req:
        local_req_path = task_dir / 'requirement.md'
        if local_req_path.exists():
            log.info('ReqGenie 不可用，使用本地需求文件')
            req = {'description': local_req_path.read_text(encoding='utf-8'), 'organized_content': {}}
        else:
            raise RuntimeError(
                f'无法拉取需求详情，且本地文件 {local_req_path} 不存在。'
                f'可将需求内容写入该文件作为 fallback。'
            )

    # 读取历史驳回的评审报告（如有）
    rejection_history = ''
    review_path = task_dir / 'plan_review.md'
    rejection_counts = _get_rejection_counts(task)
    design_rejections = rejection_counts.get('design', 0)
    if review_path.exists() and design_rejections > 0:
        rejection_history = f'\n## 上一次评审的驳回意见（第{design_rejections}次驳回）\n{review_path.read_text(encoding="utf-8")}'

    # 拼装提示词
    template = (PROMPTS_DIR / 'plan-design.md').read_text(encoding='utf-8')
    description = req.get('description', '')
    org = req.get('organized_content') or {}
    acceptance = '\n'.join(org.get('acceptance_criteria', []))

    knowledge = ''
    knowledge_path = PROJECTS_DIR / task['project'] / 'knowledge.md'
    if knowledge_path.exists():
        knowledge = knowledge_path.read_text(encoding='utf-8')

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

    result = run_claude(prompt, repo_path, timeout=TIMEOUT_DESIGN)

    # 保存方案
    plan_path = task_dir / 'plan.md'
    plan_path.write_text(f'<!-- generated:{now()} -->\n{result}', encoding='utf-8')

    # 状态转换
    transition(task_id, 'design_complete', note='方案设计完成')
    notify(task, f'📋 方案设计完成：《{task["title"]}》\n\n等待方案评审...', str(plan_path))
    # Push：自动启动方案评审
    from dev_workflow.runner import run_in_background
    run_in_background(task_id, 'review')


def run_plan_review(task_id: str) -> None:
    """方案评审"""
    task = get_task(task_id)
    task_dir = get_task_dir(task_id)
    repo_path = task['repo_path']

    plan_content = (task_dir / 'plan.md').read_text(encoding='utf-8')
    template = (PROMPTS_DIR / 'plan-review.md').read_text(encoding='utf-8')
    prompt = template.replace('{{title}}', task['title'])
    prompt = prompt.replace('{{url}}', f'{REQGENIE_REQ_URL}/{task["req_id"]}')
    prompt = prompt.replace('{{plan_content}}', plan_content)

    result = run_claude(prompt, repo_path, timeout=TIMEOUT_REVIEW)

    # 保存评审报告
    review_path = task_dir / 'plan_review.md'
    review_path.write_text(f'<!-- generated:{now()} -->\n{result}', encoding='utf-8')

    # 解析结论
    passed = REVIEW_RESULT_PASS in result
    rejected = REVIEW_RESULT_REJECT in result

    if passed:
        transition(task_id, 'review_pass', note='方案评审通过')
        notify(task, f'✅ 方案评审通过：《{task["title"]}》\n\n开始开发...', str(review_path))
        # Push：直接启动开发
        from dev_workflow.runner import run_in_background
        run_in_background(task_id, 'dev')

    elif rejected:
        reason_match = re.search(r'## 驳回理由\n(.*?)(?=\n## |\Z)', result, re.DOTALL)
        reason = reason_match.group(1).strip() if reason_match else '请查看评审报告'
        rejection_counts = _get_rejection_counts(task)
        new_count = rejection_counts.get('design', 0) + 1
        rejection_counts['design'] = new_count

        max_rejections = _get_phase_config(task, 'review', 'max_rejections', 10)

        if new_count >= max_rejections:
            transition(task_id, 'cancel',
                note=f'方案评审驳回 {new_count} 次，已取消',
                extra_updates={'rejection_counts': json.dumps(rejection_counts), 'rejection_reason': reason})
            notify(task, f'⚠️ 方案评审驳回 {new_count} 次：《{task["title"]}》\n\n已超过上限，任务取消。', str(review_path))
        else:
            transition(task_id, 'review_reject',
                note=f'方案评审驳回（第{new_count}次）',
                extra_updates={'rejection_counts': json.dumps(rejection_counts), 'rejection_reason': reason})
            # 先回退到 pending_design，再启动重新设计
            transition(task_id, 'retry_design', note=f'自动重新设计（第{new_count}次驳回）')
            notify(task, f'❌ 方案评审驳回（第{new_count}次）：《{task["title"]}》\n\n自动重新设计...', str(review_path))
            from dev_workflow.runner import run_in_background
            run_in_background(task_id, 'design')
    else:
        raise RuntimeError(f'无法解析评审结论，请检查报告')


def run_development(task_id: str) -> None:
    """开发执行"""
    task = get_task(task_id)
    task_dir = get_task_dir(task_id)
    repo_path = task['repo_path']
    branch = task['branch']

    # 切换分支
    default_branch = get_default_branch(task['project'])
    _run_git(['checkout', default_branch], cwd=repo_path)
    _run_git(['pull', '--ff-only'], cwd=repo_path)
    r = _run_git(['checkout', '-b', branch], cwd=repo_path, check=False)
    if r.returncode != 0:
        _run_git(['checkout', branch], cwd=repo_path)

    plan_content = (task_dir / 'plan.md').read_text(encoding='utf-8')
    template = (PROMPTS_DIR / 'development.md').read_text(encoding='utf-8')
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

    result = run_claude(prompt, repo_path, timeout=TIMEOUT_DEV)

    report_path = task_dir / 'dev_report.md'
    report_path.write_text(f'<!-- generated:{now()} -->\n{result}', encoding='utf-8')

    # 提交 Claude 生成的代码（如有变更）
    status_r = _run_git(['status', '--porcelain'], cwd=repo_path)
    if status_r.stdout.strip():
        _run_git(['add', '-A'], cwd=repo_path)
        _run_git(['commit', '-m', f'feat: {task["title"]}'], cwd=repo_path)
        log.info('已提交代码变更')
    else:
        log.warning('Claude 未产生代码变更')

    transition(task_id, 'dev_complete', note='开发完成')
    notify(task, f'🔨 开发完成：《{task["title"]}》\n\n启动代码审查...', str(report_path))

    # Push：直接启动代码审查
    from dev_workflow.runner import run_in_background
    run_in_background(task_id, 'code_review')


def run_code_review(task_id: str) -> None:
    """代码审查"""
    task = get_task(task_id)
    task_dir = get_task_dir(task_id)
    repo_path = task['repo_path']

    # 获取 diff
    default_branch = get_default_branch(task['project'])
    r = _run_git(['diff', f'{default_branch}...HEAD', '--no-ext-diff'], cwd=repo_path)
    git_diff = r.stdout[:80000]

    plan_content = (task_dir / 'plan.md').read_text(encoding='utf-8')
    template = (PROMPTS_DIR / 'code-review.md').read_text(encoding='utf-8')
    prompt = template
    for k, v in {
        '{{title}}': task['title'],
        '{{url}}': f'{REQGENIE_REQ_URL}/{task["req_id"]}',
        '{{plan_content}}': plan_content,
        '{{git_diff}}': git_diff,
    }.items():
        prompt = prompt.replace(k, v)
    prompt = re.sub(r'{{#screenshots}}.*?{{/screenshots}}', '', prompt, flags=re.DOTALL)

    result = run_claude(prompt, repo_path, timeout=TIMEOUT_CODE_REVIEW)

    review_path = task_dir / 'code_review_report.md'
    review_path.write_text(f'<!-- generated:{now()} -->\n{result}', encoding='utf-8')

    passed = REVIEW_RESULT_PASS in result
    rejected = REVIEW_RESULT_REJECT in result

    if passed:
        transition(task_id, 'code_pass', note='代码审查通过')
        notify(task, f'✅ 代码审查通过：《{task["title"]}》\n\n提交 PR...', str(review_path))
        from dev_workflow.runner import run_in_background
        run_in_background(task_id, 'pr')

    elif rejected:
        reason_match = re.search(r'## 不通过理由\n(.*?)(?=\n## |\Z)', result, re.DOTALL)
        reason = reason_match.group(1).strip() if reason_match else '请查看审查报告'
        rejection_counts = _get_rejection_counts(task)
        new_count = rejection_counts.get('code', 0) + 1
        rejection_counts['code'] = new_count

        max_rejections = _get_phase_config(task, 'code_review', 'max_rejections', 10)

        if new_count >= max_rejections:
            transition(task_id, 'cancel',
                note=f'代码审查驳回 {new_count} 次，已取消',
                extra_updates={'rejection_counts': json.dumps(rejection_counts), 'rejection_reason': reason})
            notify(task, f'⚠️ 代码审查驳回 {new_count} 次：《{task["title"]}》\n\n已超过上限，任务取消。', str(review_path))
        else:
            transition(task_id, 'code_reject',
                note=f'代码审查驳回（第{new_count}次）',
                extra_updates={'rejection_counts': json.dumps(rejection_counts), 'rejection_reason': reason})
            # 先回退到 in_development，再启动返工
            transition(task_id, 'retry_dev', note=f'自动返工（第{new_count}次驳回）')
            notify(task, f'❌ 代码审查驳回（第{new_count}次）：《{task["title"]}》\n\n自动返工...', str(review_path))
            from dev_workflow.runner import run_in_background
            run_in_background(task_id, 'dev')
    else:
        raise RuntimeError('无法解析审查结论，请检查报告')


def run_submit_pr(task_id: str) -> None:
    """提交 PR"""
    task = get_task(task_id)
    task_dir = get_task_dir(task_id)
    repo_path = task['repo_path']
    branch = task['branch']

    # push 分支
    _run_git(['push', '-u', 'origin', branch], cwd=repo_path)

    # 生成 PR 描述（调 claude）
    plan_content = (task_dir / 'plan.md').read_text(encoding='utf-8') if (task_dir / 'plan.md').exists() else ''
    dev_report = (task_dir / 'dev_report.md').read_text(encoding='utf-8') if (task_dir / 'dev_report.md').exists() else ''
    default_branch = get_default_branch(task['project'])
    diff_r = _run_git(['diff', f'{default_branch}...HEAD', '--stat'], cwd=repo_path)
    git_diff = diff_r.stdout[:3000]

    template = (PROMPTS_DIR / 'pr-description.md').read_text(encoding='utf-8')
    prompt = template.replace('{{title}}', task['title'])
    prompt = prompt.replace('{{url}}', f'{REQGENIE_REQ_URL}/{task["req_id"]}')
    prompt = prompt.replace('{{plan_content}}', plan_content[:4000])
    prompt = prompt.replace('{{dev_report}}', dev_report[:2000])
    prompt = prompt.replace('{{git_diff}}', git_diff)

    # 判断有无前端改动
    name_r = _run_git(['diff', f'{default_branch}...HEAD', '--name-only'], cwd=repo_path)
    has_frontend = any(f.endswith(('.tsx', '.ts', '.jsx', '.vue', '.css', '.scss', '.less', '.html', '.svelte'))
                       for f in name_r.stdout.split('\n'))
    if has_frontend:
        prompt = prompt.replace('{{#has_frontend}}\n', '').replace('\n{{/has_frontend}}', '')
        prompt = re.sub(r'{{.has_frontend}}.*?{{/has_frontend}}', '', prompt, flags=re.DOTALL)
    else:
        prompt = re.sub(r'{{#has_frontend}}.*?{{/has_frontend}}', '', prompt, flags=re.DOTALL)
        prompt = prompt.replace('{{^has_frontend}}\n（无前端视觉改动）\n{{/has_frontend}}', '（无前端视觉改动）')

    pr_body = subprocess.run(
        ['claude', '--permission-mode', 'bypassPermissions', '--print', prompt],
        capture_output=True, text=True, timeout=TIMEOUT_PR_DESC, cwd=repo_path,
        encoding='utf-8', errors='replace'
    )
    body = pr_body.stdout.strip() if pr_body.returncode == 0 else f'完成需求：{task["title"]}'

    # 检查是否已有 PR
    existing = subprocess.run(['gh', 'pr', 'view', '--json', 'url'],
                              capture_output=True, text=True, cwd=repo_path,
                              encoding='utf-8', errors='replace')
    if existing.returncode == 0:
        pr_url = json.loads(existing.stdout).get('url', '')
        subprocess.run(['gh', 'pr', 'edit', '--body', body],
                       capture_output=True, cwd=repo_path)
    else:
        r = subprocess.run(
            ['gh', 'pr', 'create', '--title', task['title'], '--body', body,
             '--base', default_branch, '--head', branch],
            capture_output=True, text=True, cwd=repo_path,
            encoding='utf-8', errors='replace'
        )
        if r.returncode != 0:
            raise RuntimeError(f'创建 PR 失败：{r.stderr}')
        pr_url = r.stdout.strip()

    with get_conn() as conn:
        conn.execute('UPDATE tasks SET pr_url = ?, updated_at = ? WHERE id = ?',
                     (pr_url, now(), task_id))

    notify(task, f'🎉 PR 已提交：《{task["title"]}》\n\n{pr_url}')


# ──────────────────────────────────────────────────────────
# 辅助函数
# ──────────────────────────────────────────────────────────

def _get_rejection_counts(task: dict) -> dict:
    """从任务中获取驳回计数字典"""
    raw = task.get('rejection_counts', '{}')
    if not raw:
        raw = '{}'
    try:
        counts = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        # 兼容旧格式
        counts = {
            'design': task.get('rejection_count', 0) or 0,
            'code': task.get('code_rejection_count', 0) or 0,
        }
    return counts


def _get_phase_config(task: dict, phase_name: str, key: str, default):
    """从工作流定义中获取阶段配置值"""
    from dev_workflow.registry import get_phase
    workflow = task.get('workflow', 'dev')
    phase = get_phase(workflow, phase_name)
    if phase:
        return phase.get(key, default)
    return default


# ──────────────────────────────────────────────────────────
# 工作流定义
# ──────────────────────────────────────────────────────────

WORKFLOW = {
    'name': 'dev',
    'description': '完整开发流程',
    'phases': [
        {
            'name': 'design',
            'label': 'PLAN_DESIGN',
            'trigger': 'start_design',
            'pending_state': 'pending_design',
            'running_state': 'designing',
            'complete_trigger': 'design_complete',
            'fail_trigger': 'design_fail',
            'timeout_key': 'design',
            'func': run_plan_design,
        },
        {
            'name': 'review',
            'label': 'PLAN_REVIEW',
            'trigger': 'start_review',
            'pending_state': 'pending_review',
            'running_state': 'reviewing',
            'complete_trigger': 'review_pass',
            'reject_trigger': 'review_reject',
            'retry_target': 'design',
            'max_rejections': 10,
            'timeout_key': 'review',
            'func': run_plan_review,
        },
        {
            'name': 'dev',
            'label': 'DEVELOPMENT',
            'trigger': 'start_dev',
            'pending_state': 'developing',
            'running_state': 'in_development',
            'complete_trigger': 'dev_complete',
            'fail_trigger': 'dev_fail',
            'timeout_key': 'development',
            'func': run_development,
        },
        {
            'name': 'code_review',
            'label': 'CODE_REVIEW',
            'trigger': None,
            'pending_state': 'code_reviewing',
            'running_state': 'code_reviewing',
            'complete_trigger': 'code_pass',
            'reject_trigger': 'code_reject',
            'retry_target': 'dev',
            'max_rejections': 10,
            'timeout_key': 'code_review',
            'func': run_code_review,
        },
        {
            'name': 'pr',
            'label': 'SUBMIT_PR',
            'trigger': None,
            'pending_state': 'pr_submitting',
            'running_state': 'pr_submitting',
            'complete_trigger': None,
            'timeout_key': 'pr_description',
            'func': run_submit_pr,
        },
    ],
    'initial_state': 'pending_design',
    'terminal_states': ['pr_submitted', 'cancelled'],
    # 使用硬编码转换表以保持完全向后兼容
    'transitions': {
        'pending_design':  [('start_design',    'designing'),
                            ('cancel',          'cancelled')],
        'designing':       [('design_complete', 'pending_review'),
                            ('design_fail',     'pending_design'),
                            ('cancel',          'cancelled')],
        'pending_review':  [('start_review',    'reviewing'),
                            ('cancel',          'cancelled')],
        'reviewing':       [('review_pass',     'developing'),
                            ('review_reject',   'review_rejected'),
                            ('cancel',          'cancelled')],
        'review_rejected': [('retry_design',    'pending_design'),
                            ('cancel',          'cancelled')],
        'developing':      [('start_dev',       'in_development'),
                            ('cancel',          'cancelled')],
        'in_development':  [('dev_complete',    'code_reviewing'),
                            ('dev_fail',        'developing'),
                            ('cancel',          'cancelled')],
        'code_reviewing':  [('code_pass',       'pr_submitted'),
                            ('code_reject',     'code_rejected'),
                            ('cancel',          'cancelled')],
        'code_rejected':   [('retry_dev',       'in_development'),
                            ('cancel',          'cancelled')],
    },
}
