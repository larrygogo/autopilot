# 需求澄清阶段会话复用 — 技术规格（v3，修复 N-1/N-2/N-3）

**日期**：2026-06-11（v3 更新于同日）  
**状态**：待实施  
**作者**：架构师（autopilot 项目）

---

## 变更记录

### v3（本版本）

| 问题 | 修复说明 |
|------|---------|
| **N-1** 非 Anthropic replay 回归 | replay 条件加 `isAnthropicProvider` 守卫：`(isAnthropicProvider && !activeSessionRef && hasSnapshot)`；`isAnthropicProvider` 在 `①` 块预计算，非 Anthropic 时 replay 逻辑完全旁路 |
| **N-2** `resolvedProvider` desync | `agent` 创建后从 `agent.config.provider` 读取实际 provider，消除与 `buildClarifierAgent()` 的潜在不一致 |
| **N-3** 冗余 `getSession()` | `③` 中直接复用 `①` 已获取的 `session` 变量，去掉重复 DB 查询 |
| 测试补充 | §5.2 补充"非 Anthropic 第 2 轮 prompt 结构不变"测试场景 |

### v2（上版本）

| 问题 | 修复说明 |
|------|---------|
| **C-1** Provider 回归 | `callClaude` 按 `resolvedProvider` 分支：`anthropic` 走 `chat()`，其他走 `run()` |
| **C-2** 接口矛盾 | `ClarifyFn` 统一返回 `{ rawText: string; newSessionRef?: string }` |
| **I-1** qaHistory 重叠 | replay 与 qaHistory 互斥，两段不共存（v3 进一步加 provider 守卫） |
| **I-2** 命名/边界 | `hasNewUserReply` → `hasPriorQA`；补充"每轮一问"注释 |
| **M-1** 死代码 | 删除不可达空 if-block |
| **M-2** snapshot 体积 | `SNAPSHOT_MAX_TURNS=20` 硬截断 |
| **M-3** 测试迁移 | 步骤 3a 明确 mock 迁移路径 |

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
| **Anthropic** provider，第 N 轮（N>1），session 仍有效 | 通过 `providerSessionId` 续回同一个 Claude 会话，仅发送增量消息（本轮用户回复 + 继续指令） |
| **Anthropic** provider，session 失效（进程退出、Claude API 超时等） | 降级到全量上下文重建（当前行为），开新 session；如有 `messages_snapshot` 则以历史对话记录替换 qaHistory 段 |
| **Anthropic** provider，第 1 轮（无历史 session） | 调用 `agent.chat(fullPrompt)`，保存返回的 `providerSessionId` |
| **非 Anthropic** provider（OpenAI/Google） | 沿用原 `agent.run()` 路径，不做 session 跟踪（`agent.chat()` 未实现，调用会抛异常） |
| 需求进入终态（done / cancelled / failed） | 删除对应 session 记录 |

> **Provider 范围说明**：session 复用特性仅限 Anthropic provider（唯一实现了 `chat()` 的 provider）。OpenAI/Google provider 沿用原 `agent.run()` 无 session 路径，行为与改动前完全一致，无回归。

### 1.3 关键约束

- **复用粒度**：1 需求 = 1 个 clarifying session，不跨需求共享
- **Provider 兼容**：非 Anthropic provider 的澄清行为与当前完全一致，无改动
- **降级保证**：Anthropic session 失效不能导致澄清流程中断，必须有无 session 的兜底路径
- **并发安全**：已有 `_inflightRounds` 进程内锁，session 操作跟在锁内，无额外并发风险
- **测试可注入**：`_clarifyFn` 注入点保持可替换，签名升级后现有测试 mock 需同步迁移
- **每轮一问不变式**：设计前提是每轮最多一个 active question（由 `_inflightRounds` + `setActiveQuestionId` 保证），增量消息只取最后一条已解决问题

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
  messages_snapshot TEXT NOT NULL DEFAULT '[]',-- JSON：ConversationTurn[]，供 replay/审计
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
| `agent_session_ref` | TEXT \| NULL | Anthropic provider 返回的 `providerSessionId`；非 Anthropic provider 或首轮未获取时为 null |
| `messages_snapshot` | TEXT | JSON 序列化的 `ConversationTurn[]`（最多保留 `SNAPSHOT_MAX_TURNS` 条），供 session 失效后 replay |
| `created_at` / `updated_at` | TEXT | ISO8601 时间戳 |

