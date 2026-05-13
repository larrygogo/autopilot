# 需求澄清重设计：spec_md 持续修订 + 一问一答 设计文档

**日期**：2026-05-13
**状态**：设计已批准，待实现
**涉及模块**：daemon clarifier (`src/daemon/requirement-clarifier.ts`)、数据模型 (`src/migrations/`)、daemon 路由 (`src/daemon/routes.ts`)、CardSource (`src/core/card-sources/`)、Web UI (`src/web/src/pages/RequirementDetail.tsx`)
**设计方法**：Brainstorming skill 生成，5 轮多选澄清 → 4 段 design 逐节确认

---

## 1. 背景与目标

### 1.1 问题陈述

当前 `requirement-clarifier` 一次性 dump 一批问题（5-10 个）让用户回答，且 **`spec_md` 字段几乎不在用**（req-003 spec_md 长度为 0）。所有信息散落在 `requirement_questions` / `requirement_question_replies` 两张表的时间线里，用户没法"一眼看到完整的需求"，每次提需求都被 AI 一次扔出的问题清单淹没。

具体痛点（来自 dogfood 反馈）：

1. AI 一次问 5-10 个，用户面对压力大；
2. 后续轮次的提问没用上前面回答的答案，可能重复问已澄清的事；
3. spec_md 一直是用户最初写的初稿，澄清过程的事实没沉淀进去；
4. /now 主屏因此堆满 question 卡（一个需求 N 张卡，曾出现 18 张幽灵问题）。

### 1.2 目标

将澄清模型从「批量预生成 + 散落 Q&A」改为「**spec_md 持续修订 + 动态一问一答**」：

1. **spec_md 是单一权威需求文件**：澄清过程中持续演进，AI 该改改、该加加、该删删
2. **一问一答**：clarifier 每轮只 surface 1 个 question，user 回答后 AI 决定下一个或结束
3. **修订历史可见**：每次 spec_md 变更都记录 diff，user 可回溯查看
4. **/now 卡片去重**：一个需求最多 1 张"等你回答"卡，副标题直接显示问题原文

### 1.3 非目标（YAGNI）

- 不做 diff 的"语义级"识别（"该章节加了 X"NLP 判断）—— 用 text-level diff，第一版直接 before/after 全文展示
- 不支持多轮 spec_md 回退（不让用户"选第 3 轮版本作为当前版"），只浏览历史
- 不重做 RequirementDetail 的 PR feedbacks 区（独立功能）
- 不引入 markdown 富文本编辑器（用 `<pre>` 显示 + 普通 textarea 编辑）

### 1.4 设计决策汇总

通过 5 轮澄清问题确定：

| 决策点 | 选择 | 原因 |
|---|---|---|
| spec_md 演进模式 | 修订（不重写、不只追加） | 用户原话"不对的要改、不完整的要追加" |
| 修订是否需审批 | A: AI 直接改 + 留 diff 历史 | 流畅，可回溯 |
| 问问题节奏 | B: 动态决策（每轮 1 次 AI 调用决定下一个 or 结束） | 越聊越懂、不问废问题 |
| /now 卡片去重 | B: 1 需求 1 卡，副标题显示问题原文 | 信息密度高、不堆积 |
| 澄清期 spec_md | B: 只读，AI 全权维护；awaiting_approval 后解锁 | 边界清晰、避免双方编辑冲突 |

---

## 2. 数据模型变更

### 2.1 新表 `spec_revisions`（migration 012）

```sql
CREATE TABLE spec_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  requirement_id TEXT NOT NULL,
  before_md TEXT NOT NULL,
  after_md TEXT NOT NULL,
  summary TEXT,                              -- AI 给出的本轮修订摘要
  source TEXT NOT NULL,                      -- 'clarifier' / 'user-edit' / 'system'
  triggered_by_question_id TEXT,             -- 触发本次修订的 question id（nullable）
  created_at INTEGER NOT NULL,
  FOREIGN KEY (requirement_id) REFERENCES requirements(id) ON DELETE CASCADE
);
CREATE INDEX idx_spec_revisions_req ON spec_revisions(requirement_id, created_at);
```

每次 spec_md 变化都写一条；user 可在 RequirementDetail 看时间线 + 每条 diff。

### 2.2 `requirements.active_question_id`（migration 013）

```sql
ALTER TABLE requirements ADD COLUMN active_question_id TEXT
  REFERENCES requirement_questions(id) ON DELETE SET NULL;
```

标识"当前等用户回答的那个问题"。语义：

