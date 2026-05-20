# 借鉴 paseo 业务心智的整改方案

- 状态：Draft
- 日期：2026-05-20
- 作者：architect
- 影响面：core / daemon / migrations / cli / web；不动 agents/providers
- 关联：CLAUDE.md「产品分层定位」、docs/architecture.md

---

## 1. 目标与非目标

### 目标

1. **新增 ad-hoc 心智入口**：用户能用一句话直接启动一个 task，跳过 project / codebase / workflow 选择。
2. **运行时追加 prompt（send_prompt）**：task 处于运行中（或 awaiting_*）时，可以从 CLI / WS 向当前 phase 的 agent 追加新指令，无需新建 task。
3. **系统通知 driver 层**：notify.ts 不再只靠 workflow.notify_func，要支持 OS 级通知（先做 Windows toast 一个驱动，其余列 roadmap）。
4. **schedules 升级**：除了创建新 task，还能对运行中 task 发送 prompt（mode = send_prompt）。
5. **workspace 用 git worktree**：codebase 已是 git repo 时，每个 task workspace 改用 git worktree add，让 ad-hoc 任务也能拿到隔离的代码工作树。
6. **数据层清理**：删 repos.ts 兼容 shim + /api/repos、合并 requirement_feedbacks 与 requirement_questions 为统一的 requirement_comments、对 sessions.ts 的存在意义给出结论。

### 非目标（明确延后）

- mobile / 远程 daemon / E2E 加密 relay
- PTY agent provider（已否决）
- now-aggregator / card-sources 体系替换（这是亮点，保留）
- workflow 心智的「流水线」路径不抛弃，ad-hoc 与 workflow 并存

---

## 2. 现状摘要（grok 完代码后的事实）

### 2.1 写入侧（single-writer）

- 所有 SQL 写都集中在 src/core/db.ts、src/core/codebases.ts、src/core/projects.ts、src/core/requirements.ts、src/core/requirement-questions.ts、src/core/requirement-feedbacks.ts、src/core/schedules.ts、src/core/spec-revisions.ts、src/core/sessions.ts 等模块。本 spec 新增写入入口必须遵守 single-writer 约定。
- TABLE_COLUMNS / PROTECTED_COLUMNS 定义在 src/core/db.ts:89-112。
- tasks 表已有 requirement_id（migration 019），用于双向关联，**ad-hoc task 该字段为 NULL**。

### 2.2 任务启动链路

- src/core/task-factory.ts:51 startTaskFromTemplate 是唯一启动入口。
- 当前流程：要求至少有 1 个工作流；多于一个时 workflow 必传；找到 workflow → 跑 setup_func 生成 extra → createTask 写库 → ensureTaskWorkspace 准备目录 → executePhase(taskId, firstPhase)。
- requirement 字段被默认塞进 extra.requirement（task-factory.ts:107-109），prompt-runner 通过 ${REQUIREMENT} 占位读取（prompt-runner.ts:53-56）。

### 2.3 workspace（关键）

- 当前 src/core/workspace.ts:48 ensureTaskWorkspace 只支持 template: 复制目录。WorkspaceConfig.git 字段已留占位（workspace.ts:27），但无实现。
- workspace 路径：AUTOPILOT_HOME/runtime/tasks/<taskId>/workspace/。
- 已有保留策略 applyRetentionPolicy（workspace.ts:297），按天数 + 总占用清 workspace 目录；不动 logs / agent-calls / DB。
- deleteTaskWorkspace / deleteTaskRuntimeDir 已实现。

### 2.4 prompt-runner

- src/core/prompt-runner.ts:79 makePromptRunner 已经把 yaml prompt: 字段映射成 agent.run 调用，输出落 workspace/<NN-phase>/agent_output.md。
- ad-hoc 工作流应直接复用此机制（一个 phase + prompt: ${REQUIREMENT}）。

### 2.5 schedules

- src/core/schedules.ts 当前 schema 只有 workflow / title / requirement 三元组用于创建 task；fire 行为在 src/core/scheduler.ts:24 fireSchedule 中**写死**调用 startTaskFromTemplate。
- 没有 mode 字段、也没有 target_task_id。

### 2.6 notify

- src/core/notify.ts:9 notify 只走两条路径：workflow.notify_func 或 log.info 兜底。无 OS 集成。

### 2.7 sessions

- src/core/sessions.ts 实现的 session 是**独立于 task 的对话历史**，文件存 runtime/sessions/<sid>/messages.jsonl，manifest 含 provider_session_id。
- 引用方：routes.ts chat API、rpc-methods.ts 暴露 listSessions/readSessionMessages、requirement.chat_session_id 字段。
- **用途**：澄清器（requirement-clarifier）和 chat agent 复用 session，跨需求保留一份对话历史。**与 task 是不同对象**——task 是「做事」，session 是「聊事」。

### 2.8 requirement_feedbacks vs requirement_questions

- requirement_questions（migration 008）：id TEXT PK, requirement_id, agent_text, suggestions JSON, status open/resolved，带子表 requirement_question_replies(author_role agent/user)。
- requirement_feedbacks（migration 005）：id INTEGER PK, requirement_id, source(github_review/manual), body, github_review_id。无回复线程。
- 两者职责重叠：都是「挂在某 requirement 上的人话条目」，差别在 source 与是否成 thread。

### 2.9 repos.ts

