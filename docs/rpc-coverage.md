# RPC × {web / tui / cli} 覆盖矩阵

自动生成 —— `bun run bin/coverage-matrix.ts`。

**覆盖判定**：在客户端目录里 grep method 名 / endpoint path 作为字符串字面量出现的次数。`—` 表示零引用。

**怎么读这张表**：
- 一列只有 web 而 tui/cli 都 `—` 的 method → 反渗内核的高危候选；改名时 web 拖动 trigger 改动
- **三列全 `—` 的 method** → 死代码候选。常见两种来源：
  - **HTTP / RPC 迁移残留**：同名 endpoint 已迁到 WS RPC，HTTP 这边没清 → 安全可删
  - **孤儿 method**：注册了但客户端忘接 → 补客户端调用 or 删 method
- tui 列大面积 `—` 是当前定位（observer-only）的体现，正常
- cli 列 `—` 而 web 有 → 若 method 跟自动化无关（如 UI 内编辑器）则正常；跟任务/工作流相关则是 CLI 待补

## 摘要

- RPC method 总数：107
  - 只 web 用：102
  - 无人调用：4
- HTTP endpoint 总数：23
  - 只 web 用：21
  - 无人调用：2

## WS RPC methods

| Name | Web | TUI | CLI |
|------|-----|-----|-----|
| `agents.create` | 1 | — | — |
| `agents.delete` | 1 | — | — |
| `agents.dryRun` | 1 | — | — |
| `agents.get` | 1 | — | — |
| `agents.list` | 1 | — | — |
| `agents.update` | 1 | — | — |
| `channels.subscribe` | 2 | — | — |
| `channels.unsubscribe` | 1 | — | — |
| `codebases.create` | 1 | — | — |
| `codebases.delete` | 1 | — | — |
| `codebases.get` | 1 | — | — |
| `codebases.healthcheck` | 1 | — | — |
| `codebases.list` | 1 | — | — |
| `codebases.listSubmodules` | 1 | — | — |
| `codebases.rediscoverSubmodules` | 1 | — | — |
| `codebases.update` | 1 | — | — |
| `config.get` | 1 | — | — |
| `config.save` | 1 | — | — |
| `daemon.log` | 1 | — | — |
| `daemon.restart` | 1 | — | — |
| `daemon.revealToken` | 1 | — | — |
| `daemon.setHost` | 1 | — | — |
| `daemon.status` | 1 | — | — |
| `defaults.get` | 1 | — | — |
| `defaults.save` | 1 | — | — |
| `now.cards` | 1 | — | — |
| `now.dismissCard` | 1 | — | — |
| `projects.addCodebase` | 1 | — | — |
| `projects.codebases` | 1 | — | — |
| `projects.create` | 1 | — | — |
| `projects.delete` | 1 | — | — |
| `projects.get` | 1 | — | — |
| `projects.list` | 1 | — | — |
| `projects.requirements` | 1 | — | — |
| `projects.update` | 1 | — | — |
| `providers.list` | 1 | — | — |
| `providers.models` | 1 | — | — |
| `providers.save` | 1 | — | — |
| `providers.status` | 1 | — | — |
| `providers.statusAll` | 1 | — | — |
| `requirements.addReply` | 1 | — | — |
| `requirements.cancel` | 1 | — | — |
| `requirements.clarifierRound` | 1 | — | — |
| `requirements.create` | 1 | — | — |
| `requirements.delete` | 1 | — | — |
| `requirements.enqueue` | 1 | — | — |
| `requirements.extract` | 1 | — | — |
| `requirements.finishClarification` | — | — | — |
| `requirements.get` | 1 | — | — |
| `requirements.injectFeedback` | 1 | — | — |
| `requirements.list` | 1 | — | — |
| `requirements.questions` | 1 | — | — |
| `requirements.resolveQuestion` | 1 | — | — |
| `requirements.retryClarify` | — | — | — |
| `requirements.specRevisions` | 1 | — | — |
| `requirements.subPrs` | 1 | — | — |
| `requirements.transition` | 1 | — | — |
| `requirements.update` | 1 | — | — |
| `schedules.create` | 1 | — | — |
| `schedules.delete` | 1 | — | — |
| `schedules.get` | 1 | — | — |
| `schedules.list` | 1 | — | — |
| `schedules.runNow` | 1 | — | — |
| `schedules.update` | 1 | — | — |
| `sessions.delete` | 1 | — | — |
| `sessions.get` | 1 | — | — |
| `sessions.list` | 1 | — | — |
| `setup.dismiss` | 1 | — | — |
| `setup.saveAgents` | 1 | — | — |
| `setup.saveCodebases` | 1 | — | — |
| `setup.saveProviders` | 1 | — | — |
| `setup.status` | 1 | — | — |
| `tasks.agentCall` | 1 | — | — |
| `tasks.agentCalls` | 1 | — | — |
| `tasks.answer` | 1 | — | — |
| `tasks.cancel` | 1 | — | — |
| `tasks.decide` | 1 | — | — |
| `tasks.delete` | 1 | — | — |
| `tasks.events` | — | — | — |
| `tasks.get` | 1 | — | — |
| `tasks.list` | 2 | — | 2 |
| `tasks.logs` | 1 | — | — |
| `tasks.outcome` | 1 | — | — |
| `tasks.phaseEvents` | 1 | — | — |
| `tasks.phaseLog` | 1 | — | — |
| `tasks.phaseLogs` | 1 | — | — |
| `tasks.restart` | 1 | — | — |
| `tasks.start` | 1 | — | — |
| `tasks.subtasks` | — | — | — |
| `workflows.author` | 1 | — | — |
| `workflows.delete` | 1 | — | — |
| `workflows.exportBundle` | 1 | — | — |
| `workflows.get` | 1 | — | — |
| `workflows.getTs` | 1 | — | — |
| `workflows.getYaml` | 1 | — | — |
| `workflows.graph` | 1 | — | — |
| `workflows.importBundle` | 1 | — | — |
| `workflows.list` | 1 | — | — |
| `workflows.phaseStats` | 1 | — | — |
| `workflows.saveAuthored` | 1 | — | — |
| `workflows.saveYaml` | 1 | — | — |
| `workflows.scanHealth` | 1 | — | — |
| `workflows.templates` | 1 | — | — |
| `workspaces.delete` | 1 | — | — |
| `workspaces.file` | 1 | — | — |
| `workspaces.tree` | 1 | — | — |
| `workspaces.usage` | 1 | — | — |

