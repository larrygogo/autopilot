/**
 * executor barrel —— A 模式执行核：纯计算 + git/gh 操作 + agent 运行。
 *
 * 红线（此目录所有文件均适用）：
 *   - 不得 import state-machine / requirement-scheduler / run-outcome / requirement-task-bridge / core/db
 *   - 不得调用 createTask()
 *   - 不得 emit phase:* / task:* 事件
 *   - 所有副作用（DB 写入 / 状态转移 / appendSubPr）由调用方（workflow 层 / runner 外壳）负责
 */

export { runRoundAgent, ghostTaskIdFor, type RoundAgentCtx } from "./agent-runner";
export {
  produceDiff,
  submitPrPure,
  type ExecRepo,
  type SubmitPrOpts,
  type SubmitPrResult,
} from "./submit-pr";
export {
  runGit,
  hasChanges,
  diffStat,
  pushToRemote,
  openOrUpdatePr,
  buildGhPrArgs,
  type GhPrInput,
} from "./git-ops";
export {
  pickCloneToken,
  ensureCodebase,
  type EnsureCodebaseOpts,
  type CodebaseRepoState,
} from "../sandbox/codebase";
