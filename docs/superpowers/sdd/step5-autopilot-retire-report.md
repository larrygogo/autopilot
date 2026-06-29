# Step 5 — 删除 A 模式 runner 死代码 报告

**日期**：2026-06-29  
**分支**：`feat/reqgenie-runner-20260623`  
**状态**：完成

## 删除清单

### 整目录删除
- `src/daemon/runner/`（10 文件：backend.ts / cost-gate.ts / credentials.ts / index.ts / lock.ts / poller.ts / registration.ts / rounds.ts / session-loop.ts / types.ts）
- `src/core/executor/`（4 文件：agent-runner.ts / git-ops.ts / index.ts / submit-pr.ts）

### 单文件删除
- `src/cli/runner.ts`（registerRunnerCommands 入口）
- 测试文件 18 个：executor-agent-runner / executor-git-ops / executor-no-statemachine-import / executor-submit-pr / runner-backend / runner-cli / runner-config-mode / runner-cost-gate / runner-credentials / runner-failure-paths / runner-lock / runner-mock-control-plane / runner-poller / runner-protocol-contract / runner-retention / runner-rounds / runner-session-loop-conformance / runner-session-loop

## 编辑清单

| 文件 | 改动 |
|------|------|
| `src/cli/index.ts` | 删 `import { registerRunnerCommands }` + `registerRunnerCommands(program)` 调用 |
| `src/daemon/index.ts` | 删 `loadRunMode` 导入 + mode:runner 整块（约 34 行） |
| `src/core/config.ts` | 删 `RunMode` / `loadRunMode` / `RunnerConfig` / `loadRunnerConfig` / `saveRunnerConfig`（约 56 行） |

## 文件迁移（意外发现）

`src/core/executor/git-ops.ts` 和 `submit-pr.ts` 还被框架的 `builtin-deliver-pr.ts`（PR 交付砖）引用，不是纯 A 模式死代码。  
处置：将这两文件迁移到 `src/core/workflow/git-ops.ts` / `src/core/workflow/submit-pr.ts`，更新 `builtin-deliver-pr.ts` 导入路径。

## 附带修复

`tests/single-writer-invariant.test.ts` 白名单漏了分支已有的 `src/migrations/051-workspace-path-nullable.ts`，补加（与本次删除无关的预存 bug）。

## 验证结果

- `bun run typecheck`：0 错误
- `bun test`：1763 pass / 0 fail
- `src/daemon/selfhosted-connector/` 完好（7 文件，B-interactive 未受影响）
- grep 残引：0 条