- 进入 `clarifying` 状态、clarifier 决定问下一个时 → 设为新 question id
- 用户答完当前问题、clarifier 触发下一轮时 → 设为下一个 question id（或 NULL）
- AI 决定 done=true 时 → 设为 NULL + 进 awaiting_approval
- 离开 clarifying 状态时 → 始终为 NULL

### 2.3 数据迁移（migration 014）

把现有 `status='clarifying'` 的 requirement 的全部 open questions 标 resolved（不一致状态的兼容）：

```sql
UPDATE requirement_questions
  SET status='resolved', resolved_at=(CAST(strftime('%s','now') AS INTEGER)*1000)
  WHERE status='open'
    AND requirement_id IN (SELECT id FROM requirements WHERE status='clarifying');
```

迁移后 active_question_id 默认 NULL；用户下次打开 RequirementDetail 时前端检测到 `status=clarifying && active_question_id=NULL` → 调 `POST /api/requirements/:id/retry-clarify` 重新触发新模式。

---

## 3. clarifier B 模式行为

### 3.1 触发时机

三种事件触发 clarifier 跑一轮：

| 事件 | 条件 | 行为 |
|---|---|---|
| 需求进入澄清 | `requirement:status-changed` to=`clarifying` | 跑第一轮，spec_md 通常是 user 初稿（可空） |
| 用户答完当前问题 | `question:resolved`（已有事件） | 跑下一轮 |
| 用户从审批打回 | `requirement:status-changed` from=`awaiting_approval` to=`clarifying` | 跑一轮，可能直接 done=true |
| API 显式触发 | `POST /api/requirements/:id/retry-clarify` | 跑一轮 |

### 3.2 单轮 clarifier 算法

```
Input (prompt 构造):
  - 项目上下文（name, description, codebase CLAUDE.md/README 摘录）
  - 需求标题
  - 当前 spec_md
  - 历史 Q&A（已 resolved 的 question + 回答，按时间序）

AI 调用 (使用现有 callClaude 机制；输出严格 JSON):
{
  "new_spec_md": "...",          # 修订后的完整 spec_md（保留正确 / 改错 / 加缺）
  "summary": "本轮修订：加了 X 章节、修正了 Y",
  "next_question": {              # done=false 时必填
    "agent_text": "...",
    "suggestions": ["选项 A", "选项 B"]  # 2-4 个，可空
  } | null,
  "done": false                    # true = 信息足够、可入队
}

后端处理:
  1. JSON 校验失败 → 重试 1 次，仍失败 → emit requirement:clarifier-error
  2. new_spec_md ≠ current → INSERT spec_revisions + UPDATE requirements.spec_md
  3. done = true →
       a. UPDATE requirements SET active_question_id = NULL
       b. setRequirementStatus('awaiting_approval')
  4. done = false →
       a. createQuestion(next_question) → qid
       b. UPDATE requirements SET active_question_id = qid
       c. emit requirement:active-question-changed { id, question_id: qid }
```

**Prompt 关键指令**（要在 AI 提示词里强调）：

- "修订要精确：保留原文中正确的内容；只改不对的、只加缺失的"
- "不要重写整篇 spec_md"
- "输出严格 JSON 格式，不要任何前后多余文本"
- "如果 spec_md 与历史 Q&A 已足够明确实现需求，输出 done=true 不再提问"
- "下一个问题必须基于当前 spec_md 和已有 Q&A，不要重复问已澄清的事"

### 3.3 用户强制结束澄清

新 endpoint：`POST /api/requirements/:id/finish-clarification`

```typescript
// 后端实现要点
1. 若 active_question_id 非 NULL → resolveQuestion(active_question_id)
2. UPDATE requirements SET active_question_id = NULL
3. setRequirementStatus(awaiting_approval)
```

前端在 RequirementDetail 当前问题区右上角加按钮 `[✓ 够了，直接审批]`。

### 3.4 错误恢复

- AI 调用失败 / 输出非合法 JSON / 超时 → 重试 1 次
- 仍失败 → **不改 spec_md、不创建 question**；emit `requirement:clarifier-error { id, reason }` + log 错误
- /now 出 P0 异常卡（见 §4.2），用户可点 [重试]（调 retry-clarify）

### 3.5 新增 / 复用事件

