/**
 * req_dev workflow 阶段函数（P1 骨架版）
 *
 * 与旧 dev workflow 的本质差别：
 *  - setup_func 接收 repo_id（从 repos 表查 path / branch / github_owner / github_repo）
 *    而非读 workflow.config.repo_path
 *  - 阶段函数从 task extra 读 repo_path / github_owner / github_repo，无全局 config 依赖
 *
 * P1：design → review → develop → code_review → submit_pr 5 阶段
 * await_review / fix_revision 在 P3 加入
 */

import { getRepoById } from "@autopilot/core/repos";

// ──────────────────────────────────────────────
// 任务初始化
// ──────────────────────────────────────────────

export interface ReqDevSetupArgs {
  repo_id: string;
  title?: string;
  requirement?: string;
}

export function setup_req_dev_task(args: ReqDevSetupArgs): Record<string, unknown> {
  if (!args.repo_id) throw new Error("setup_req_dev_task: repo_id 必填");
  const repo = getRepoById(args.repo_id);
  if (!repo) throw new Error(`setup_req_dev_task: repo not found: ${args.repo_id}`);

  const title = args.title ?? "untitled";
  const requirement = args.requirement ?? "";
  const branch = `feat/${title.slice(0, 20).replace(/\s+/g, "-").toLowerCase()}`;

  return {
    title,
    requirement,
    repo_id: repo.id,
    repo_path: repo.path,
    default_branch: repo.default_branch,
    github_owner: repo.github_owner,
    github_repo: repo.github_repo,
    branch,
  };
}

// ──────────────────────────────────────────────
// 阶段函数（骨架：Task 8 实现完整逻辑）
// ──────────────────────────────────────────────

export async function run_design(_taskId: string): Promise<void> {
  throw new Error("run_design 未实现，见 Task 8");
}
export async function run_review(_taskId: string): Promise<void> {
  throw new Error("run_review 未实现，见 Task 8");
}
export async function run_develop(_taskId: string): Promise<void> {
  throw new Error("run_develop 未实现，见 Task 8");
}
export async function run_code_review(_taskId: string): Promise<void> {
  throw new Error("run_code_review 未实现，见 Task 8");
}
export async function run_submit_pr(_taskId: string): Promise<void> {
  throw new Error("run_submit_pr 未实现，见 Task 8");
}
