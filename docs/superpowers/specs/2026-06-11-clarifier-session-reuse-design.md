# 需求澄清阶段会话复用 — 技术规格

**日期**：2026-06-11  
**状态**：待实施  
**作者**：架构师（autopilot 项目）

---

## 1. 需求分析

### 1.1 现状问题

`requirement-clarifier.ts` 的核心调用链：

```
runClarifierRound(reqId)
  → _runClarifierRoundInner(reqId)
    → callClaude(prompt, reqId)
      → agent.run(prompt)      ← 无状态，每次全新
```

每轮澄清都经历：
1. 从 `requirement_comments` 重建全量 Q&A 历史
2. 将历史拼入 prompt（随轮数增长，prompt 越来越长）
3. 调用 `agent.run(prompt)` —— 对 Claude API 来说每次都是全新对话，无会话连续性

**问题**：
- Claude 每轮都要重新"读懂"整份需求背景，理解成本重复叠加
- 被驳回后再次进入 `clarifying`（路径：`clarifying → awaiting_approval → drafting → clarifying`），同样全新开始，丢失前几轮的思考脉络
- 随 Q&A 轮数增加，prompt token 数线性增长

### 1.2 目标行为

| 场景 | 期望行为 |
|------|----------|
| 同一需求的第 N 轮（N>1）澄清，session 仍有效 | 通过 `providerSessionId` 续回同一个 Claude 会话，仅发送增量消息（本轮用户回复 + 继续指令） |
| session 已失效（进程退出、Claude API 超时等） | 降级到全量上下文重建（当前行为）+ 开新 session；如有 `messages_snapshot` 则注入历史对话记录以增强上下文 |
| 第 1 轮（无历史 session） | 调用 `agent.chat(fullPrompt)`（等价于当前行为），保存返回的 `providerSessionId` |
| 需求进入终态（done / cancelled / failed） | 删除对应 session 记录 |

### 1.3 关键约束

- **复用粒度**：1 需求 = 1 个 clarifying session，不跨需求共享
- **降级保证**：session 失效不能导致澄清流程中断，必须有无 session 的兜底路径
- **并发安全**：已有 `_inflightRounds` 进程内锁，session 操作跟在锁内，无额外并发风险
- **测试可注入**：`_clarifyFn` 注入点保持可替换，新签名向后兼容测试

---

## 2. 技术方案

### 2.1 数据层 — Migration 033

新表 `requirement_sessions`：

```sql
CREATE TABLE IF NOT EXISTS requirement_sessions (
  id                TEXT PRIMARY KEY,          -- 'sess-NNN'，自增
  requirement_id    TEXT NOT NULL,
  session_type      TEXT NOT NULL DEFAULT 'clarifying',
  agent_session_ref TEXT,                      -- claude providerSessionId；null = 无有效 session
  messages_snapshot TEXT NOT NULL DEFAULT '[]',-- JSON：ConversationTurn[]，供回放/审计
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE(requirement_id, session_type),        -- 1 需求 1 个同类型 session
  FOREIGN KEY (requirement_id) REFERENCES requirements(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_req_sessions_req
  ON requirement_sessions(requirement_id);
```

**字段说明**

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | TEXT | `sess-001`、`sess-002`…（与其他实体保持 ID 风格一致） |
| `requirement_id` | TEXT | 关联需求，CASCADE 删除 |
| `session_type` | TEXT | 当前固定 `clarifying`；为将来其他类型 session 预留扩展 |
| `agent_session_ref` | TEXT \| NULL | Claude CLI 返回的 `providerSessionId`；null 表示无有效 session |
| `messages_snapshot` | TEXT | JSON 序列化的 `ConversationTurn[]`，记录本 session 已发送的完整消息历史，供 session 失效后重放 |
| `created_at` / `updated_at` | TEXT | ISO8601 时间戳 |

**ConversationTurn 结构**（JSON schema）

```json
{
  "role":    "user" | "assistant",
  "content": "string"
}
```

### 2.2 核心模块 — `src/core/requirement-sessions.ts`（新增）