| 事件类型 | 时机 | payload |
|---|---|---|
| `requirement:active-question-changed`（新） | active_question_id 变化时 | `{ id, question_id: string \| null }` |
| `requirement:spec-revised`（新） | spec_md 变化时（一次修订完成） | `{ id, revision_id }` |
| `requirement:clarifier-error`（新） | clarifier 跑挂时 | `{ id, reason }` |
| `requirement:status-changed`（已有） | 状态切换 | （不变） |
| `requirement:questions-updated`（已有） | question 内容变化 | （不变） |

protocol.ts 加这 3 个事件类型 + `getChannelsForEvent` 已经按 `requirement:` 前缀路由到 `requirement:*`，无需改动。

---

## 4. /now CardSource + 前端 RequirementDetail 改造

### 4.1 open-question CardSource 改造

不再 scan 整张 `requirement_questions`，改为只关心 `requirements.active_question_id IS NOT NULL`：

```typescript
// src/core/card-sources/open-question.ts (重写)
function listActiveQuestions(): Array<{ req_id: string; req_title: string; q_id: string; agent_text: string; created_at: number }> {
  return getDb().query(`
    SELECT r.id AS req_id, r.title AS req_title,
           q.id AS q_id, q.agent_text, q.created_at
    FROM requirements r
    INNER JOIN requirement_questions q ON q.id = r.active_question_id
    WHERE q.status = 'open' AND r.status = 'clarifying'
  `).all();
}
```

**Card 形态变化**：

- `id` 从 `open-question:<qid>` 改为 `open-question:<req_id>`（按需求，1 需求 1 卡）
- `title`：仍为 `AI 提了个问题`
- `subtitle`：直接显示当前问题原文（截断 100 字）+ requirement_id
- `actions`: `[回答]` href → `/requirements/<req_id>`

**订阅事件**：

- `requirement:active-question-changed`（新）—— 主要触发器
- `requirement:status-changed` —— 进 / 出 clarifying

旧 source 维护的 `known: Set<string>` 内存 diff 逻辑不再需要（一个 req 最多 1 卡，按 req_id 直接 upsert）。

### 4.2 新增 CardSource: `clarifier-error`

```typescript
// src/core/card-sources/clarifier-error.ts (新建)
- name: "clarifier-error"
- subscribes: ["requirement:clarifier-error"]
- scan(): 返回 []（瞬时通知，不持久化历史）
- onEvent: 产 P0 异常卡
  - id: `clarifier-error:<req_id>`
  - title: `⚠ Req-<id> 澄清出错`
  - subtitle: event.payload.reason 摘要（最长 80）
  - actions:
    - [查看] href → `/requirements/<req_id>`
    - [重试] invoke POST `/api/requirements/<req_id>/retry-clarify`
  - dismissable: false
```

### 4.3 RequirementDetail 页面新布局

```
┌────────────────────────────────────────────────────────────────────┐
│ ← 返回    需求 req-003 · 设计一个 LOGO       [状态: clarifying]  │
├────────────────────────────────────────────────────────────────────┤
│                                                                    │
│ ─ 当前等你回答 ──────────────────  [✓ 够了，直接审批]            │
│  具体选用哪个 SSH 隐喻作为主体图形？                              │
│  建议: [终端光标] [钥匙图标] [加密锁]   ← 点选填入输入框          │
│  ╭───────────────────────────────────────────╮                    │
│  │ 回答输入框（textarea）                       │   [发送]          │
│  ╰───────────────────────────────────────────╯                    │
│                                                                    │
├────────────────────────────────────────────────────────────────────┤
│ 📄 需求规约 · SPEC          [🔒 AI 维护中]  [📜 修订历史 12]      │
│  (clarifying 期：渲染 markdown，只读)                              │
│  (awaiting_approval+：textarea 可编辑 + [保存])                    │
├────────────────────────────────────────────────────────────────────┤
│ 💬 历史问答 (8)                                       [展开 ▾]    │
└────────────────────────────────────────────────────────────────────┘
```

### 4.4 关键改造点（基于现有 `src/web/src/pages/RequirementDetail.tsx`）

| 现有 | 改造为 |
|---|---|
| spec_md `<Textarea>` 始终可编辑 | clarifying 期 readonly + markdown 渲染 + `🔒 AI 维护中` 徽章；awaiting_approval+ 期可编辑 |
| questions 列表混杂展示 active + resolved | 拆为：顶部"当前等你回答"区（仅 active_question_id 那个） + 底部"历史问答"区（已 resolved，折叠默认） |
| 无修订历史 | 右上角加 `[📜 修订历史 N]` 按钮 → 弹 Sheet（侧边抽屉）展示 spec_revisions 时间线，点条目展开 diff |
| 无强制结束按钮 | 当前问题区右上角 `[✓ 够了，直接审批]` |