**ConversationTurn 结构**

```typescript
interface ConversationTurn {
  role: "user" | "assistant";
  content: string;   // user turn = 发给 LLM 的原始文本；assistant turn = LLM 返回的原始 YAML
}
```

**snapshot 体积控制常量**

```typescript
const SNAPSHOT_MAX_TURNS = 20; // 最多保留 20 条（≈10 轮 Q&A）
```

体积估算：
- user turn（全量首轮）≈ 8–15 KB（workspace 文档截断 + spec_md + qaHistory）
- user turn（增量）≈ 0.5–1 KB
- assistant turn ≈ 2–5 KB（YAML with spec_md）
- 10 轮 × (1 全量 + 9 增量 + 10 YAML) ≈ 20–50 KB，在 SQLite TEXT 列可接受范围内

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

/** 按需求 ID + 类型查 session（不存在返回 null）。type 默认 "clarifying"。 */
export function getSession(reqId: string, type?: string): RequirementSession | null;

/**
 * 创建或更新 session。
 * 若已存在：只更新 updates 里提供的字段（agent_session_ref / messages_snapshot）。
 * 若不存在：用 updates 作初始值新建（未提供字段取默认）。
 * messages_snapshot 写入前自动截断至 SNAPSHOT_MAX_TURNS 最新条目。
 */
export function upsertSession(
  reqId: string,
  type: string,
  updates: { agent_session_ref?: string | null; messages_snapshot?: ConversationTurn[] }
): RequirementSession;

/** 删除 session（终态清理 / 测试重置用）。type 默认 "clarifying"。 */
export function deleteSession(reqId: string, type?: string): void;
```

**ID 生成**：查 `requirement_sessions` 表当前最大序号 + 1，格式 `sess-NNN`（3 位，不足补零）。与 `requirement-comments.ts` 的 `nextCommentId()` 策略相同。

**snapshot 截断实现**（在 `upsertSession` 内）：

```typescript
if (updates.messages_snapshot) {
  const truncated = updates.messages_snapshot.slice(-SNAPSHOT_MAX_TURNS);
  // 截断后确保首条是 user turn（成对完整）
  const startIdx = truncated.findIndex(t => t.role === "user");
  updates = { ...updates, messages_snapshot: startIdx > 0 ? truncated.slice(startIdx) : truncated };
}
```

### 2.3 澄清器改造 — `src/daemon/requirement-clarifier.ts`

#### 2.3.1 `ClarifyFn` 签名升级（C-2 修复）

```typescript
// 旧签名
type ClarifyFn = (prompt: string, reqId: string) => Promise<string>;