**公开接口**：

```typescript
export interface RequirementSession {
  id: string;
  requirement_id: string;
  session_type: string;
  agent_session_ref: string | null;
  messages_snapshot: ConversationTurn[];
  created_at: string;
  updated_at: string;
}

export interface ConversationTurn {
  role: "user" | "assistant";
  content: string;
}

/** 按需求 ID + 类型查 session（不存在返回 null） */
export function getSession(reqId: string, type?: string): RequirementSession | null;

/**
 * 创建或更新 session。
 * 若已存在：只更新 updates 里提供的字段（agent_session_ref / messages_snapshot）。
 * 若不存在：用 updates 作初始值新建（未提供字段取默认）。
 */
export function upsertSession(
  reqId: string,
  type: string,
  updates: { agent_session_ref?: string | null; messages_snapshot?: ConversationTurn[] }
): RequirementSession;

/** 删除 session（终态清理 / 测试重置用） */
export function deleteSession(reqId: string, type?: string): void;
```

**ID 生成**：查 `requirement_sessions` 表当前最大序号 + 1，格式 `sess-NNN`（3 位，不足补零）。与 `requirement-comments.ts` 的 `nextCommentId()` 策略相同。

### 2.3 澄清器改造 — `src/daemon/requirement-clarifier.ts`

#### 2.3.1 `ClarifyFn` 签名升级

```typescript
// 旧签名
type ClarifyFn = (prompt: string, reqId: string) => Promise<string>;

// 新签名（向后兼容：第三个参数可选）
type ClarifyFn = (
  prompt: string,
  reqId: string,
  sessionRef?: string
) => Promise<{ text: string; newSessionRef?: string }>;
```

`_setClarifyFnForTest` 同步更新，接收新签名的 mock 函数。

#### 2.3.2 `callClaude()` — 从 `run()` 切换到 `chat()`

```typescript
async function callClaude(
  prompt: string,
  reqId: string,
  sessionRef?: string
): Promise<{ text: string; newSessionRef?: string }> {
  let agent;
  try {
    const req = getRequirementById(reqId);
    const override: ClarifierAgentOverride = {};
    if (req?.clarifier_provider) override.provider = req.clarifier_provider as ProviderName;
    if (req?.clarifier_model) override.model = req.clarifier_model;
    agent = buildClarifierAgent(override);
  } catch (e: unknown) {
    throw new Error(`无法初始化 clarifier agent：${e instanceof Error ? e.message : String(e)}`);
  }

  // 从 run() 改为 chat()，支持 providerSessionId 续 session
  const result = await agent.chat(prompt, { providerSessionId: sessionRef });
  const text = result.text.trim();
  if (!text) throw new Error("clarifier agent 返回空");
  return { text, newSessionRef: result.providerSessionId };
}
```

> **run() → chat() 的影响**：clarifier 不在 task context 中运行（无 `getTaskContext()`），`agent.run()` 中的 AUTOPILOT_HOME 注入和 agent-calls.jsonl 记录对 clarifier 无效。`agent.chat()` 同样不记录 agent-calls.jsonl（文档注释："不走 task context"），行为等价，不引入副作用。

#### 2.3.3 `_runClarifierRoundInner()` — 加入 session 管理

在 `buildPrompt()` 调用处前后插入 session 逻辑，分三块：

**① Session 查询 & 消息选择**（在原 `buildPrompt` 之前）