### 4.5 markdown 渲染（第一版简化）

不引入 `react-markdown` 等新依赖。clarifying 期 spec_md 用 `<pre className="whitespace-pre-wrap font-mono text-sm">` 显示，保留换行 + 等宽字体。awaiting_approval 期同 textarea 可编辑。后续可升级到真正的 markdown 渲染。

### 4.6 修订历史 Sheet

新组件 `src/web/src/components/SpecRevisionsSheet.tsx`：
- 列表展示：`{created_at} · {source 中文标签} · {summary}`
- 点条目展开 → 简化 diff 视图（before / after 上下展示，全文，第一版用 `<pre>` 等宽对比；后续可升级 `diff` 库高亮）

API：`GET /api/requirements/:id/spec-revisions` → `{ revisions: SpecRevision[] }`

### 4.7 数据流（完整链路）

```
用户在 RequirementDetail 点 [发送]
  → POST /api/requirements/<id>/questions/<qid>/replies { author_role:'user', text }
  → POST /api/requirements/<id>/questions/<qid>/resolve
  → 后端 emit question:resolved
  → clarifier 触发跑下一轮
  → AI 调用 → 返回 { new_spec_md, summary, next_question?, done }
  → 若 spec 变 → INSERT spec_revisions + UPDATE requirements.spec_md
                emit requirement:spec-revised
  → done=true → setRequirementStatus(awaiting_approval) + active_question_id=NULL
  → done=false → createQuestion + UPDATE active_question_id=qid
                 emit requirement:active-question-changed
  → 前端 WS 订阅 requirement:* 收到 → useState 刷新
     - active question 切到新问题（或消失）
     - spec_md 重新拉
     - 修订历史角标 +1
```

---

## 5. 边界条件与错误恢复

| 场景 | 行为 |
|---|---|
| AI 调用失败 / 返回非合法 JSON | 重试 1 次；仍失败 emit clarifier-error → /now 卡 |
| 用户答完但 AI 决定 done=true | 自动进 awaiting_approval，无需用户额外操作 |
| 用户从 awaiting_approval 打回 clarifying | 触发新一轮 clarifier；保留所有历史 Q&A |
| 用户从 awaiting_approval 编辑 spec_md | 不触发 clarifier；user 改的就是终稿（想再问要打回 clarifying） |
| clarifying 中用户关闭浏览器 / 断网 | clarifier 后端事件驱动、不依赖前端；用户回来 WS 同步状态 |
| 已 resolved 的 question 用户想修改 | 不允许（只读历史）；想纠正请通过当前问题或打回澄清 |
| 迁移后老 requirement 状态 clarifying 但 active=NULL | 前端检测到该状态时调 retry-clarify 触发新模式 |

---

## 6. 实施切分

按 brainstorming 决策（实施粒度选择 B = 后端先行 + 前端跟进），分 2 个 PR：

### PR-A：后端 + 数据模型 + CardSource 改造

**范围**：
- Migrations 012-014：spec_revisions 表 + active_question_id 字段 + 现有数据清理
- protocol.ts：新增 3 个事件类型（`requirement:active-question-changed`、`requirement:spec-revised`、`requirement:clarifier-error`）
- clarifier 重写：B 模式（动态决策、JSON 输出、修订 spec_md、错误恢复）
- requirements.ts：新增 `finishClarification` / `retryClarify` helper + spec_revisions CRUD
- 新 daemon routes：`POST /api/requirements/:id/finish-clarification`、`POST /api/requirements/:id/retry-clarify`、`GET /api/requirements/:id/spec-revisions`
- open-question CardSource 重写（按 req_id 而非 q_id）
- 新 CardSource: clarifier-error
- 配套测试

**验证**：PR-A 落地后即可通过现有前端 dogfood 后端行为（前端仍是旧布局，但行为已新 —— 每个 req 只有 1 个 open question；现有 Q&A 时间线仍可见、可答；只是 spec_md 在 clarifying 期也会自动变化，user 可以"凭手感"看到）。

### PR-B：前端 RequirementDetail 改造

**范围**：
- RequirementDetail 重布局：当前问题区（醒目顶部）+ spec_md 区（带状态徽章）+ 历史 Q&A 区（折叠）
- spec_md 在 clarifying 期 readonly + `<pre>` 渲染；awaiting_approval+ 期 textarea 编辑
- 新组件 SpecRevisionsSheet：抽屉式修订历史 + diff 查看
- `[✓ 够了，直接审批]` 按钮 → 调 finish-clarification
- WS 订阅 `requirement:active-question-changed` / `spec-revised` 实时刷新
- 配套类型 / API 方法（useApi.ts 加 `listSpecRevisions` / `finishClarification` / `retryClarify`）

