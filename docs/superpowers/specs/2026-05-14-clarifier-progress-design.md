# Clarifier 进度反馈

**Goal**：让用户在 RequirementDetail 上看到 AI 澄清当前是不是在跑、跑了多久、第几次 LLM 调用、卡哪儿了，并能展开看本轮 prompt（trace）。

## 背景

Dogfood 多次反馈"不知道 AI 在想什么"。现状：

- 前端只有一个 `AI 正在分析需求…` spinner，无计时、无轮次、无 prompt
- 后端 `_inflightRounds = Set<reqId>` 仅记是否在跑，没有任何元信息
- clarifier 的 LLM 调用不在 task 上下文里，`agent-calls.jsonl` 没记录
- daemon 内 LLM 调用过程对外完全黑盒

## 范围

**包含**：

- 当前 round 的轮次（attempt 0 / 1）、起始时间、阶段（preparing / calling-llm / parsing / writing / done / aborted / errored）
- 完整 prompt 字符串（trace，可展开）
- attempt 1 时 attempt 0 的 parse error 文字
- 实时推送（WS）+ 首次 / 重连补拉（HTTP）

**不包含**：

- LLM 流式 partial response（callClaude 用 `agent.run` 非流式，YAGNI）
- 历史 round 的 prompt / response（trace 内存态，round 结束即丢）
- 历史 round 列表（用户复盘看 `requirement_spec_revisions` 已经够）
- 全局 `/api/clarifier-rounds` 列表 endpoint
- NowCard 集成（progress 是 RequirementDetail 局部信息）

## 架构

### §1 后端进度状态

新模块 `src/daemon/clarifier-progress.ts`：

```ts
export interface ClarifierRoundState {
  req_id: string;
  started_at: number;          // epoch ms
  phase: "preparing" | "calling-llm" | "parsing" | "writing"
       | "done" | "aborted" | "errored";
  attempt: 0 | 1;              // 0 = 第一次尝试；1 = 重试
  prompt: string | null;       // 字符串长度截断到 16384 字符（JS .length）
  last_parse_error: string | null;  // 同上长度截断
}

const _rounds = new Map<string, ClarifierRoundState>();

export function startRound(reqId: string, prompt: string): void;
export function setPhase(
  reqId: string,
  phase: ClarifierRoundState["phase"],
  patch?: Partial<Pick<ClarifierRoundState, "attempt" | "prompt" | "last_parse_error">>,
): void;
export function endRound(reqId: string, finalPhase: "done" | "aborted" | "errored"): void;
export function getRound(reqId: string): ClarifierRoundState | undefined;
export function listAllActive(): ClarifierRoundState[];
export function _resetForTest(): void;
```

每个写函数（`startRound` / `setPhase` / `endRound`）执行后 emit 一次：

```ts
| { type: "requirement:clarifier-round-update";
    payload: ClarifierRoundState }
```

`endRound` emit 终态事件后**立即**从 Map 删除 entry（trace 不留）。

输入字符串截断：`prompt` 与 `last_parse_error` 在写入前若 `str.length > 16384` 则裁到 `str.slice(0, 16384) + "…"`。

### §2 集成到 `runClarifierRound`

`src/daemon/requirement-clarifier.ts` 在以下位置加调用：

| 位置 | 调用 |
|---|---|
| `_runClarifierRoundInner` 通过 `req.status === "clarifying"` 校验后 | `startRound(reqId, "")` → 显示 preparing |
| `buildPrompt` 完成后、`await _clarifyFn` 前 | `setPhase(reqId, "calling-llm", { attempt: 0, prompt })` |
| catch parse error 时（attempt 0 失败） | `setPhase(reqId, "parsing", { attempt: 1, last_parse_error: e.message })` |
| 进入 attempt 1 的 `await _clarifyFn` 前 | `setPhase(reqId, "calling-llm", { attempt: 1 })` |
| status / activeQid race 检查全部通过、写 spec_revision 前 | `setPhase(reqId, "writing")` |
| `_runClarifierRoundInner` 正常返回前 | `endRound(reqId, "done")` |
| 中途因 status / active race / project 缺失等 early return | `endRound(reqId, "aborted")` |
| LLM 两次都失败 emit clarifier-error 时 | `endRound(reqId, "errored")` |

`runClarifierRound` 外层 `finally` 不动；如果 inner 抛错跳过了 `endRound`，外层在 `finally` 兜底 `endRound(reqId, "errored")`（idempotent：Map 里没 entry 就 no-op）。

### §3 HTTP API

```
GET /api/requirements/:id/clarifier-round
→ 200 { round: ClarifierRoundState | null }
```

`routes.ts` 在已有 `/api/requirements/:id/retry-clarify` 附近加。

不做 POST/DELETE。round 寿命由 clarifier 内部状态机管理。

### §4 前端 — RequirementDetail 进度卡

`src/web/src/hooks/useApi.ts` 加：

```ts
getClarifierRound: (id: string) =>
  request<{ round: ClarifierRoundState | null }>(`/api/requirements/${id}/clarifier-round`)
    .then(r => r.round),
```

类型 `ClarifierRoundState` export，与后端对应。

`RequirementDetail.tsx`：