```typescript
// session 查询
const session = getSession(reqId, "clarifying");
const activeSessionRef = session?.agent_session_ref ?? undefined;

// 判断是否走增量模式：有有效 session + 本轮有新用户回复
const hasNewUserReply = allQuestionsResolved.length > 0;
const useIncremental = !!activeSessionRef && hasNewUserReply;

// 增量消息（仅新回复 + 继续指令）
let incrementalPrompt: string | null = null;
if (useIncremental) {
  const lastQ = allQuestionsResolved[allQuestionsResolved.length - 1];
  const lastReply = listComments(reqId, { kind: "question", parent_id: lastQ.id })
    .find(r => r.from_role === "user")?.body ?? "(未回复)";
  incrementalPrompt = buildIncrementalPrompt({
    roundNumber: allQuestionsResolved.length,
    questionText: lastQ.body,
    userReply: lastReply,
    currentSpecMd: req.spec_md ?? "",
    currentTitle: req.title,
  });
}

// 全量 prompt（首轮 / session 失效 fallback / replay）
const fullPrompt = buildPrompt({
  projectName: project.name,
  projectDescription: project.description,
  workspaceAlias: workspace?.alias ?? null,
  workspaceContext: workspace?.path ? readWorkspaceContext(workspace.path) : null,
  title: req.title,
  specMd: req.spec_md ?? "",
  qaHistory,
  attachmentContext,
  // 当 session 失效且有 snapshot 时：追加历史对话记录段落
  messagesReplay: !activeSessionRef ? (session?.messages_snapshot ?? []) : [],
});
```

**② 重试循环调整**（替换原有 `for` 循环）

```typescript
// 尝试顺序：
//   有 session → [增量+session, 全量+无session]（若增量失败则降级）
//   无 session → [全量+无session, 全量+无session]（保留原 2 次重试语义）
const attempts: Array<{ prompt: string; sessionRef?: string; label: string }> = [];

if (useIncremental && incrementalPrompt) {
  attempts.push({ prompt: incrementalPrompt, sessionRef: activeSessionRef, label: "增量+session" });
  attempts.push({ prompt: fullPrompt, sessionRef: undefined, label: "全量+新session(fallback)" });
} else {
  attempts.push({ prompt: fullPrompt, sessionRef: undefined, label: "全量+新session(首轮)" });
  attempts.push({ prompt: fullPrompt, sessionRef: undefined, label: "全量+新session(retry)" });
}

let result: ClarifyResult | null = null;
let lastError: Error | null = null;
let resolvedSessionRef: string | undefined;
let resolvedPromptUsed: string = fullPrompt;

for (let i = 0; i < attempts.length; i++) {
  const { prompt: attemptPrompt, sessionRef: attemptRef, label } = attempts[i];
  try {
    if (i > 0) setPhase(reqId, "calling-llm", { attempt: i });
    setPhase(reqId, "calling-llm", { attempt: i, prompt: attemptPrompt });

    const { text: raw, newSessionRef } = await _clarifyFn(attemptPrompt, reqId, attemptRef);
    result = parseClarifyResult(raw);
    resolvedSessionRef = newSessionRef ?? attemptRef;
    resolvedPromptUsed = attemptPrompt;

    if (i === 0 && useIncremental && !attemptRef) {
      // 不应到这里，防御性分支
    }
    if (attemptRef && !newSessionRef) {
      // session resume 成功但 provider 没返回新 sessionId（边界情况）
      // 保留旧 sessionRef 继续用
      resolvedSessionRef = attemptRef;
    }
    break;
  } catch (e: unknown) {
    lastError = e instanceof Error ? e : new Error(String(e));
    log.warn("clarifier: req=%s 第 %d 次（%s）失败: %s", reqId, i + 1, label, lastError.message);

    // 第一次失败且用了 session：清除失效 session_ref，下次循环走全量
    if (i === 0 && attemptRef) {
      log.info("clarifier: req=%s session %s 疑似失效，清除 agent_session_ref，下次走全量", reqId, attemptRef);
      upsertSession(reqId, "clarifying", { agent_session_ref: null });
    }
  }
}
```

**③ Session 持久化**（在 `result` 非 null 之后，写 comment/status 之前）

在 `②` 的循环中，需额外保存 `resolvedRaw: string`（原始 YAML 文本，用于 snapshot）：

```typescript
// 在循环顶部定义（与 resolvedSessionRef / resolvedPromptUsed 并排）
let resolvedRaw = "";

// 在循环成功分支中
// const { text: raw, newSessionRef } = ...
resolvedRaw = raw;      // 保存原始文本供 ③ 写 snapshot
```

持久化代码：

