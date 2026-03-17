"""
需求评审工作流：需求分析 → 需求评审
独立于开发流程的轻量级工作流示例
"""
from __future__ import annotations

import json
from pathlib import Path

from dev_workflow.db import get_task, now
from dev_workflow.state_machine import transition
from dev_workflow.infra import (
    run_claude, notify, fetch_req, get_task_dir,
    PROMPTS_DIR, REQGENIE_REQ_URL,
    TIMEOUT_REVIEW, REVIEW_RESULT_PASS, REVIEW_RESULT_REJECT,
)
from dev_workflow.logger import get_logger

log = get_logger()


def run_req_analysis(task_id: str) -> None:
    """需求分析：拉取并整理需求内容"""
    task = get_task(task_id)
    task_dir = get_task_dir(task_id)

    # 拉取需求
    req = fetch_req(task['req_id'])
    if not req:
        local_req_path = task_dir / 'requirement.md'
        if local_req_path.exists():
            log.info('ReqGenie 不可用，使用本地需求文件')
            req = {'description': local_req_path.read_text(encoding='utf-8'), 'organized_content': {}}
        else:
            raise RuntimeError(f'无法拉取需求详情，且本地文件 {local_req_path} 不存在。')

    # 保存需求内容
    req_path = task_dir / 'requirement_analysis.md'
    description = req.get('description', '')
    org = req.get('organized_content') or {}
    acceptance = '\n'.join(org.get('acceptance_criteria', []))

    content = f'# 需求分析：{task["title"]}\n\n## 描述\n{description}\n\n## 验收标准\n{acceptance}'
    req_path.write_text(f'<!-- generated:{now()} -->\n{content}', encoding='utf-8')

    transition(task_id, 'analysis_complete', note='需求分析完成')
    notify(task, f'📄 需求分析完成：《{task["title"]}》\n\n等待需求评审...')


def run_req_review(task_id: str) -> None:
    """需求评审"""
    task = get_task(task_id)
    task_dir = get_task_dir(task_id)

    req_content = (task_dir / 'requirement_analysis.md').read_text(encoding='utf-8')

    # 使用需求评审提示词
    template_path = PROMPTS_DIR / 'requirement-review.md'
    if template_path.exists():
        template = template_path.read_text(encoding='utf-8')
        prompt = template.replace('{{title}}', task['title'])
        prompt = prompt.replace('{{url}}', f'{REQGENIE_REQ_URL}/{task["req_id"]}')
        prompt = prompt.replace('{{requirement_content}}', req_content)
    else:
        prompt = f'请评审以下需求：\n\n{req_content}\n\n请输出 REVIEW_RESULT: PASS 或 REVIEW_RESULT: REJECT'

    result = run_claude(prompt, timeout=TIMEOUT_REVIEW)

    review_path = task_dir / 'req_review_report.md'
    review_path.write_text(f'<!-- generated:{now()} -->\n{result}', encoding='utf-8')

    passed = REVIEW_RESULT_PASS in result

    if passed:
        transition(task_id, 'req_review_pass', note='需求评审通过')
        notify(task, f'✅ 需求评审通过：《{task["title"]}》', str(review_path))
    else:
        transition(task_id, 'req_review_reject', note='需求评审驳回')
        notify(task, f'❌ 需求评审驳回：《{task["title"]}》\n\n请检查评审报告', str(review_path))


# ──────────────────────────────────────────────────────────
# 工作流定义
# ──────────────────────────────────────────────────────────

WORKFLOW = {
    'name': 'req_review',
    'description': '需求评审流程',
    'phases': [
        {
            'name': 'req_analysis',
            'label': 'REQ_ANALYSIS',
            'trigger': 'start_analysis',
            'pending_state': 'pending_analysis',
            'running_state': 'analyzing',
            'complete_trigger': 'analysis_complete',
            'fail_trigger': 'analysis_fail',
            'timeout_key': 'review',
            'func': run_req_analysis,
        },
        {
            'name': 'req_review',
            'label': 'REQ_REVIEW',
            'trigger': 'start_req_review',
            'pending_state': 'pending_req_review',
            'running_state': 'req_reviewing',
            'complete_trigger': 'req_review_pass',
            'reject_trigger': 'req_review_reject',
            'retry_target': 'req_analysis',
            'max_rejections': 5,
            'timeout_key': 'review',
            'func': run_req_review,
        },
    ],
    'initial_state': 'pending_analysis',
    'terminal_states': ['req_review_done', 'cancelled'],
    # 手写转换表（更精确）
    'transitions': {
        'pending_analysis':    [('start_analysis',      'analyzing'),
                                ('cancel',              'cancelled')],
        'analyzing':           [('analysis_complete',   'pending_req_review'),
                                ('analysis_fail',       'pending_analysis'),
                                ('cancel',              'cancelled')],
        'pending_req_review':  [('start_req_review',    'req_reviewing'),
                                ('cancel',              'cancelled')],
        'req_reviewing':       [('req_review_pass',     'req_review_done'),
                                ('req_review_reject',   'req_review_rejected'),
                                ('cancel',              'cancelled')],
        'req_review_rejected': [('retry_req_analysis',  'pending_analysis'),
                                ('cancel',              'cancelled')],
    },
}
