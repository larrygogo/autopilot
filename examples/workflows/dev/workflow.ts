/**
 * dev 工作流阶段函数（TypeScript 版）
 *
 * 执行模式：design / review / develop / code_review 四个 agent 阶段「纯提示词」——prompt 写在
 * workflow.yaml，由框架内置 prompt-runner 驱动，本文件没有它们的 run_ 函数。
 *
 * submit_pr 的机械交付（逐库 commit/push + gh 开 PR + appendSubPr 登记）已于 2026-06-18 **收编成
 * 框架内置 PR 交付器**：phase 在 yaml 里声明 `deliver: pr`（+ `pr_body_from: design`），框架自带
 * 受信任的 spawn 交付（见 src/core/workflow/builtin-deliver-pr.ts），本文件不再有 run_submit_pr。
 *
 * 只保留 setup_dev_task：任务初始化（回传业务字段，无 spawn / 无 IO）。
 */

export function setup_dev_task(args: { title?: string; requirement?: string }): Record<string, unknown> {
  // repo_path / default_branch / branch 由框架按需求绑定的 workspace + git 沙盒注入（task-factory.ts）。
  // 这里只回传业务字段，不再从 config 读写死路径。
  return {
    title: args.title ?? "untitled",
    requirement: args.requirement ?? "",
  };
}
