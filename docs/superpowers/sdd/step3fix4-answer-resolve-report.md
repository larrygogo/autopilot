# Step3 Fix4：answer_clarification 后 resolve 问题触发 clarifier 续轮

## Status
DONE — 修复已 commit，typecheck 净，测试全绿。

## Commit
`bf93d08` — fix(connector): answer_clarification 后 resolve 问题触发 clarifier 续轮

## 改法
`CommandPollerRpcDeps` 接口新增 `resolveComment(commentId: string): void`。
`answer_clarification` 分支：addComment（用户回复，parent_id=question_id）之后，若 question_id 存在，调 `this.deps.resolveComment(question_id)` resolve 问题本身 → emit `requirement:question-resolved` → clarifier `_resolvedHandler` 触发 → 续轮。
`index.ts` 注入 `resolveComment = core resolveComment`（从 `../../core/requirements/comments` 导入）。

## reject 命令
不需要同样处理。reject 是 `awaiting_review → fix_revision` 路径，不走 clarifier，与 question-resolved 事件无关，现有逻辑正确。

## typecheck
净（0 errors）。

## bun test
selfhosted-connector/ 47 pass 0 fail；全量 1877 pass 1 fail（该 1 fail 是已知无关 flake，与本改动无关，见 MEMORY 记录）。