- src/core/repos.ts 只是个 re-export shim（10 行）。/api/repos/*（routes.ts:711-893）仍在并已注释「P6 清理」。

### 2.10 现有 RPC 方法风格

- WS RPC 集中在 src/daemon/rpc-methods.ts，按 <resource>.<verb> 命名。本 spec 新增 method 沿用此约定。

---

## 3. 设计方案

### 3.1 删 repos shim + `/api/repos`

**动机**：CLAUDE.md 明确 P6 清理；已无现存调用方依赖（grep 显示只 docs / tests 有引用 feedback 路径，repos 路径仅 routes.ts 自身 + 文档）。

**设计**：

- 删 src/core/repos.ts 整个文件。
- 删 src/daemon/routes.ts:711-893 的 7 个 /api/repos/* 路由（含 alias repo_alias 解析逻辑 routes.ts:594-600 也一并清理或迁到 codebase_alias）。
- 同时清理 routes.ts:73-77 withRepoIdAlias 与 web/CLI 对 repo_id 的兼容映射（grep 出还有引用的 5 处 body.repo_id ?? body.codebase_id 之类回退）。
- Requirement 列保持 codebase_id，序列化时不再回填 repo_id 别名。

**影响面**：src/web/src/hooks/useApi.ts 客户端方法 listRepos / createRepo 等需要改名为 codebase 系列（如果还存在）。tests 中所有 repo_id body 参数改为 codebase_id。

### 3.2 合并 feedback + question → requirement_comments

**动机**：两套表表达同一类东西，UI 上「评论线程」是用户心智，分两个表带来重复 routes / hooks / 列表合并逻辑。paseo 心智只认「task 上的对话流」——autopilot 把它沿用到 requirement。

**设计**：新建 requirement_comments 表替代两者，字段：

| 列 | 类型 | 说明 |
|----|------|------|
| id | TEXT PK | cmt-NNN（新建）；旧 qst-NNN 保留不强转 |
| requirement_id | TEXT NOT NULL | 关联 requirement |
| parent_id | TEXT NULL | 单层树，null=顶层 |
| kind | TEXT NOT NULL | question / feedback / handoff |
| from_role | TEXT NOT NULL | agent / user / github |
| body | TEXT NOT NULL | 文本内容 |
| suggestions | TEXT NULL | JSON 数组；仅 kind=question 用 |
| status | TEXT NOT NULL | open / resolved；feedback / handoff 默认 resolved |
| github_review_id | TEXT NULL | 仅 from_role=github |
| created_at | INTEGER NOT NULL | epoch ms |
| resolved_at | INTEGER NULL | resolved 时回填 |

索引：(requirement_id, created_at)、(parent_id)、(status)。

**迁移合并规则**：

- requirement_questions → requirement_comments with kind=question, from_role=agent, status 同；id 直接复用（保留 qst-NNN）。
- requirement_question_replies → requirement_comments with kind=question, parent_id=<question.id>, from_role=author_role, status=resolved。
- requirement_feedbacks → requirement_comments with kind=feedback, from_role = (source==github_review ? github : user), github_review_id 直存，status=resolved；id 加前缀 fb- 避免与 qst- 冲突。

**影响面**：

- 新增 src/core/requirement-comments.ts（CRUD helper + nextCommentId）。
- 删 src/core/requirement-questions.ts 和 src/core/requirement-feedbacks.ts，调用点改用新模块。
- 改：routes.ts 现有 /api/requirements/:reqId/questions* 与 inject_feedback 端点 → 新统一为 /api/requirements/:reqId/comments*（旧端点保留 deprecation 一阶段）。
- 改：rpc-methods.ts 新增 comments.list / comments.add / comments.resolve；旧 requirements.questions.* / requirements.feedbacks.* 标 deprecated。
- 改：src/core/card-sources/open-question.ts、clarifier-error.ts 的查询源指向新表。
- 改：requirement-extract.ts / requirement-clarifier.ts / pr-poller.ts 调用点。
- web hooks useApi.ts 同步改名。

### 3.3 关于 sessions.ts — **结论：保留，但明确边界**

**理由（一行）**：sessions 是「独立于 task 的对话历史」（澄清器 / chat-agent / 跨需求复用 provider_session_id），与 task 上的 prompt 流是两个生命周期。强行并入 task 会让澄清器对话被 task 终态清理误删。

**整改**：

- 不做表合并，但要在 docs/architecture.md 加一段「sessions vs tasks 边界」澄清。
- 把 sessions.ts 现在的 jsonl 文件持久化保留（轻量、append-only 适合纯文本），不动结构。
- 加 1 个保留策略：终态 requirement 删除时，级联删 chat_session_id 指向的 session 目录（避免孤儿 jsonl 累积）。在 requirements.deleteRequirement 中追加，调用 sessions.deleteSession。

### 3.4 workspace 升级到 git worktree

**动机**：ad-hoc 任务和工作流任务都需要「基于某 codebase 的临时分支沙盒」。当前实现只能复制空目录或模板，agent 改文件改的是 workspace 内的副本，跟 codebase 完全脱钩。git worktree 是 git 内置的多工作树机制，正好对应「task = codebase 上的一个临时分支」。

**设计**：

WorkspaceConfig 扩展为：

```yaml
workspace:
  git: true                    # 启用 git worktree 模式（默认 false 保持兼容）
  branch_prefix: "autopilot/"  # worktree branch 名前缀，默认 autopilot/
  base: "main"                 # 派生 base，可被 task extra.base_branch 覆盖
  template: workspace_template # 与 git 互斥：有 git 时 template 被忽略并 warn
```

**runtime 行为**（ensureTaskWorkspace 新分支）：

1. 解析 codebase：从 task 的 extra.codebase_id（如 ad-hoc 路径传入）或 requirement.codebase_id 反查；找不到时退化为非 git 模式 + warn。
2. 校验 codebase.path 是 git 仓库（.git 存在）。否则 warn 并退化。
3. 计算 branch 名：${branch_prefix}${taskId}，已存在则附 -2 / -3 后缀。
4. 执行 git -C <codebase.path> worktree add -b <branch> <wsPath> <base>。失败回退到空目录 + warn。
5. 在 task extra.worktree 里记录：{ codebase_id, branch, base, created_at }。

**task 终态归档策略**：

- 终态（done / failed / cancelled）时，**不立刻删 worktree**。让用户先看 diff / 跑测试。
- applyRetentionPolicy 增 worktree 感知：清理 workspace 前先调 git worktree remove <wsPath> --force，再 rmSync 兜底。
- 新增 helper removeTaskWorktree(taskId) 在 workspace.ts，被 deleteTaskWorkspace 调用前置一次。
- 若 worktree 上有 uncommitted change，git worktree remove 默认会失败 → 用 --force 直接干掉。**这是有意为之**：超过保留期还没提交的就是垃圾。

**Codebase 没初始化 git 时的回退**：

- worktree 模式要求 codebase 是 git repo。ad-hoc 入口若用户没指定 codebase，直接用旧的「空目录 workspace」模式跑，agent 拿到的 cwd 仍是隔离的 tmp 目录。
- yaml workspace.git=true 但 codebase 不是 git 时，warn 一次然后退化到空目录，不阻塞任务启动。

### 3.5 notify.ts 加系统通知 driver 层

**动机**：当前 notify 只能日志，用户切走桌面后任务跑完没动静。paseo 心智的「发完就走 + 完了 ping 我」是核心体验。

**设计**：

src/core/notify.ts 重构为：

1. 保留 notify(task, message, event) 公开接口。
2. 内部按顺序调用：
   - workflow.notify_func（如有，保留原路径）
   - 全部已注册的 system driver（不阻塞，错误吃掉记 warn）
   - log.info 兜底
3. 新增 NotifyDriver 接口（伪代码）：
   ```
   interface NotifyDriver {
     name: string;
     enabled(): boolean;          // 读 config / 平台探测
     send(payload: NotifyPayload): Promise<void>;
   }
   ```
4. 内置 driver：
   - **first ship**：
     - **windows-toast**（Bun.spawn powershell New-BurntToastNotification，无依赖时优雅降级到 msg.exe 或纯日志）
     - **macos-osascript**（`Bun.spawn(["osascript", "-e", 'display notification "<message>" with title "Autopilot"'])`，macOS 内建无依赖直接可用）
   - 提供 stub：linux-notify-send、slack-webhook，加 TODO 注释。
5. 配置在 config.yaml：
   ```yaml
   notify:
     drivers:
       - type: windows-toast
         on_events: [task-done, task-failed, phase-awaiting]
       - type: macos-osascript
         on_events: [task-done, task-failed, phase-awaiting]
       - type: slack-webhook
         url: "https://..."
         on_events: [task-done, task-failed]
   ```
6. event 字段含义对齐：notify 调用方传 task-done / task-failed / phase-awaiting / info，driver 按 on_events 白名单过滤。

**影响面**：src/core/config.ts 加 loadNotifyConfig；新增 src/core/notify-drivers/ 目录（每个 driver 一个文件 + index.ts 收口）。

### 3.6 schedules 加 send_prompt mode

**动机**：用户场景「每天早上 9 点提醒我的长跑 task 推进一下」。当前 schedule 只能每天起新 task。

**设计**：

schedules 表加列：

- mode TEXT NOT NULL DEFAULT 'start_task'  -- start_task / send_prompt
- target_task_id TEXT NULL  -- mode=send_prompt 时必填
- prompt TEXT NULL  -- mode=send_prompt 时必填（带占位符）

**fire 行为**（scheduler.ts:24 fireSchedule）：

- mode=start_task：原逻辑不变。
- mode=send_prompt：调用新模块 src/core/task-send-prompt.ts 的 sendPromptToTask(targetTaskId, expandedPrompt)。
- 目标 task 已终态时，schedule 自动 disable + 写一条 task_logs（note: scheduled prompt skipped: task terminal）。

### 3.7 ad-hoc 入口（核心新增）

**动机**：paseo 心智 = 一句话发包。autopilot 现有的 prompt_quick 工作流已经接近，但用户仍需先选 codebase + 起 requirement。

**设计**：

1. **内置工作流 ad-hoc**：随 daemon 默认装到 ~/.autopilot/workflows/ad-hoc/（init / upgrade 时确保存在）。yaml：
   ```yaml
   name: ad-hoc
   label: "即兴任务"
   description: "一句话发包：跳过项目/需求，直接跑一个 agent prompt"
   workspace:
     git: true        # 若 codebase 提供则 worktree，否则退化空目录
   phases:
     - name: run
       label: "执行"
       agent: coder
       timeout: 1800
       prompt: |
         ${REQUIREMENT}
   ```
   只有一个 phase，跑完即 done。

2. **CLI**：autopilot run "<prompt>" [-c <codebase-id-or-alias>] [-w <workflow>]。
   - 默认 workflow = ad-hoc。
   - 不传 codebase 时，workspace 走空目录模式。
   - 传 codebase 时，task 启动时 worktree add。
   - 输出：task id + 实时日志直跟（等价于 task logs --follow），Ctrl+C 仅退跟日志，task 在后台继续。
   - 退出码：完成返回 0；task 失败返回 1；启动失败返回 2。

3. **Web 入口**：Dashboard 头部加「Run a prompt」输入框（具体设计交给 designer）。后端复用 tasks.start RPC，传 workflow=ad-hoc、extra.codebase_id、requirement=<prompt>。

4. **WS RPC** 新增 tasks.startAdHoc { prompt, codebase_id?, workflow? }，本质是 startTaskFromTemplate 的薄封装，强制 workflow ??= ad-hoc、把 prompt 塞进 requirement。

### 3.8 send_prompt 接管运行中 task（核心新增 + 关键设计）

**动机**：task 跑了一半发现还要补一句，或想让 agent 继续做别的事，又不想重起整 workflow。

**关键问题**：phase 已经把 prompt 喂给 agent.run 在跑了，怎么「追加」？

**选定方案：分场景三档**

| 场景 | task 当前状态 | 行为 |
|------|--------------|------|
| A. 阶段函数运行中（phase.running，agent 进程在生命周期内） | running_* | 排队到 task extra.pending_prompts[]，当前 agent.run 结束后 phase 函数检查并起**第二轮** agent.run（如果 phase 函数支持） |
| B. gate phase 等待人工决断 / clarifier 等用户回话 | awaiting_* | 直接调 pending-questions.answerPending(taskId, prompt)（已有机制），消费方 phase 函数自决怎么用 |
| C. 终态 | done / failed / cancelled | 拒绝，建议用户起新 task；返回 TASK_TERMINAL 错误 |

**为什么不允许打断当前 agent.run**：

- agent provider 抽象层没暴露 in-flight cancellation 接口（PTY 方案已否决）。
- 强行 kill 会留下半完成的 git working tree，回不去。

**实施层**：

1. 新建 src/core/task-send-prompt.ts，公开 sendPromptToTask(taskId, prompt, opts) → { accepted, mode, reason? }。
2. 模式判定：读 task.status → workflow.phases 找当前 phase → 看 awaiting_* 命名约定 → 选 A/B/C。
3. **A 路径**：通过 db.updateTask 把 prompt append 到 extra.pending_prompts（数组，每条 { prompt, source, queued_at }）。需要 phase 函数主动消费——本 spec 同时提供 prompt-runner.ts 升级：跑完一次 agent.run 后检查 pending_prompts，非空则继续起下一轮 agent.run，把 pending 喂进去并清空。**只 prompt-runner 自动支持**；自定义 ts phase 函数需要自己读 pending_prompts 才生效。
4. **B 路径**：直接 await import(../agents/pending-questions).answerPending(taskId, prompt)。
5. emit task:prompt-queued / task:prompt-answered 事件供 UI 显示。

**写入侧**：updateTask(taskId, { pending_prompts: [...] }) 走 single-writer，pending_prompts 是 extra JSON 字段（非列字段，自动合并到 extra）。**注意并发竞态**：updateTask 已有事务保护 extra 合并（db.ts:279-303），但短间隔多次 sendPrompt 仍可能丢前一条；缓解办法见 §8 风险表。

**ts phase 兜底机制**（消除 §3.8 实施步骤 3 末尾「ts phase 自己读 pending_prompts 才生效」的隐性约定）：

ts phase 函数实现者很容易忘记主动消费 pending_prompts。落地三层保险：

1. **自动 warn**：runner.ts 在阶段函数 (phaseFn) 返回后（无论成功 / 失败）加一段检查 —— 读 task.extra.pending_prompts，非空时：
   - emit `phase:pending-prompts-unconsumed` 事件，payload `{ taskId, phase, count, preview: string[] }`（preview 取每条 prompt 前 80 字符避免日志膨胀）。
   - 在 task_logs 写一条 WARN 行：「phase=<X> 完成时仍有 N 条未消费 pending_prompts，下一阶段或人工介入需明确处理」。
   - **不自动清空**，保留给下一 phase 函数或 §3.7 多 phase ad-hoc 工作流的下一轮 prompt-runner 自动消费。
2. **提供 helper**：`src/core/task-send-prompt.ts` 同模块导出 `consumePendingPrompts(taskId: string): string[]` —— 原子读+清（DB 事务内 read extra → updateTask 把 pending_prompts 置空 → 返回数组）。ts phase 一行 `const extras = consumePendingPrompts(taskId);` 即可接入。
3. **强提示文档**：`docs/workflow-development.md` 新增「pending_prompts 消费约定」一节，明示：
   - prompt-driven phase（yaml `prompt:`）—— 自动消费，开发者不必管。
   - ts phase（导出 `run_<name>`）—— 推荐在 phaseFn 开头调 `consumePendingPrompts(taskId)`，把返回数组按业务语义拼到主 prompt；忘写时 phase 仍能跑通但会触发 unconsumed WARN。

这样三层保险：helper 让 ts phase 一行接入；忘了接入 WARN 事件 + log 也能让 dogfood 时立刻看到。

### 3.9 不在范围内（重申）

- mobile 客户端 / 远程 daemon / E2E 加密 — 不做。
- PTY agent provider — 已否决。
- now-aggregator / card-sources 体系不动。
- workflow 心智不抛弃，与 ad-hoc 心智并存。

---

## 4. 数据模型变更

### 4.1 新建 migration `021-requirement-comments.ts`

风格参考 008-projects.ts（CREATE 新表 → INSERT … SELECT 迁数据 → DROP 旧表）。FK 关闭由 migrate.ts 自动处理。

伪代码：

```
export function up(db: Database): void {
  // 1. 新表 + 三个索引
  db.run("CREATE TABLE IF NOT EXISTS requirement_comments (...);");
  db.run("CREATE INDEX ... ON requirement_comments(requirement_id, created_at);");
  db.run("CREATE INDEX ... ON requirement_comments(parent_id);");
  db.run("CREATE INDEX ... ON requirement_comments(status);");

  // 2. question → comment
  db.run(`
    INSERT INTO requirement_comments
      (id, requirement_id, parent_id, kind, from_role, body, suggestions, status, created_at, resolved_at)
    SELECT id, requirement_id, NULL, 'question', 'agent', agent_text,
           suggestions, status, created_at, resolved_at
    FROM requirement_questions
  `);

  // 3. question_replies → comment（parent_id 指向原 question.id）
  db.run(`
    INSERT INTO requirement_comments
      (id, requirement_id, parent_id, kind, from_role, body, status, created_at, resolved_at)
    SELECT r.id,
           (SELECT q.requirement_id FROM requirement_questions q WHERE q.id = r.question_id),
           r.question_id, 'question', r.author_role, r.text,
           'resolved', r.created_at, r.created_at
    FROM requirement_question_replies r
  `);

  // 4. feedback → comment（id 加 fb- 前缀防与 qst- 冲突）
  db.run(`
    INSERT INTO requirement_comments
      (id, requirement_id, parent_id, kind, from_role, body, status, github_review_id, created_at, resolved_at)
    SELECT 'fb-' || id, requirement_id, NULL, 'feedback',
           CASE source WHEN 'github_review' THEN 'github' ELSE 'user' END,
           body, 'resolved', github_review_id, created_at, created_at
    FROM requirement_feedbacks
  `);

  // 5. 删旧表
  db.run("DROP TABLE requirement_question_replies");
  db.run("DROP TABLE requirement_questions");
  db.run("DROP TABLE requirement_feedbacks");
}
```

### 4.2 新建 migration `022-schedules-send-prompt.ts`

```
export function up(db: Database): void {
  const cols = db.query("PRAGMA table_info(schedules)").all();
  if (!cols.some(c => c.name === "mode"))
    db.run("ALTER TABLE schedules ADD COLUMN mode TEXT NOT NULL DEFAULT 'start_task'");
  if (!cols.some(c => c.name === "target_task_id"))
    db.run("ALTER TABLE schedules ADD COLUMN target_task_id TEXT");
  if (!cols.some(c => c.name === "prompt"))
    db.run("ALTER TABLE schedules ADD COLUMN prompt TEXT");
  db.run("CREATE INDEX IF NOT EXISTS idx_schedules_target_task ON schedules(target_task_id)");
}
```

### 4.3 无 schema 变更但需调整代码的字段

- tasks.extra.pending_prompts：新增运行时字段，不进列，自动合并到 extra JSON。结构：`[{ prompt, source: "user"|"schedule"|"github", queued_at: epoch_ms }]`。
- tasks.extra.worktree：新增运行时字段，记录 `{ codebase_id, branch, base, created_at }`。
- tasks.extra.codebase_id：ad-hoc 路径填入，setup_func 透传，workspace.ts 读它做 worktree。

### 4.4 单独清理 PR（不带 migration）

- 删 src/core/repos.ts：纯 re-export，无 schema 改动。
- 删 routes.ts 中 /api/repos/* 全部端点。

---

## 5. API 变更

### 5.1 CLI

新增：

- `autopilot run "<prompt>" [-c <codebase-id|alias>] [-w <workflow>] [--no-follow]`
- `autopilot task send-prompt <task-id> "<prompt>"`
- `autopilot schedule create --mode send-prompt --target <task-id> --prompt "..." --cron "..."`

废弃 / 移除：

- autopilot codebase 系列已存在；不动。
- 删 autopilot repo *（如存在）。

### 5.2 REST 端点

删：

- GET/POST/PUT/DELETE /api/repos/*（7 个端点，routes.ts:711-893）
- POST /api/requirements/:id/inject_feedback（统一到 comments）
- GET/POST /api/requirements/:reqId/questions*（同上）

新增：

- POST /api/tasks/:id/send_prompt  body `{ prompt: string }` → 200 `{ mode: 'queued'|'answered', accepted: true }`；409 `{ error: "TASK_TERMINAL" }`
- GET /api/requirements/:reqId/comments?kind=&status=
- POST /api/requirements/:reqId/comments  body `{ kind, body, parent_id?, suggestions?, from_role? }`
- POST /api/requirements/:reqId/comments/:cid/resolve

### 5.3 WS RPC

新增：

- tasks.startAdHoc `{ prompt, codebase_id?, workflow? }` → Task
- tasks.sendPrompt `{ id, prompt }` → `{ mode, accepted }`
- comments.list `{ requirementId, kind?, status? }` → Comment[]
- comments.add `{ requirementId, kind, body, parent_id?, suggestions?, from_role? }` → Comment
- comments.resolve `{ id }` → `{ ok: true }`

废弃（保留一阶段、加 deprecation 警告）：

- requirements.questions.* → 改用 comments.*
- requirements.feedbacks.* → 改用 comments.*

### 5.4 错误码

- TASK_TERMINAL：send_prompt 调用到终态 task。
- NO_PROMPT_TARGET：send_prompt 但 task 不存在或无活动 phase。
- WORKTREE_FAILED：worktree 创建失败，task 已退化为空 workspace（warn 级别，不阻断）。

### 5.5 幂等性

- POST /api/tasks/:id/send_prompt：非幂等，每次调用都 append 一条到 pending_prompts。客户端去重责任。
- comments.add：非幂等，body 完全相同也会建两条；UI 上避免重复点击。
- tasks.startAdHoc：每次创建新 task；如果用户要「同一 prompt 不要重复跑」需要自行做。

---

## 6. 兼容性 / 迁移路径

### 6.1 已有用户 DB

- migration 021/022 自动跑（autopilot upgrade 或下次 daemon 启动）。
- requirement_comments 迁完后旧表被 DROP，**不留兼容视图**——本 spec 是清算性整改，新代码统一查新表。
- schedules 新列默认值 mode=start_task，老 schedule 行为零影响。

### 6.2 workspace / worktree

- 老 task workspace（非 worktree）继续可读。
- 只有新建 task（workflow.yaml workspace.git=true）才走 worktree。
- 已有工作流 yaml 不动 = 仍是 template 模式。

### 6.3 sessions / messages.jsonl

- 不动。新增的「requirement 删除时级联清 session 目录」只对此后删除的 requirement 生效；存量孤儿 session 由用户自行清或写 one-off autopilot doctor --clean-orphan-sessions（不在本 spec 范围）。

### 6.4 客户端版本兼容

- daemon ≥ vNEXT 才有新 RPC method，旧 client 调老 RPC 仍能用一阶段（comments 老路径保留 1 个发布周期）。
- web UI 必须与 daemon 同发布版本；CLI 老版本最多缺新命令，不会崩。
- 在 rpc.ts 给废弃 method 返回结果里加 _deprecated: true 字段，让 web UI 显示提示。
- **/api/repos 直接删，不留 410 Gone 过渡**。web client 必须同发布版本升级；release notes 仅在 changelog 注明。理由：§6.1 已确立「本 spec 是清算性整改、不留兼容视图」；CLAUDE.md 记忆里 repos 兼容已超 90 天周期；/api/repos 不是用户脚本目标而是 web client 私用接口。