- 初次 load 时 `getClarifierRound(id)` → setRound
- 订阅 `requirement:clarifier-round-update` WS 事件，payload.req_id === current id 时 setRound
- payload.phase ∈ `{done, aborted, errored}` → setRound(null) （UI 上立即移除）

**进度卡片** 替换现有"AI 正在分析需求…"区块：

```
当 req.status === 'clarifying' 时：
  round !== null && phase ∈ active 集合 → 进度卡
  round === null && questions.length === 0 → 现状 idle 文案（带重试按钮，保留）
  其他 → 不显示
```

active 集合 = `{preparing, calling-llm, parsing, writing}`。

卡片布局：

```
┌─────────────────────────────────────────────────┐
│ ⟳ AI 正在思考…                          已用 32s │
│   第 1 次 LLM 调用 · 阶段：calling-llm           │
│                                                 │
│ ▸ 技术细节                                       │
└─────────────────────────────────────────────────┘
```

文案映射常量在前端：

| phase | 显示文案 |
|---|---|
| preparing | 准备 prompt |
| calling-llm | 调用 LLM 中 |
| parsing | 解析返回（重试中） |
| writing | 写入 spec / 问题 |

`attempt: 0` → "第 1 次"；`attempt: 1` → "第 2 次（重试）"。

`已用 Ns` 用 `useEffect` + `setInterval(1000)` 基于 `Date.now() - round.started_at`，本地刷新。

技术细节折叠（默认收起）：

- prompt 全文（`<pre>` + `whitespace-pre-wrap` + 滚动容器 `max-h-[400px]`）
- attempt 1 时上方多一段红框："上次解析失败：<last_parse_error>"

### §5 边界处理

| 场景 | 处理 |
|---|---|
| daemon 重启时 round 在跑 | Map 清空 → 前端 GET 返 null → 回退 idle 文案 + 重试按钮。watchdog 60s 兜底重新触发 round |
| WS 断连重连 | 连接恢复后前端主动 `getClarifierRound` 对齐 |
| watchdog 在旧 round emit errored 后快速触发新 round | `startRound` 同 reqId 直接覆盖旧 entry，phase 重置 preparing |
| prompt 超 16384 字符 | startRound / setPhase 内截断（保留前 16384 字符 + `…`） |
| last_parse_error 超 16384 字符 | 同上 |
| 测试中 bus 未激活 | `emit` 已是 no-op，无需特殊处理 |

## 测试

新增 `tests/clarifier-progress.test.ts`：

| 用例 | 断言 |
|---|---|
| `startRound` 后 `getRound` / `listAllActive` 可查到，state.phase='preparing' | ✓ |
| `setPhase("calling-llm", {attempt:0, prompt:"P"})` 字段正确更新 | ✓ |
| `endRound("done")` 后 `getRound` 返 undefined | ✓ |
| 同 reqId 第二次 `startRound` 覆盖旧 entry，started_at 更新 | ✓ |
| prompt 长度 17000 字符 → 存储 16384 字符 + `…` 尾标 | ✓ |
| `runClarifierRound` 完整跑一遍 mock LLM 成功路径，订阅 bus 收到 preparing → calling-llm → writing → done 序列 | ✓ |
| `runClarifierRound` mock LLM 第一次返回非 JSON、第二次返回正常，收到 calling-llm(att=0) → parsing(att=1, last_parse_error≠null) → calling-llm(att=1) → writing → done | ✓ |
| `runClarifierRound` mock LLM 两次都失败，收到 ... → errored，Map 已清空 | ✓ |
| `GET /api/requirements/:id/clarifier-round` 当前 round 在跑 → 200 { round: <state> } | ✓ |
| `GET /api/requirements/:id/clarifier-round` 当前无 round → 200 { round: null } | ✓ |
| `GET /api/requirements/:id/clarifier-round` requirement 不存在 → 404 | ✓ |

`tests/clarifier-redesign.test.ts` / `tests/clarifier-inflight-lock.test.ts` 现有用例预期通过（行为不变，仅新增 emit）；任何意外失败说明集成出了问题。

## 文件清单

**新建**：
- `src/daemon/clarifier-progress.ts`
- `tests/clarifier-progress.test.ts`

**修改**：
- `src/core/events.ts`：加 `requirement:clarifier-round-update` 事件类型
- `src/daemon/requirement-clarifier.ts`：在 §2 的 7 个位置注入 progress 调用
- `src/daemon/routes.ts`：加 `GET /api/requirements/:id/clarifier-round`
- `src/web/src/hooks/useApi.ts`：加 `ClarifierRoundState` 类型 + `getClarifierRound`
- `src/web/src/pages/RequirementDetail.tsx`：替换现有 spinner 区为进度卡，加 trace 折叠

## 不做的事

- 不持久化 trace（YAGNI；用户问"AI 在想什么"是当前态问题，过去 round 的 prompt 几乎没人会回看）
- 不做流式 partial response 显示（callClaude 非流式，改造成本与收益不匹配）
- 不上 /now 卡片（progress 是 RequirementDetail 局部信息）
- 不动 `_inflightRounds` 锁本身（PR #61 已加 trace log，下次锁失效复现再处理）