// 新签名（统一返回对象；rawText = 原始 LLM 输出文本，同时用于解析和 snapshot）
type ClarifyFn = (
  prompt: string,
  reqId: string,
  sessionRef?: string
) => Promise<{ rawText: string; newSessionRef?: string }>;
```

`_setClarifyFnForTest` 同步更新，接收新签名的 mock 函数。

> **与旧签名的迁移**：返回值从 `string` 改为对象；`parseClarifyResult(raw)` 改为 `parseClarifyResult(rawText)`。所有调用 `_setClarifyFnForTest` 的现有测试 mock 需同步迁移（详见 §3 步骤 3-a）。

#### 2.3.2 `callClaude()` — Provider 分支（C-1 修复）

```typescript
async function callClaude(
  prompt: string,
  reqId: string,
  sessionRef?: string
): Promise<{ rawText: string; newSessionRef?: string }> {
  let agent: Agent;
  let resolvedProvider: ProviderName;
  try {
    const req = getRequirementById(reqId);
    const override: ClarifierAgentOverride = {};
    if (req?.clarifier_provider) override.provider = req.clarifier_provider as ProviderName;
    if (req?.clarifier_model)    override.model    = req.clarifier_model;
    agent = buildClarifierAgent(override);
    // N-2 修复：从 agent 实例读取实际 provider，避免与 buildClarifierAgent() 内部推导逻辑 desync
    resolvedProvider = (agent.config.provider ?? "anthropic") as ProviderName;
  } catch (e: unknown) {
    throw new Error(`无法初始化 clarifier agent：${e instanceof Error ? e.message : String(e)}`);
  }

  if (resolvedProvider === "anthropic") {
    // ✅ Anthropic：chat() 已实现，支持 providerSessionId 续 session
    const result = await agent.chat(prompt, { providerSessionId: sessionRef });
    const rawText = result.text.trim();
    if (!rawText) throw new Error("clarifier agent 返回空");
    return { rawText, newSessionRef: result.providerSessionId };
  } else {
    // ⚠️ OpenAI/Google：chat() 未实现（base.ts 抛错），沿用 run()，不做 session 跟踪
    // 传入的 sessionRef 被忽略；返回 newSessionRef = undefined
    const result = await agent.run(prompt);
    const rawText = result.text.trim();
    if (!rawText) throw new Error("clarifier agent 返回空");
    return { rawText, newSessionRef: undefined };
  }
}
```

> **run() 路径不变**：非 Anthropic provider 走 `agent.run()`，行为与改动前完全一致。`sessionRef` 参数被安全忽略，不会尝试调用未实现的 `chat()`，无回归风险。

#### 2.3.3 `_runClarifierRoundInner()` — 加入 session 管理

在现有 `buildPrompt()` 调用处前后插入 session 逻辑，分三块：

**① Session 查询 & 消息选择**（在原 `buildPrompt` 之前）

```typescript
// ── session 查询 ─────────────────────────────────────────────────────
const session = getSession(reqId, "clarifying");
const activeSessionRef = session?.agent_session_ref ?? undefined;

// N-1 修复：预计算 isAnthropicProvider，用于守卫 replay 触发条件
// 与 callClaude 内的 resolvedProvider 推导逻辑保持一致：req 级覆盖 > 默认 "anthropic"
const isAnthropicProvider =
  ((req.clarifier_provider as ProviderName | undefined) ?? "anthropic") === "anthropic";

// hasPriorQA：本轮前有已解答的问题（= session 里已有先验 Q&A，可走增量路径）
// 设计前提：每轮最多一个 active question（_inflightRounds 进程内锁 + setActiveQuestionId 保证）
const hasPriorQA = allQuestionsResolved.length > 0;
// useIncremental 仅在 Anthropic + 有效 session + 有历史 Q&A 时为 true
const useIncremental = isAnthropicProvider && !!activeSessionRef && hasPriorQA;

// ── 增量消息（仅新回复 + 继续指令）────────────────────────────────────
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

// ── 全量 prompt（首轮 / session 失效 fallback）────────────────────────
// N-1 修复：replay 触发条件加 isAnthropicProvider 守卫
//   Anthropic + session 失效 + 有 snapshot → 用 replay 替换 qaHistory（互斥，避免重叠）
//   非 Anthropic（无论是否有 snapshot）→ 始终走 qaHistory 原路径，行为完全不变
const hasSnapshot = (session?.messages_snapshot?.length ?? 0) > 0;
const useReplay = isAnthropicProvider && !activeSessionRef && hasSnapshot;
const fullPrompt = buildPrompt({
  projectName:        project.name,
  projectDescription: project.description,
  workspaceAlias:     workspace?.alias ?? null,
  workspaceContext:   workspace?.path ? readWorkspaceContext(workspace.path) : null,
  title:              req.title,
  specMd:             req.spec_md ?? "",
  // useReplay 时 qaHistory 传空：历史信息由 messagesReplay 段落承载，两者互斥
  qaHistory:          useReplay ? "" : qaHistory,
  attachmentContext,
  messagesReplay:     useReplay ? session!.messages_snapshot : [],
});
```

> **N-1 关键不变式**：`isAnthropicProvider = false` 时 `useIncremental = false` 且 `useReplay = false`，保证非 Anthropic provider 的所有轮次都走原始 `qaHistory` + `agent.run()` 路径，与改动前行为完全一致。

**② 重试循环**（替换原有 `for` 循环）

```typescript
// 尝试顺序：
//   有 session + 有 Q&A → [增量+session, 全量+无session]
//   无 session / 首轮   → [全量+无session, 全量+无session]（保留原 2 次重试语义）
const attempts: Array<{ prompt: string; sessionRef?: string; label: string }> = [];