```typescript
if (result) {
  // 更新 session：保存新 providerSessionId + 追加本轮消息到 snapshot
  const prevSnapshot = getSession(reqId, "clarifying")?.messages_snapshot ?? [];
  const newSnapshot: ConversationTurn[] = [
    ...prevSnapshot,
    { role: "user",      content: resolvedPromptUsed },
    { role: "assistant", content: resolvedRaw },
  ];
  upsertSession(reqId, "clarifying", {
    agent_session_ref: resolvedSessionRef ?? null,
    messages_snapshot: newSnapshot,
  });
}
```

> **注意**：需要在 `parseClarifyResult()` 之前保存原始 `raw` 文本，或在 `callClaude()` 返回值中同时返回 `raw`，供此处写入 snapshot。建议在 `_runClarifierRoundInner` 中将 `callClaude` 的返回类型改为 `{ text: string; raw: string; newSessionRef?: string }`，其中 `text` = 解析后，`raw` = 原始文本。

#### 2.3.4 新增 `buildIncrementalPrompt()`

```typescript
function buildIncrementalPrompt(opts: {
  roundNumber: number;      // 当前是第几个 Q&A 轮次（已完成的 Q 数量）
  questionText: string;     // agent 上一轮提的问题
  userReply: string;        // 用户的回答
  currentSpecMd: string;    // 当前最新 spec_md（可能被用户手动编辑过）
  currentTitle: string;     // 当前需求标题
}): string {
  return [
    `用户已回答第 ${opts.roundNumber} 个问题。`,
    "",
    `问题：${opts.questionText}`,
    `回答：${opts.userReply}`,
    "",
    "当前 spec_md（可能因用户手动修改与你上次看到的不同）：",
    opts.currentSpecMd || "(空)",
    "",
    "当前需求标题：",
    opts.currentTitle,
    "",
    "请根据此回答更新 spec_md，并决定是否需要继续追问。",
    "以相同 YAML 格式输出（字段含义与首轮相同）：",
  ].join("\n");
}
```

#### 2.3.5 `buildPrompt()` 增加 `messagesReplay` 参数

```typescript
function buildPrompt(opts: {
  // ...原有字段...
  messagesReplay?: ConversationTurn[];  // session 失效时的历史对话回放（可选）
}): string {
  // ...原有 prompt 构建...
  
  // 在末尾附加历史对话记录（仅当 messagesReplay 非空）
  const replaySection = opts.messagesReplay && opts.messagesReplay.length > 0
    ? [
        "",
        "# 历史对话记录（本轮之前的澄清会话）",
        "以下是此前澄清会话的完整消息历史，供你恢复上下文：",
        "",
        ...opts.messagesReplay.map((t, i) =>
          `[${t.role === "user" ? "用户" : "助手"} - 第 ${Math.floor(i / 2) + 1} 轮]\n${t.content}`
        ),
        "",
        "---（历史记录结束，请在以上基础上继续澄清）---",
      ]
    : [];

  return [
    // ...原有 prompt 内容...
    ...replaySection,
    "请直接输出 YAML：",
  ].join("\n");
}
```

#### 2.3.6 终态清理

在 `initRequirementClarifier()` 的 `_statusHandler` 中，当状态变为终态时删除 session：

```typescript
_statusHandler = (event: AutopilotEvent) => {
  if (event.type !== "requirement:status-changed") return;
  const { id, to } = event.payload;

  // 终态 → 清理 session
  if (to === "done" || to === "cancelled" || to === "failed") {
    deleteSession(id, "clarifying");
  }

  if (to !== "clarifying") return;
  runClarifierRound(id).catch((e: unknown) => {
    log.error("clarifier: status-changed handler 失败 req=%s: %s", id, (e as Error).message);
  });
};
```

---

## 3. 实现步骤