## HTTP endpoints

| Name | Web | TUI | CLI |
|------|-----|-----|-----|
| `POST /api/auth/login` | 1 | — | — |
| `POST /api/auth/logout` | 1 | — | — |
| `GET /api/auth/me` | 1 | — | — |
| `POST /api/auth/setup` | 1 | — | — |
| `POST /api/chat` | 1 | — | — |
| `GET /api/daemon/listen` | 2 | — | — |
| `PUT /api/daemon/listen` | 2 | — | — |
| `DELETE /api/daemon/token` | 2 | — | — |
| `POST /api/daemon/token/rotate` | 1 | — | — |
| `GET /api/fs/list` | 1 | — | — |
| `POST /api/reload` | 1 | — | — |
| `GET /api/repos` | — | — | — |
| `POST /api/repos` | — | — | — |
| `GET /api/requirements` | 4 | — | — |
| `POST /api/requirements` | 4 | — | — |
| `GET /api/status` | 1 | — | — |
| `GET /api/tasks` | 2 | — | — |
| `POST /api/tasks` | 2 | — | — |
| `GET /api/workflows` | 10 | — | — |
| `POST /api/workflows` | 10 | — | — |
| `POST /api/workflows/from-template` | 1 | — | — |
| `GET /api/workflows/health` | 1 | — | — |
| `POST /api/workflows/health/fix-orphan` | 1 | — | — |