if (useIncremental && incrementalPrompt) {
  attempts.push({ prompt: incrementalPrompt, sessionRef: activeSessionRef, label: "增量+session" });
  attempts.push({ prompt: fullPrompt,        sessionRef: undefined,        label: "全量+新session(fallback)" });
} else {
  attempts.push({ prompt: fullPrompt, sessionRef: undefined, label: "全量+新session(首轮)" });
  attempts.push({ prompt: fullPrompt, sessionRef: undefined, label: "全量+新session(retry)" });
}

let result: ClarifyResult | null = null;
let lastError: Error | null = null;
let resolvedSessionRef: string | undefined;
let resolvedPromptUsed: string = fullPrompt;
let resolvedRawText = "";   // 原始 LLM 输出文本，用于 snapshot（C-2 修复）

for (let i = 0; i < attempts.length; i++) {
  const { prompt: attemptPrompt, sessionRef: attemptRef, label } = attempts[i];
  try {
    if (i > 0) setPhase(reqId, "calling-llm", { attempt: i });
    setPhase(reqId, "calling-llm", { attempt: i, prompt: attemptPrompt });

    const { rawText, newSessionRef } = await _clarifyFn(attemptPrompt, reqId, attemptRef);
    result = parseClarifyResult(rawText);
    resolvedRawText     = rawText;
    resolvedSessionRef  = newSessionRef ?? (attemptRef ?? undefined);
    resolvedPromptUsed  = attemptPrompt;
    break;
  } catch (e: unknown) {
    lastError = e instanceof Error ? e : new Error(String(e));
    log.warn("clarifier: req=%s 第 %d 次（%s）失败: %s", reqId, i + 1, label, lastError.message);

    // 第一次失败且用了 session → 清除失效 session_ref，下次循环走全量
    if (i === 0 && attemptRef) {
      log.info("clarifier: req=%s session %s 疑似失效，清除 agent_session_ref，下次走全量", reqId, attemptRef);
      upsertSession(reqId, "clarifying", { agent_session_ref: null });
    }
  }
}
```

> **M-1 修复**：已删除原 `if (i === 0 && useIncremental && !attemptRef)` 不可达空 block。

**③ Session 持久化**（在 `result` 非 null 之后，写 comment/status 之前）

```typescript
if (result) {
  // 无论 provider 类型都写 session：
  //   Anthropic  → resolvedSessionRef = "session-xxx"（用于下次 resume）
  //   非 Anthropic → resolvedSessionRef = undefined → agent_session_ref 写 null（snapshot 留存供审计）
  // N-3 修复：直接复用 ① 中已获取的 session 变量，避免重复 DB 查询
  const prevSnapshot = session?.messages_snapshot ?? [];
  const newSnapshot: ConversationTurn[] = [
    ...prevSnapshot,
    { role: "user",      content: resolvedPromptUsed },
    { role: "assistant", content: resolvedRawText },
  ];
  // upsertSession 内部会做 SNAPSHOT_MAX_TURNS 截断
  upsertSession(reqId, "clarifying", {
    agent_session_ref: resolvedSessionRef ?? null,
    messages_snapshot: newSnapshot,
  });
}
```

> **非 Anthropic provider 的 session 行为**：每轮结束后 `agent_session_ref = null`，snapshot 照常追加（供审计）。下轮 `isAnthropicProvider = false → useIncremental = false，useReplay = false`，始终走全量 `agent.run()` + `qaHistory` 原路径，行为完全不变。

#### 2.3.4 新增 `buildIncrementalPrompt()`

```typescript
function buildIncrementalPrompt(opts: {
  roundNumber: number;   // 当前是第几个 Q&A 轮次（已完成的 Q 数量）
  questionText: string;  // agent 上一轮提的问题
  userReply: string;     // 用户的回答
  currentSpecMd: string; // 当前最新 spec_md（可能被用户手动编辑）
  currentTitle: string;  // 当前需求标题
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

#### 2.3.5 `buildPrompt()` 增加 `messagesReplay` 参数（I-1 修复）

```typescript
function buildPrompt(opts: {
  // ...原有字段...
  messagesReplay?: ConversationTurn[];  // session 失效时注入历史对话（与 qaHistory 互斥）
}): string {
  // ...原有 prompt 构建逻辑不变...

  // qaHistory 段（当 messagesReplay 非空时 qaHistory 已传空，此段即为空）
  // messagesReplay 段（替换 qaHistory，两段互斥，避免 I-1 重叠）
  const replaySection = opts.messagesReplay && opts.messagesReplay.length > 0
    ? [
        "",
        "# 上一次澄清会话记录（会话中断，以下为历史对话）",
        "以下是此前澄清会话的完整消息历史，请在此基础上继续：",
        "",
        ...opts.messagesReplay.map((t, i) =>
          `[${t.role === "user" ? "用户输入" : "助手输出"} · 第 ${Math.floor(i / 2) + 1} 轮]\n${t.content}`
        ),
        "",
        "---（历史记录结束）---",
      ]
    : [];

  return [
    // ...原有 prompt 内容（含 qaHistory 段，replay 时该段为空）...
    ...replaySection,
    "请直接输出 YAML：",
  ].join("\n");
}
```

> **I-1 + N-1 保证**：`buildPrompt` 的调用点使用 `useReplay` 标志（含 `isAnthropicProvider` 守卫）：
> - `useReplay = true`（Anthropic + session 失效 + 有 snapshot）→ `qaHistory = ""`，`messagesReplay = snapshot`
> - `useReplay = false`（首轮 / 非 Anthropic / 无 snapshot）→ `qaHistory = 正常构建`，`messagesReplay = []`
>
> 两路径互斥，不产生重叠；非 Anthropic 恒走第二路径，行为不变。

#### 2.3.6 终态清理

在 `initRequirementClarifier()` 的 `_statusHandler` 中，当状态变为终态时删除 session：

```typescript
_statusHandler = (event: AutopilotEvent) => {
  if (event.type !== "requirement:status-changed") return;
  const { id, to } = event.payload;

  // 终态 → 清理 session（done/cancelled/failed）
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
| **1** | `src/migrations/033-requirement-sessions.ts` | 建 `requirement_sessions` 表 |
| **2** | `src/core/requirement-sessions.ts` | `getSession` / `upsertSession`（含 snapshot 截断）/ `deleteSession` |
| **3a** | `tests/requirement-clarifier.test.ts`（现有） | **迁移所有现有 mock**：`_setClarifyFnForTest` 回调返回值从 `string` 改为 `{ rawText: string; newSessionRef?: string }` |
| **3b** | `src/daemon/requirement-clarifier.ts` | 核心改造：`ClarifyFn` 类型、`callClaude`（provider 分支）、`buildIncrementalPrompt`（新增）、`buildPrompt`（+replay 参数）、`_runClarifierRoundInner`（session 逻辑）、`initRequirementClarifier`（终态清理） |
| **4** | `tests/requirement-sessions.test.ts` | Session CRUD 单测 |
| **5** | `tests/requirement-clarifier.test.ts` | session 路径单测（补充） |

> **步骤 3a 必须先于 3b 完成**：修改核心逻辑前先让所有测试重新通过旧行为，再改逻辑，避免"一次改太多导致测试全绿变成噪音"。

### 步骤 1：Migration 033

```typescript
// src/migrations/033-requirement-sessions.ts
import type { Database } from "bun:sqlite";

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

完整实现 `getSession` / `upsertSession` / `deleteSession`，遵循项目现有 DB 操作风格（`getDb()` + `db.query<T>().get()` / `db.run()`）。`upsertSession` 内 snapshot 截断使用 `SNAPSHOT_MAX_TURNS = 20` 常量，截断后确保首条为 user turn。

### 步骤 3a：现有测试 mock 迁移

```typescript
// 迁移前
_setClarifyFnForTest(async (prompt, reqId) => {
  return "```yaml\nnew_spec_md: ...\ndone: false\n```";
});

// 迁移后
_setClarifyFnForTest(async (prompt, reqId, _sessionRef) => {
  return { rawText: "```yaml\nnew_spec_md: ...\ndone: false\n```", newSessionRef: undefined };
});
```

所有调用 `_setClarifyFnForTest` 的 test case 均需按此格式更新。

### 步骤 3b：澄清器改造

严格按 §2.3 各子节实施。

---

## 4. 影响范围

### 4.1 文件变更清单

| 文件 | 变更类型 | 说明 |
|------|----------|------|
| `src/migrations/033-requirement-sessions.ts` | **新增** | DB schema |
| `src/core/requirement-sessions.ts` | **新增** | Session CRUD + snapshot 截断 |
| `src/daemon/requirement-clarifier.ts` | **修改** | 核心逻辑，改动较大 |
| `tests/requirement-sessions.test.ts` | **新增** | Session CRUD 单测 |
| `tests/requirement-clarifier.test.ts` | **修改** | ① 迁移现有 mock ② 补 session 路径测试 |

### 4.2 非影响范围

| 模块 | 是否受影响 | 原因 |
|------|-----------|------|
| `requirement-comments.ts` / Q&A 历史 | ✗ | 仍从 DB 读取，不改变 |
| 状态机 / ALLOWED_TRANSITIONS | ✗ | 无状态变更 |
| Web UI / TUI / CLI | ✗ | Session 透明，不暴露给客户端 |
| 任务执行（runner / workflow） | ✗ | 仅 daemon 的 clarifier 层 |
| `buildClarifierAgent()` | ✗ | 接口不变，返回 `Agent` 实例 |
| **OpenAI/Google provider clarifier** | ✗ | 沿用 `agent.run()` 原路径，无任何改动 |

### 4.3 风险与缓解

| 风险 | 严重度 | 缓解措施 |
|------|--------|---------|
| Claude CLI session 过期策略未知，`--resume` 失败率不确定 | 中 | 两级降级：先增量+session，失败自动降全量+无 session；session 失效不中断澄清流程 |
| `agent.chat()` 与 `agent.run()` 行为差异（Anthropic） | 低 | clarifier 不在 task context 中，`run()` 的 AUTOPILOT_HOME 注入对其无效；`chat()` 等价，无副作用 |
| ~~OpenAI/Google provider 回归~~（C-1 已修复） | ✗ | 非 Anthropic 走 `run()` 原路径，无变化 |
| `messages_snapshot` 体积（M-2 已控制） | 低 | `SNAPSHOT_MAX_TURNS=20` 硬截断；实测估算 10 轮 ≈ 20–50 KB，可接受 |
| 并发 round 下 session 写冲突 | 低 | `_inflightRounds` 进程内锁已确保同一需求同时只跑一个 round，session 写在锁内 |
| 现有测试 mock 签名不兼容（M-3 已显式列出） | 低 | 步骤 3a 明确迁移路径，先迁再改 |

---

## 5. 测试计划

### 5.1 单元测试：`src/core/requirement-sessions.ts`

| 场景 | 验证点 |
|------|--------|
| `getSession` 不存在时返回 null | 返回值为 null |
| `upsertSession` 首次创建 | id 符合 `sess-NNN` 格式，字段正确，`messages_snapshot = []` |
| `upsertSession` 更新已有 session | `agent_session_ref` 被覆盖，`updated_at` 更新 |
| `upsertSession` 只传 `agent_session_ref` | `messages_snapshot` 保持原值 |
| `upsertSession` snapshot 超出 `SNAPSHOT_MAX_TURNS` | 截断为最新 N 条，且首条为 user turn |
| `deleteSession` 删除后 `getSession` 返回 null | 正常 |
| UNIQUE 约束：同 reqId + type 只保留一条 | upsert 语义正确，无重复插入 |

### 5.2 单元测试：`requirement-clarifier.ts` — session 路径

| 场景 | mock 行为 | 验证点 |
|------|-----------|--------|
| 首轮（无 session，Anthropic） | mock 返回 `{ rawText: "...", newSessionRef: "sess-abc" }` | session 被创建，`agent_session_ref = "sess-abc"` |
| 第 2 轮（session 有效，Anthropic） | mock 接收 `sessionRef = "sess-abc"`，返回 `newSessionRef: "sess-abc2"` | 调用 `_clarifyFn` 时 sessionRef 非 undefined；session 被更新；增量 prompt 不含 `# 任务` 等首轮段落 |
| session 失效（第一次抛异常，Anthropic） | 第 1 次抛错，第 2 次成功 | 第 2 次 sessionRef 为 undefined；旧 `agent_session_ref` 被清空；全量 prompt 重建 |
| 非 Anthropic provider 第 1 轮（OpenAI） | mock 接收 `sessionRef = undefined`，返回 `newSessionRef: undefined` | session 记录被 upsert 但 `agent_session_ref = null`；不尝试 session resume |
| **非 Anthropic provider 第 2 轮+（N-1 回归检验）** | 第 1 轮已写入 snapshot；第 2 轮触发 → mock 捕获 prompt | **prompt 含 `# 已完成的 Q&A 历史` 段（原路径），不含 `# 上一次澄清会话记录` 段**；`_clarifyFn` 调用时 `sessionRef = undefined` |
| replay 无重叠（Anthropic session 失效 + snapshot 存在） | Anthropic provider + mock 捕获 prompt | prompt 内 `qaHistory` 段为空，`# 上一次澄清会话记录` 段存在；两段不共存 |
| 终态清理 `done` / `cancelled` / `failed` | 状态变更事件 | `deleteSession` 被调用；session 记录删除 |

### 5.3 集成验证（手动 / 烟雾测试）

| 场景 | 验证步骤 |
|------|---------|
| 多轮澄清 session 复用 | 创建需求 → 回答 Q1 → DB 查 `requirement_sessions` 确认 `agent_session_ref` 非空 → 回答 Q2 → `updated_at` 更新，snapshot 追加两条 |
| 模拟 session 失效 | 手动将 DB `agent_session_ref` 改成非法值 → 触发下一轮 → 日志出现"session 疑似失效"警告 → 澄清正常完成 |
| 非 Anthropic provider | 设置 `clarifier_provider: openai` → 多轮澄清正常，`agent_session_ref` 始终为 null |
| 终态清理 | 澄清完成 → 需求进入 `done` → `requirement_sessions` 记录消失 |

---

## 6. 附录：完整数据流图（v3）

```
需求进入 clarifying
         │
         ▼
getSession(reqId, "clarifying")  +  计算 isAnthropicProvider
         │
         ├─ isAnthropicProvider = true  ─────────────────────────────┐
         │                                                             │
         │   ┌───────────────────────────────────────────┐            │
         │   │ 有 activeSessionRef + hasPriorQA          │            │
         │   │ (useIncremental = true)                   │            │
         │   ▼                                           ▼            │
         │   buildIncrementalPrompt(...)     buildFullPrompt(...)     │
         │                                    ├─ useReplay=true       │
         │                                    │   qaHistory=""        │
         │                                    │   messagesReplay=snap │
         │                                    └─ useReplay=false      │
         │                                        qaHistory=正常      │
         │                                        messagesReplay=[]   │
         │         callClaude(prompt, reqId, sessionRef?)             │
         │           → agent.chat(prompt, { providerSessionId? })  ◄─┘
         │           → return { rawText, newSessionRef }
         │
         └─ isAnthropicProvider = false ──────────────────────────────┐
             (useIncremental = false, useReplay = false)              │
             buildFullPrompt(qaHistory=正常, messagesReplay=[])        │
             callClaude(prompt, reqId, undefined) ◄──────────────────┘
               → agent.run(prompt)   ← 原路径，无变化
               → return { rawText, newSessionRef: undefined }

─────────────────────────────────────────────────────────────────────
         │ 成功                              │ 失败（i=0, session 用过）
         ▼                                  ▼
parseClarifyResult(rawText)      清空 agent_session_ref
         │                       重试：callClaude(fullPrompt, undefined)
         ▼
upsertSession(reqId, "clarifying", {
  agent_session_ref: resolvedSessionRef ?? null,   -- Anthropic: session-xxx；非Anthropic: null
  messages_snapshot: [                             -- 截断到 SNAPSHOT_MAX_TURNS
    ...session?.messages_snapshot ?? [],           -- N-3: 复用 ① 的 session 变量
    {user, resolvedPromptUsed},
    {assistant, resolvedRawText}
  ]
})
         │
         ▼
写 comment / 更新 spec_md / 状态转移（同现有逻辑）
```