**验证**：完整 7 条用户故事（§4.4）全部跑通。

---

## 7. 验收

7 条用户故事（PR-A + PR-B 整体）：

| ID | 场景 | 验证什么 |
|---|---|---|
| **US-1** | 新需求进澄清 → 看到 1 个问题 → 答完看到下一个；spec_md 实时演进 | 一问一答 + spec_md 修订核心链路 |
| **US-2** | 库里多个需求都在 clarifying → /now 每需求 1 张卡（不再幽灵） | 卡片去重 |
| **US-3** | 答完几轮后点[修订历史] → 看到时间线 + 每条 diff | 修订历史可视化 |
| **US-4** | clarifying 期点[够了，直接审批] → spec_md 解锁、当前问题消失、可审批入队 | 强制结束链路 |
| **US-5** | clarifier AI 调用故意失败 → /now 出 P0 异常卡 → [重试] 恢复 | 错误恢复链路 |
| **US-6** | awaiting_approval 打回 clarifying → 触发新一轮、保留历史 Q&A | 重新澄清链路 |
| **US-7** | 迁移后老的 clarifying 需求打开 → 自动进入新模式（出现新问题） | 数据迁移兼容 |

反向警示（出现这些迹象说明没做对）：

- 一个需求 /now 出多张 open-question 卡 → active_question_id 设计或 source 重写没做对
- spec_md 在 clarifying 期被用户改了 → readonly 没生效
- 答完问题后 spec_md 没变 → clarifier prompt 出问题、JSON 解析失败、或 update 链路断
- /now 卡片副标题不显示问题原文 → buildCard 模板未对齐新 schema

---

## 8. 风险与缓解

| 风险 | 严重度 | 缓解 |
|---|---|---|
| AI 修订 spec_md 改坏原意 / 引入幻觉 | 中 | spec_revisions 表保留 before/after 全文；用户可手动从历史复制旧版到 spec_md（awaiting_approval 期）；prompt 强调"保留原文正确部分" |
| AI 返回非合法 JSON 高频出现 | 中 | 重试 1 次 + clarifier-error CardSource 兜底；prompt 严格示例；考虑用 JSON-mode（如果 claude CLI 支持）或 schema validation |
| 现有用户库里 active_question_id NULL 但 status=clarifying 不一致 | 低 | 迁移 014 + 前端 retry-clarify 检测自愈 |
| 一次 AI 调用慢（每轮答完都要等 5-15 秒） | 中（体感问题） | 前端答完立即显示"等 AI 思考中..." spinner；考虑 streaming（如果 CLI 支持），但第一版不做 |
| spec_md 不断增长导致 prompt 超 context window | 低 | 第一版不限长（claude 200K context 够用）；后续 spec_md > 50K 字时考虑摘要+原文分段 |
| 用户多 tab 打开同一 requirement，并发触发 retry-clarify | 低 | clarifier 内部加 in-flight 锁（同一 req 同时只跑一轮）；重复请求等待第一个结果 |
| 修订历史无限增长占用空间 | 低 | 长期可加 retention（保留最近 100 条）；第一版不限 |

---

## 9. 设计过程记录

本设计经过 5 轮多选澄清问题确定方向：

1. **spec_md 演进模式** → 用户原话"不对的要改、不完整的要追加"——确立修订模式
2. **修订是否需审批** → 选 A: AI 直接改 + 留 diff 历史
3. **问问题节奏** → 选 B: 动态决策每轮 1 次 AI 调用
4. **/now 卡片去重** → 选 B: 1 需求 1 卡，副标题显示当前问题原文
5. **澄清期 spec_md** → 选 B: 只读，AI 全权维护

然后 4 段 design 逐节确认（数据模型 → clarifier 行为 → 前端改造 → 边界/迁移/验收）。

整体技术决策遵循 spec §1.4 设计原则：

- 状态驱动（active_question_id 单一字段决定 /now 是否出卡）
- 边界清晰（clarifying 期 spec_md readonly；awaiting_approval+ 可编辑；不存在中间态）
- 渐进发布（2 个 PR 独立可发布、PR-A 单独已有体感）
- 复用现有基础设施（event-bus、now-aggregator、CardSource 抽象）
- 不引入新依赖（markdown 渲染第一版用 `<pre>`，避免拉 react-markdown）