| 步骤 | 文件 | 内容 |
|------|------|------|
| 1 | `src/migrations/033-requirement-sessions.ts` | 建 `requirement_sessions` 表 |
| 2 | `src/core/requirement-sessions.ts` | `getSession` / `upsertSession` / `deleteSession` |
| 3 | `src/daemon/requirement-clarifier.ts` | 更新 `ClarifyFn` 类型、`callClaude`、`buildIncrementalPrompt`、`buildPrompt`（+replay 参数）、`_runClarifierRoundInner`（session 逻辑）、`initRequirementClarifier`（终态清理） |
| 4 | `tests/requirement-sessions.test.ts` | CRUD 单测 |
| 5 | `tests/requirement-clarifier.test.ts` | session 相关路径单测（session 复用、降级 fallback、终态清理） |

### 步骤 1：Migration 033

```typescript
// src/migrations/033-requirement-sessions.ts
export function up(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS requirement_sessions (
      id                TEXT PRIMARY KEY,
      requirement_id    TEXT NOT NULL,
      session_type      TEXT NOT NULL DEFAULT 'clarifying',
      agent_session_ref TEXT,
      messages_snapshot TEXT NOT NULL DEFAULT '[]',
      created_at        TEXT NOT NULL,
      updated_at        TEXT NOT NULL,
      UNIQUE(requirement_id, session_type),
      FOREIGN KEY (requirement_id) REFERENCES requirements(id) ON DELETE CASCADE
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_req_sessions_req ON requirement_sessions(requirement_id)`);
}
```

### 步骤 2：`src/core/requirement-sessions.ts`

完整实现 `getSession` / `upsertSession` / `deleteSession`，遵循项目现有 DB 操作风格（`getDb()` + `db.query<T>().get()` / `db.run()`）。

### 步骤 3：澄清器改造（核心改动）

严格按 §2.3 各子节实施，改动集中在：
- `callClaude`：签名升级 + `agent.run()` → `agent.chat()`
- `_runClarifierRoundInner`：session 查询 + 消息选择 + 重试序列 + session 持久化
- `buildIncrementalPrompt`：新增函数
- `buildPrompt`：增加 `messagesReplay` 可选参数
- `initRequirementClarifier`：`_statusHandler` 加终态清理

### 步骤 4-5：测试

按 §5 测试计划实施。

---

## 4. 影响范围

### 4.1 文件变更清单

| 文件 | 变更类型 | 说明 |
|------|----------|------|
| `src/migrations/033-requirement-sessions.ts` | **新增** | DB schema |
| `src/core/requirement-sessions.ts` | **新增** | Session CRUD |
| `src/daemon/requirement-clarifier.ts` | **修改** | 核心逻辑，改动较大 |
| `src/core/migrate.ts` | 可能微调 | 如果迁移文件需要手动注册 |
| `tests/requirement-sessions.test.ts` | **新增** | |
| `tests/requirement-clarifier.test.ts` | **修改** | 补 session 相关测试 |

### 4.2 非影响范围

| 模块 | 是否受影响 | 原因 |
|------|-----------|------|
| `requirement-comments.ts` / Q&A 历史 | ✗ | 仍从 DB 读取，仅增量消息时少发一次全量 |
| 状态机 / ALLOWED_TRANSITIONS | ✗ | 无状态变更 |
| Web UI / TUI / CLI | ✗ | Session 透明，不暴露给客户端 |
| 任务执行（runner / workflow） | ✗ | 仅 daemon 的 clarifier 层 |
| `buildClarifierAgent()` | ✗ | 接口不变，返回 `Agent` 实例 |

### 4.3 风险与缓解

| 风险 | 严重度 | 缓解措施 |
|------|--------|---------|
| Claude CLI session 过期策略未知，`--resume` 失败率不确定 | 中 | 两级降级：先增量+session，失败自动降全量+无session；session 失效不中断澄清流程 |
| `agent.chat()` 与 `agent.run()` 行为差异 | 低 | clarifier 本已不在 task context 中，`run()` 的 AUTOPILOT_HOME 注入对它无效；`chat()` 行为等价，无副作用差异 |
| `messages_snapshot` 随轮数增长占用 DB 空间 | 低 | 澄清轮次通常 3-7 轮；单条 snapshot JSON < 50KB；可接受 |
| 并发 round 下 session 写冲突 | 低 | `_inflightRounds` 进程内锁已确保同一需求同时只跑一个 round，session 写在锁内，无并发 |
| 测试中 `_clarifyFn` 注入失效 | 低 | 新签名需同步更新所有测试 mock，`_setClarifyFnForTest` 入参类型严格检查 |

---

## 5. 测试计划

### 5.1 单元测试：`src/core/requirement-sessions.ts`

| 场景 | 验证点 |
|------|--------|
| `getSession` 不存在时返回 null | 返回值为 null |
| `upsertSession` 首次创建 | id 符合 `sess-NNN` 格式，字段正确 |
| `upsertSession` 更新已有 session | `agent_session_ref` 被覆盖，`updated_at` 更新 |
| `upsertSession` 只传 `agent_session_ref` | `messages_snapshot` 保持原值 |
| `deleteSession` 删除后 `getSession` 返回 null | 正常 |
| UNIQUE 约束：同 reqId + type 只保留一条 | upsert 语义正确，无重复插入 |

### 5.2 单元测试：`requirement-clarifier.ts` — session 路径

| 场景 | mock 行为 | 验证点 |
|------|-----------|--------|
| 首轮（无 session）| mock 返回 `newSessionRef: "sess-abc"` | session 被创建，`agent_session_ref = "sess-abc"` |
| 第 2 轮（session 有效）| mock 接收 `sessionRef = "sess-abc"`，返回 `newSessionRef: "sess-abc2"` | 调用 `_clarifyFn` 时 sessionRef 非 undefined；session 被更新 |
| session 失效（第一次抛异常）| 第 1 次 mock 抛错，第 2 次成功 | 第 2 次调用 sessionRef 为 undefined；旧 session `agent_session_ref` 被清空；新 session 以全量 prompt 创建 |
| 增量消息内容检查 | 第 2 轮时检查传给 mock 的 prompt | prompt 不含 `# 任务` 等首轮全量段落；包含用户回答文本 |
| 终态状态变化清理 session | `to: "done"` 事件 | `deleteSession` 被调用；session 记录删除 |
| 终态 `cancelled` / `failed` | `to: "cancelled"` 等 | 同上 |