---

## 7. 阶段拆分（PR-sized）

**依赖图**（实际拆 PR 顺序）：

```
Phase 1 (repos cleanup)         独立
Phase 2 (requirement_comments)  独立
Phase 3 (workspace worktree)    独立
Phase 4 (notify + ad-hoc)       独立（ad-hoc 工作流模板自带）
Phase 5 (send_prompt)           改 prompt-runner.ts
Phase 6 (handoff)               改 prompt-runner.ts  ← 必须在 Phase 5 之后
Phase 7 (agent alias)            独立
```

Phase 1-4 之间可任意并发；Phase 5 → 6 严格串行；Phase 7 与任意其他 Phase 并行均可。

### Phase 1 — 清理 repos 兼容层

- 删 src/core/repos.ts、routes.ts 中 /api/repos/*、withRepoIdAlias。
- 清 web hooks 中 repo_id 兼容回退。
- 不涉及 schema。
- **验收**：bun test、bun run coverage:rpc、bun run smoke-test。

### Phase 2 — requirement_comments 合并

- 加 migration 021。
- 新建 src/core/requirement-comments.ts（CRUD + nextCommentId）。
- 改路由 / RPC 暴露 comments 接口；保留 questions/feedbacks 老 method 做一次 deprecation。
- 改所有调用点（clarifier、pr-poller、card-sources、web hooks）。
- 删 requirement-questions.ts / requirement-feedbacks.ts。
- **验收**：bun test、新增 tests/requirement-comments.test.ts 覆盖迁移合并 + CRUD。

### Phase 3 — workspace git worktree

- 改 src/core/workspace.ts:ensureTaskWorkspace 加 git 分支。
- 加 removeTaskWorktree 并接到 applyRetentionPolicy / deleteTaskWorkspace。
- yaml schema 文档更新（docs/workflow-development.md）。
- **验收**：新增 tests/workspace-worktree.test.ts（mock git，验证退化路径）；手动跑一遍真实 codebase。

### Phase 4 — notify driver 层 + ad-hoc 入口

- 重构 notify.ts 加 driver registry。
- 实现 windows-toast + macos-osascript driver + 2 个 stub（linux-notify-send / slack-webhook）。
- 装内置 ad-hoc workflow（init / upgrade 时确保存在）。
- 加 tasks.startAdHoc RPC + autopilot run CLI。
- web 头加 Run a prompt 输入框（designer 设计 → coder 实现）。
- **验收**：tests/notify-drivers.test.ts 覆盖 windows-toast + macos-osascript 两个 driver 的 enabled() 平台探测 + send 调用（mock spawn）；smoke-test 加一步 autopilot run "echo"；手动 e2e 要求在 macOS / Windows 各跑一次确认弹窗。

### Phase 5 — send_prompt + schedule mode

- migration 022 加列。
- 新建 src/core/task-send-prompt.ts，三分支判定。
- prompt-runner.ts 升级：跑完 agent.run 后消费 pending_prompts。
- scheduler.ts 加 mode=send_prompt 分支。
- 加 tasks.sendPrompt RPC + POST /api/tasks/:id/send_prompt + CLI task send-prompt。
- **验收**：tests/task-send-prompt.test.ts（三个分支：A 排队 / B answered / C 终态拒绝）；tests/scheduler-send-prompt.test.ts。

---

## 8. 风险评估

| 风险 | 严重度 | 缓解 |
|------|-------|------|
| migration 021 数据丢失（FK 残留 / 旧表删失败） | 高 | migrate.ts 已在 DROP TABLE 场景关 FK，迁移前 backup workflow.db；写 dry-run 模式跑一次 |
| worktree add 失败导致 task 起不来 | 中 | warn + 退化空 workspace，不阻塞任务启动（已设计） |
| pending_prompts 在并发 updateTask 下竞争丢失 | 中 | updateTask 已有事务保护 extra 合并（db.ts:279-303），但短间隔多次 send_prompt 仍可能丢；缓解：在 db.ts 加专用 appendPendingPrompt(taskId, item) 走 single transaction，single-writer |
| windows-toast / macos-osascript driver 平台不可用时报错 | 低 | enabled() 做平台 + 二进制探测；windows-toast 缺 BurntToast 降级 msg.exe / 纯日志；macos-osascript 是 macOS 内建无依赖问题 |
| schedule mode=send_prompt 指向已删除 task | 低 | fire 时 getTask 为 null → 自动 disable，写 task_logs（spec 已规定） |
| ad-hoc workflow 升级冲突（用户改过 yaml） | 中 | 沿用现有 autopilot workflow sync 路径，dry-run + --apply |
| 删 /api/repos 后用户老脚本 break | 中 | release notes 显著标注；直接删不留 410（理由见 §6.4）；web client 同发布升级 |
| worktree branch 名冲突 | 低 | 已设计 -2 / -3 后缀重试 |
| 多 task 并发 worktree 在同一 codebase | 中 | git worktree 本身允许多 branch 并存；但若两 task 改同一文件需要 push 时会撞，由用户自己处理（不在引擎职责） |
| ad-hoc task 无 requirement 导致 task_logs / events 缺关联 | 低 | tasks.requirement_id 允许 NULL（已存在）；UI 上 ad-hoc task 单独分一组显示 |

---

## 9. 验收标准

每个 Phase 合并前必须通过：

- bun test                — 0 fail
- bun run typecheck       — 通过
- bun run build:web       — 改了前端时（Phase 4 ad-hoc 入口必跑）
- bun run smoke-test      — 12 步 CLI 烟雾测试
- bun run coverage:rpc    — 检查死代码 + 反渗候选

各 Phase 特定测试见 §7。整体合并后跑一遍人工 e2e：

1. autopilot init → 看到 ad-hoc 工作流自动装好。
2. autopilot run "在 workspace 写个 hello.md" → 任务起来、跑完、windows toast 弹窗。
3. autopilot codebase create foo /tmp/foo-repo → autopilot run -c foo "..." → workspace 是 worktree（git worktree list 能看到）。
4. 起一个长 task，autopilot task send-prompt <id> "再补一句" → 看到 task.extra.pending_prompts 增加 + 下轮 agent.run 消费。
5. 创建 mode=send_prompt 的 schedule，等到 fire 时间，验证 prompt 被注入。
6. requirements 页：评论线程显示统一了 question + feedback，github review 留 from_role=github 标识。

---

## 10. 开放问题（合并 spec 后再讨论）

- ad-hoc workflow 是否需要 gate phase（agent 跑完 → 用户审 → 继续）？当前设计是单 phase 直接 done，简单优先。
- pending_prompts 是否要持久化成独立表方便审计？当前放 extra JSON 足够，但分析查询不便。
- worktree branch 推到远端的策略：默认不推；后续可能加 workflow.workspace.auto_push: true。
- notify driver 是否应支持每个 task 维度的「静音 / 重要 only」？v1 用全局 on_events 简化，留 v2。

### 已决议（评估过、明确选了某条路）

- **ad-hoc 入口不传 codebase 时走空目录 workspace**：有意选择 — 用户场景是「让 agent 不依赖现有代码生成产物」（写文档 / 生成脚本 / 实验代码）。强制 codebase 会堵最低门槛入口；提供 `--cwd` 选项又增复杂度。空目录 + 用户需要时显式传 `-c <codebase>` 走 worktree 是最干净的两档心智。

### 3.10 prompt-phase handoff 协议（OMC 借鉴 — 部分采纳）

**动机**：

- ts 实现的 phase 函数（如 examples/workflows/dev/workflow.ts）已经手动写 plan.md / plan_review.md / dev_report.md / code_review_report.md，下一 phase 显式 readFileSync —— **开发者自己组织产物比强协议更灵活**，不强制。
- 但 prompt-driven phase（prompt_quick、§3.7 新增的 ad-hoc）只落 agent_output.md，下一 phase 的 prompt 里**没人塞上一 phase 的结论**，agent 拿到的上下文是空白。这是真缺口。
- OMC 的 5 字段（Decided / Rejected / Risks / Files / Remaining）太严，autopilot 用 reject trigger 表达 Rejected，独立字段冗余。**精简为 4 字段，只对 prompt phase 强制**。

**设计**：

1. `workflow.yaml` phase 加可选字段：

   ```yaml
   phases:
     - name: draft
       prompt: |
         ${REQUIREMENT}
       handoff: true        # 默认 false 保持兼容；true 时启用 handoff 协议
     - name: polish
       prompt: |
         请基于上一步草稿润色：
         ${HANDOFF}         # 内置变量：拼接所有上游 handoff.md
   ```

2. prompt-runner.ts 升级（影响 `src/core/prompt-runner.ts:79 makePromptRunner`）：

   - phase 启动前，从所有**前序 phase**的 `workspace/<NN-phase>/handoff.md` 拼成 `${HANDOFF}` 字符串（按 phase 顺序，每段加 `## <phase label>` 分割）。
   - 占位符替换扩展到 `${HANDOFF}` / `${HANDOFF_<PHASE_NAME>}`（按需取单个）。
   - 若 phase.handoff=true，在 prompt 末尾**自动追加** handoff 指令片段（中文，固定）：
     ```
     ## Handoff（必填，给下一阶段读）

     在 agent_output.md 末尾输出以下 4 段，每段非空（无内容写「无」），用 markdown 二级标题分隔：
     - ## Decided      做了什么决定（关键选择 + 理由）
     - ## Files        关键文件路径（绝对 / 相对皆可）
     - ## Risks        给下一阶段的风险与注意点
     - ## Remaining    本阶段未完成 / 留给后续的事
     ```
   - 阶段函数跑完后，prompt-runner 按下面的**逐段独立解析 + 占位**策略生成 handoff.md（见下小节）。

**handoff 解析容错策略**（替换早期版本「4 段缺失 → 原样写 agent_output 兜底」的过宽行为；缺一段时下游 agent 拿到残缺 context 不自知，这次明确细化）：

1. **逐段独立解析**：Decided / Files / Risks / Remaining 各自 grep 一遍 `## <Name>\n…(?=\n## |\Z)` 正则。能解到的段原样保留；解不到的段写「无（agent 未输出）」占位，**不影响其他段**。这样残缺只表现在缺的那段，不会污染好的段。
2. **4 段全缺的兜底**：依然写 handoff.md（4 行全是「无（agent 未输出）」），同时：
   - emit `phase:handoff-incomplete` 事件，payload `{ taskId, phase, missing: ["Decided","Files","Risks","Remaining"] }`
   - task_logs 写一条 WARN
   - **继续 transition**，不阻断 phase 完成
3. **下游降级提示**：拼 `${HANDOFF}` 时检测每段值，若上游 phase 的 4 段全是占位，prompt 末尾**自动追加一句**：「注意：上一阶段未输出结构化 handoff，请基于 agent_output.md 全文判断」，让下游 agent 知道要降级处理（自己去 read agent_output.md 而非依赖结构化 handoff）。
4. **文件缺失** vs **段缺失**：handoff.md 写入失败（IO 错误）单独 log.warn，不影响 phase transition；下游用 `${HANDOFF}` 时找不到对应 handoff.md 直接跳过该 phase 段，不发降级提示（因为不是 agent 输出问题）。
5. **可选 v2**：now-aggregator 新建 source `handoff-incomplete` 把 `phase:handoff-incomplete` 事件提到 Now 卡，提示用户介入。**不强制 Phase 6 实现**，列在 §10 follow-up。


**为什么不强制 ts phase 走 handoff**：

- ts phase 已经有完整控制权（readFileSync 任意文件），强加 4 字段反而降低表达力。
- dev workflow 的 plan.md / dev_report.md 是结构化报告，不应被压扁成 4 字段。
- 真正受益的是「用户只写 yaml prompt，没人组织产物」的零代码工作流。

**影响面**：

- `src/core/prompt-runner.ts`：新增 handoff 解析 + ${HANDOFF} 占位符。
- `src/core/registry.ts`：phase yaml schema 加 `handoff?: boolean` 字段透传。
- `examples/workflows/prompt_quick/workflow.yaml`：示范开启 handoff: true。
- `docs/workflow-development.md`：新增「prompt phase handoff 协议」一节。
- 不动 ts phase 函数路径。

**不在范围**：

- 复杂模板化 handoff（如 JSON schema 强类型）；保持 markdown 自由。
- handoff 跨 task 复用（如 task A 的 handoff 给 task B 用）；超出 phase 间通信。

### 3.11 Agent 别名（OMC role routing 借鉴 — 部分采纳）

**动机**：

- autopilot 已有「agent 命名 + 三层覆盖」（`AGENT_DEFAULTS` / workflow.agents[] / RunOptions），role 概念基本等价于 agent 命名。OMC canonical roles list 对 autopilot 是冗余。
- 但跨 workflow 的同义命名痛点真实存在：dev 用 `reviewer`，未来 quality workflow 写 `code-reviewer`，两者都想复用同一全局 agent 但名字不同 → 现在只能在每个 workflow.yaml 的 agents[] 里复制粘贴。**别名机制解决这条**。
- **明确拒绝 provider fallback chain**：详见 §10.X 决策记录。
- **明确拒绝 tier (HIGH/MEDIUM/LOW)**：详见 §10.X 决策记录。

**设计**：

#### 3.11.1 Agent 别名

`config.yaml` 新增 `agent_aliases` 段（可选）：

```yaml
agent_aliases:
  code-reviewer: reviewer
  harsh-critic: reviewer
  planner: architect
```

`resolveAgentConfig`（`src/agents/registry.ts:45`）解析逻辑加一步：

1. 给定 agentName，先查 `loadAgentAliases()`。命中 → 用 alias target 名继续解析（但 `merged.name` 保留原名，便于日志与 UI 显示用户视角的 role）。
2. 别名链式禁止：`a → b → c` 拒绝，只允许一跳；多跳 throw 配置错误。
3. workflow.yaml `agent: code-reviewer` 时，先看 workflow.agents[] 是否有 `name: code-reviewer` 条目（有则用，alias 不生效），否则按 alias 走。

#### 3.11.2 不引入 tier

不在 yaml / config 引入 HIGH/MEDIUM/LOW 抽象层。详见 §10.X 决策记录。

**影响面**：

- `src/core/config.ts`：加 `loadAgentAliases()` + `agent_aliases` schema。
- `src/agents/registry.ts:45 resolveAgentConfig`：先查 alias、链式禁多跳。
- docs/workflow-development.md：新增「agent 别名」小节。

**不在范围**：

- canonical role list 强制（OMC 那 15 个固定 role）。autopilot 用户自由命名。
- provider fallback chain（CLI 缺失自动切换）。autopilot fail loudly，让用户修配置。
- tier 模型抽象。
- role 跨 provider 自动选最优（OMC 也没做，是配置的事）。

---

## 4.5 §3.10 / §3.11 的数据模型增量

**§3.10 handoff 协议**：

- 无 schema 变更。仅 workflow.yaml 加可选 `phases[].handoff: boolean` 字段，registry 加载时透传。
- 产物 `handoff.md` 落 workspace/<NN-phase>/handoff.md（与 agent_output.md 同目录），与 archivePhaseArtifacts 自动产物对齐；归档逻辑不动。

**§3.11 agent 别名**：

- 无 DB schema 变更。配置层扩展 `config.yaml`：
  ```yaml
  agent_aliases:
    code-reviewer: reviewer
    harsh-critic: reviewer
  ```
- 无新增事件类型。

---

## 5.6 §3.10 / §3.11 的 API 增量

**CLI**：

- `autopilot agent list` 输出新增 `alias_of` 列（展示别名指向）。

**WS RPC**：

- `agents.list` 返回每条 agent 加 `alias_of?: string`。
- 无新增事件类型。

**workflow.yaml**：

- `phases[].handoff?: boolean`（§3.10）
- `agent: <name>` 字段值现在可以是 alias（§3.11）

---

## 7.6 §3.10 / §3.11 的阶段拆分

### Phase 6 — prompt-phase handoff 协议（§3.10）

- 改 src/core/prompt-runner.ts：扩展 expandPromptTemplate 加 ${HANDOFF}；makePromptRunner 末尾追加 handoff 指令、跑完后解析 4 段写 handoff.md。
- 改 src/core/registry.ts phase yaml schema 透传 handoff 字段。
- 改 examples/workflows/prompt_quick/workflow.yaml 开 handoff: true 演示。
- 改 examples/workflows/ad-hoc/workflow.yaml（§3.7 新建的）—— 单 phase 不需要 handoff，默认 false 即可；但若用户拓展为多 phase ad-hoc 时一键开。
- **验收**：`tests/prompt-runner-handoff.test.ts` 覆盖 4 段解析 + ${HANDOFF} 拼接 + 缺段降级 warn。

### Phase 7 — agent 别名（§3.11）

- 改 src/core/config.ts 加 loadAgentAliases schema。
- 改 src/agents/registry.ts resolveAgentConfig 加 alias 解析（单跳，多跳拒绝）。
- 改 web UI useApi.ts agents.list response 类型加 `alias_of?: string`（设计交给 designer 决定 alias_of badge 样式）。
- **验收**：`tests/agent-alias.test.ts` 覆盖单跳成功 + 多跳拒绝 + workflow.agents[] 优先于 alias。

**Phase 6 / 7 依赖关系**（修正早期「6/7 互相独立可并行」的疏漏）：

- **Phase 6 必须在 Phase 5 之后做** —— 两者同改 `src/core/prompt-runner.ts`（Phase 5 加 pending_prompts 自动消费循环，Phase 6 加 ${HANDOFF} 占位符 + handoff 解析）。并行会合并冲突 + 语义叠加（先做 6 后做 5 时，5 的 pending_prompts 消费循环需要把 6 的 handoff 解析嵌进去），先 5 后 6 串行最稳。
- **Phase 7 与所有其他 Phase 独立**，可与 Phase 5 或 Phase 6 任一并行（只改 `src/core/config.ts` + `src/agents/registry.ts`，无文件交叠）。
- 原 Phase 1-5 不受 Phase 6 / 7 影响。

---

## 10.X 关键决策记录（OMC 借鉴评估）

以下是「考虑过但拒绝 / 部分采纳」的项，写明理由以免未来重新评估时重新踩同一条路。

### 拒绝：`max_fix_loops` / `retry: { max: N, on: failed }` 字段（OMC Verify-Fix Loop）

**OMC 做法**：team-verify 失败 → auto team-fix → 回 team-exec，超 max_fix_loops（默 3）→ terminal failed。

**为什么 autopilot 不抄**：

1. **能力已存在**：`reject:` yaml 语法糖 + `max_rejections`（state-machine.ts + registry.ts:117-148 + dev workflow.ts 实测）已经支持"reviewer 判定 REJECT → 自动跳回前 phase 重跑 → 达 max_rejections 强制 cancel"。OMC max_fix_loops 抄过来 = 改名。
2. **语义反模式风险**：一个 phase 重复失败 3 次本质是 spec 问题不是临时故障，autopilot 不应通过新字段美化"自动隐藏失败"。dev workflow 目前 max_rejections: 10 已经过宽，下次应该是**降默认值 + 触顶 notify 强 surface**，而不是引入新的 retry 字段诱导用户加大重试数。
3. **历史教训**：dogfood-bug7（reject 重做轮 developer 看到 commit 已存在就回答"任务已完成"反复 reject）说明 auto-retry 本身就会放大 bug，再加抽象层只是更糟。

**Follow-up（不在本 spec 范围）**：单独 PR 把 dev workflow 的 max_rejections 默认值从 10 降到 3，触顶时强制 notify driver（§3.5）emit task-failed 事件 + now-aggregator 加 P0 卡片要求人介入。

### 拒绝：HIGH / MEDIUM / LOW tier 模型抽象（OMC tierModels）

**OMC 做法**：用户配 `model: "HIGH"`，provider tierModels 映射 HIGH→claude-opus、MEDIUM→sonnet、LOW→haiku。升级模型只改 tierModels 一处。

**为什么 autopilot 不抄**：

1. **autopilot 已有等价机制**：`PROVIDER_DEFAULTS.<provider>.default_model`（src/core/provider-defaults.ts）是单一升级入口；agent 不写 model 时自动用 default_model。升级 default_model = OMC 升级 tierModels HIGH。
2. **抽象层套娃**：HIGH/MEDIUM/LOW 是又一层别名，用户脑子里要维护「我要的 model → tier name → 实际 model」三跳映射，而不是直接写 model 名一跳。autopilot 用户群（开发者）能直接选 model，不需要这层 marketing 抽象。
3. **多 provider 时 HIGH 含义不一致**：claude HIGH = opus，gemini HIGH = pro，定义不可比；强行抽象误导用户。

**结论**：保持现状——用户在 agent.model 写 provider 原生 model 名；想跟随升级就**不写 model**，靠 PROVIDER_DEFAULTS 兜底。

### 拒绝：canonical role list（OMC 那 15 个固定 role）

**为什么不抄**：autopilot 用户在 AGENT_DEFAULTS + workflow.agents[] 自由命名（coder / reviewer / clarifier / architect / developer / writer / critic ...），强制 canonical list 是 lock-in。`agent_aliases`（§3.11）按需引入别名，比 canonical list 灵活。

### 部分采纳：handoff 协议只用于 prompt phase（§3.10）

ts phase 已有完全控制权（plan.md / dev_report.md 等结构化产物），强加 4 字段降低表达力。仅对零代码（纯 yaml prompt）路径生效。

### 部分采纳：role routing 简化为 agent 别名（§3.11）

去掉 OMC 的 canonical roles + tier + fallback chain，只保留别名归一化这一项最有用的能力。

### 拒绝：provider fallback chain（CLI 缺失自动切换 provider）

**OMC 做法**：agent 配置的 provider CLI 不可用时，按 `fallback_provider` 或全局 `fallback_order` 切到另一家 provider，重新合并 model = 新 provider 的 default_model，emit `agent:fallback` 事件让 UI 显示警告。

**为什么 autopilot 不抄**：

1. **fail loudly 优于 silent switch**：CLI 不可用是配置或环境问题（没装 codex / 没登录 claude / 旧版本），应该让用户立即修，不该默默切到另一家 provider 跑出语义完全不同的结果。用户配 `gpt-5 (codex)` 是因为想要 codex 的特性，自动 fallback 到 claude sonnet 跑完才发现是错的，**问题排查成本远大于直接报错**。
2. **autopilot 已有 surface 机制**：`src/agents/cli-status.ts` 的 `detectProviderCli` 能在 agent 启动前探测 CLI 可用性，可以走 startup-time fail loud，根本不该有运行时 fallback 路径。
3. **单一职责**：autopilot 引擎不负责「挑一个能跑的 provider」，那是用户配置层的职责。引擎的职责是按用户配置执行；用户配错了，引擎要 surface 错误，不要替他做主。
4. **fallback chain 是隐藏配置错误的抽象**：和 §10.X 拒绝 `max_fix_loops` 同一类反模式——表面便利，本质放大问题。

**结论**：保持现状——createAgent 解析出 provider 后，CLI 不可用直接 throw 带清晰错误信息（指向 cli-status 的修复建议），不引入 fallback_provider / fallback_order 任何配置项。