### 5.3 集成验证（手动 / 烟雾测试）

| 场景 | 验证步骤 |
|------|---------|
| 多轮澄清 session 复用 | 创建需求 → 回答 Q1 → DB 查 `requirement_sessions` 确认 `agent_session_ref` 非空 → 回答 Q2 → session `updated_at` 更新，`messages_snapshot` 追加两条 |
| 模拟 session 失效 | 手动将 DB 中 `agent_session_ref` 改成非法值 → 触发下一轮 → 观察日志确认"session 疑似失效"警告 → 澄清正常完成 |
| 终态清理 | 澄清完成 → 需求进入 `done` → DB 中 `requirement_sessions` 记录消失 |

---

## 6. 附录：完整数据流图

```
需求进入 clarifying
         │
         ▼
getSession(reqId, "clarifying")
         │
    ┌────┴─────┐
    │ 有 session │ 无 session
    │ + Q&A 历史 │
    ▼          ▼
buildIncremental   buildFullPrompt
Prompt(...)       (qaHistory, replay?)
    │                    │
    ▼                    ▼
callClaude(prompt, reqId, sessionRef?)
  → agent.chat(prompt, { providerSessionId? })
    │
    ├─ 成功 ──────────────────────────────────────────┐
    │                                                 │
    ├─ 失败（sessionRef 非空）                         │
    │   └─ 清空 agent_session_ref                     │
    │   └─ 重试：callClaude(fullPrompt, reqId, undefined)
    │                                                 │
    ▼                                                 │
parseClarifyResult(raw)  ◄────────────────────────────┘
         │
         ▼
upsertSession(reqId, "clarifying", {
  agent_session_ref: newSessionRef,
  messages_snapshot: [...prev, {user, prompt}, {assistant, raw}]
})
         │
         ▼
写 comment / 更新 spec_md / 状态转移（同现有逻辑）
```
