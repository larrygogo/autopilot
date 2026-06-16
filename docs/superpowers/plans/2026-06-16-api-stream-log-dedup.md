# API 流式输出日志合并 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 消除 API 模式下每条流式文本碎片都触发一次 `log.info` 的刷屏问题，改为每轮 LLM 回复结束后合并记录一条完整日志。

**Architecture:** 仅改两处生产代码：① 删掉 `registry.ts` 里把 `onStream` 回调连到 `log.info` 的代码（共 4 行）；② 在 `loop.ts` 的 `withRetry` 调用返回后，若 `response.text` 非空则写一条 `log.info`。测试只在 `tests/api-agent-loop.test.ts` 追加一个 describe 块，全部使用内联 adapter 和 `log.info` 猴子补丁，不引入任何 Bash/文件系统以外的真实依赖。

**Tech Stack:** Bun、TypeScript、bun:test、`src/core/logger.ts`（`log` 单例）

---

## 需求分析

### 根因

`src/agents/registry.ts` 的 `createApiAgentLoop()`（约 217-220 行）：

```ts
onStream: (delta) => {
  log.info("%s", delta);
},
```

每收到一个流式文本片段（`onDelta`）就调用一次 `log.info`。`log.info` 内部：

1. `console.error(s)` 打到终端
2. `emit("log:entry")` → WebSocket → Web/TUI 实时推送
3. `appendPhaseLog` 追加到阶段磁盘日志
4. `appendFileLog` 追加到 daemon 进程日志

一次 LLM 回复几百个碎片 → 几百条带时间戳的独立日志行。

### 不受影响的路径

- CLI 子进程供应商（`src/agents/providers/anthropic.ts` 等）有独立 `onDelta` 路径，不经过 `registry.ts` 的 `onStream` 回调，无需改动。
- `reasoning_content`（OpenAI 兼容）的 `onDelta` 因为 `onStream` 不再传入而自动变成 no-op，无需改 `openai.ts`。

### 决策

- 方案 A（整段合并）：缓冲一次回复的所有碎片，回复结束时写 1 条完整日志。
- Web 执行视图里 agent 文本在该轮结束后一次性出现，无逐字打字效果（用户已接受）。
- `reasoning_content` 不写日志（只流式积累用于 content 为空时的回退，不进合并路径）。

---

## 文件结构（改动范围）

| 文件 | 类型 | 职责 |
|------|------|------|
| `src/agents/registry.ts` | **修改** | 删除 `onStream` 回调（4 行删除） |
| `src/agents/providers/api/loop.ts` | **修改** | 在 `withRetry` 返回后新增 3 行：`response.text` 非空时调 `log.info` |
| `tests/api-agent-loop.test.ts` | **修改** | 追加 describe 块：3 个测试，覆盖有文本/无文本/多轮场景 |

> ⚠️ **不改动**：`src/agents/providers/api/openai.ts`、`src/agents/providers/api/anthropic.ts`、`src/agents/providers/api/google.ts`、`src/core/logger.ts`、`src/daemon/ws.ts`。

---

## Task 1：写失败测试

**Files:**
- Modify: `tests/api-agent-loop.test.ts`（在文件末尾追加新 describe 块）

### 前置：确认当前测试全部绿

- [ ] **Step 1.1：运行现有测试确保基线通过**

```bash
cd C:/Users/larry/.autopilot/runtime/requirements/req-026/codebase/autopilot
bun test tests/api-agent-loop.test.ts
```

预期：全部 PASS，无 FAIL。

### 追加测试 describe 块

- [ ] **Step 1.2：在 `tests/api-agent-loop.test.ts` 末尾追加以下内容**

在文件最后一行（`}`，第 503 行的 `});`）之后追加：

```ts
// ── 每轮完整文本合并记录（无流式刷屏）──

describe("ApiAgentLoop — 每轮完整文本合并记录", () => {
  let sandbox2: string;
  let capturedLogs: Array<{ msg: string; args: unknown[] }>;
  let origLogInfo: typeof log.info;

  beforeAll(() => {
    sandbox2 = join(tmpdir(), `autopilot-log-merge-test-${Date.now()}`);
    mkdirSync(sandbox2, { recursive: true });
  });

  afterAll(() => {
    rmSync(sandbox2, { recursive: true, force: true });
  });

  beforeEach(() => {
    capturedLogs = [];
    origLogInfo = log.info;
    // 拦截 log.info，记录所有调用（不做真实 I/O）
    log.info = (msg: string, ...args: unknown[]) => {
      capturedLogs.push({ msg, args });
    };
  });

  afterEach(() => {
    log.info = origLogInfo;
  });

  it("有文本的轮次：完整文本被记录为单条 [API] 本轮输出日志", async () => {
    // 内联 adapter：模拟流式分 2 片触发 onDelta，但 response.text 是完整合并文本
    const adapter: ProviderAdapter = {
      name: "mock-merged",
      async completeStream(
        _messages: MessageParam[],
        _options: AdapterOptions,
        onDelta?: (delta: string) => void,
      ): Promise<AdapterResponse> {
        // 模拟流式碎片（registry.ts 删掉 onStream 后这里的 onDelta 是 undefined，调用是 no-op）
        if (onDelta) {
          onDelta("你好");
          onDelta("世界");
        }
        return {
          text: "你好世界",
          usage: { input_tokens: 5, output_tokens: 3 },
          stopReason: "end_turn",
        };
      },
    };

    const executor = ToolExecutor.fromConfig(sandbox2, "default");
    const loop = new ApiAgentLoop({
      adapter,
      toolExecutor: executor,
      model: "test-model",
      maxTurns: 5,
      // 注意：不传 onStream —— 模拟 registry.ts 改动后的使用方式
    });

    const result = await loop.run("test");
    expect(result.text).toBe("你好世界");

    // 关键断言：loop.ts 内部应记录一条包含完整文本的 [API] 本轮输出 日志
    const textLogs = capturedLogs.filter((l) => l.msg.includes("本轮输出"));
    expect(textLogs.length).toBe(1);
    expect(String(textLogs[0].args[0])).toBe("你好世界");
  });

  it("response.text 为空的轮次（纯工具调用）：不产生 [API] 本轮输出 日志", async () => {
    // 内联 adapter：text 为空字符串，只有 task_complete 工具调用
    const adapter: ProviderAdapter = {
      name: "mock-no-text",
      async completeStream(): Promise<AdapterResponse> {
        return {
          text: "",
          toolCalls: [{ id: "tc1", name: "task_complete", input: { summary: "任务完成" } }],
          usage: { input_tokens: 10, output_tokens: 5 },
          stopReason: "tool_use",
        };
      },
    };

    const executor = ToolExecutor.fromConfig(sandbox2, "default");
    const loop = new ApiAgentLoop({
      adapter,
      toolExecutor: executor,
      model: "test-model",
      maxTurns: 5,
    });

    const result = await loop.run("test");
    // task_complete summary 成为返回值
    expect(result.text).toBe("任务完成");

    // 关键断言：无文本轮次不产生 [API] 本轮输出 条目
    const textLogs = capturedLogs.filter((l) => l.msg.includes("本轮输出"));
    expect(textLogs.length).toBe(0);
  });

  it("多轮对话：每轮有文本时各记录一条，共两条", async () => {
    // 创建测试文件供 read_file 工具使用
    writeFileSync(join(sandbox2, "data.txt"), "文件内容");

    let callCount = 0;
    const adapter: ProviderAdapter = {
      name: "mock-multi-turn",
      async completeStream(): Promise<AdapterResponse> {
        callCount++;
        if (callCount === 1) {
          // 第一轮：LLM 先输出文字，再请求读文件
          return {
            text: "正在读取文件",
            toolCalls: [{ id: "tc1", name: "read_file", input: { path: "data.txt" } }],
            usage: { input_tokens: 10, output_tokens: 5 },
            stopReason: "tool_use",
          };
        }
        // 第二轮：返回最终答案
        return {
          text: "文件内容已读取完毕",
          usage: { input_tokens: 15, output_tokens: 8 },
          stopReason: "end_turn",
        };
      },
    };

    const executor = ToolExecutor.fromConfig(sandbox2, "bypassPermissions");
    const loop = new ApiAgentLoop({
      adapter,
      toolExecutor: executor,
      model: "test-model",
      maxTurns: 5,
    });

    const result = await loop.run("读取文件");
    expect(result.text).toBe("文件内容已读取完毕");

    // 关键断言：两轮各有文本，应产生两条 [API] 本轮输出 日志
    const textLogs = capturedLogs.filter((l) => l.msg.includes("本轮输出"));
    expect(textLogs.length).toBe(2);
    expect(String(textLogs[0].args[0])).toContain("正在读取文件");
    expect(String(textLogs[1].args[0])).toContain("文件内容已读取完毕");
  });
});
```

**⚠️ 重要：测试文件顶部需补充两处 import（现有文件缺少这两行）：**

**① 在第 15 行现有 bun:test import 中补充 `beforeEach, afterEach`：**
```ts
// 改前：
import { describe, it, expect, mock, beforeAll, afterAll } from "bun:test";
// 改后：
import { describe, it, expect, mock, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
```

**② 在第 23 行（`import { join } from "path";`）之后新增一行：**
```ts
import { log } from "../src/core/logger";
```

- [ ] **Step 1.3：运行测试，确认新增的 3 个测试全部 FAIL**

```bash
bun test tests/api-agent-loop.test.ts
```

预期输出（仅新增的 3 个失败）：
```
✗ ApiAgentLoop — 每轮完整文本合并记录 > 有文本的轮次：完整文本被记录为单条 [API] 本轮输出日志
  Expected: 1
  Received: 0

✗ ApiAgentLoop — 每轮完整文本合并记录 > response.text 为空的轮次...
  (此测试实际上可能通过，因为 loop.ts 还没写日志，0 === 0 ✓)

✗ ApiAgentLoop — 每轮完整文本合并记录 > 多轮对话：每轮有文本时各记录一条，共两条
  Expected: 2
  Received: 0
```

> 第 2 个测试（"无文本"）可能先通过，没关系；关键是 1 和 3 失败。

- [ ] **Step 1.4：Commit（仅测试）**

```bash
git add tests/api-agent-loop.test.ts
git commit -m "test: 添加 API 流式日志合并的失败测试"
```

---

## Task 2：修改 `loop.ts` — 每轮完整文本记录

**Files:**
- Modify: `src/agents/providers/api/loop.ts`（在 `withRetry` 返回后 3 行新增）

- [ ] **Step 2.1：在 `loop.ts` 中找到精确位置**

打开 `src/agents/providers/api/loop.ts`，定位到 `run()` 方法内的 `withRetry` 调用（约第 211-215 行）：

```ts
      // 流式调用 adapter
      const response = await withRetry(
        () => this.adapter.completeStream(messages, adapterOptions, this.onStream),
        3,
        runOpts?.signal,
      );

      // 累计 usage
      usage.input_tokens += response.usage.input_tokens;
```

- [ ] **Step 2.2：在 `withRetry` 返回后、"累计 usage" 之前插入日志**

将上述代码块改为：

```ts
      // 流式调用 adapter
      const response = await withRetry(
        () => this.adapter.completeStream(messages, adapterOptions, this.onStream),
        3,
        runOpts?.signal,
      );

      // 每轮回复结束后记录完整文本（非空时），替代流式碎片逐条打印
      if (response.text) {
        log.info("[API] 本轮输出：%s", response.text);
      }

      // 累计 usage
      usage.input_tokens += response.usage.input_tokens;
```

- [ ] **Step 2.3：运行测试，确认新增的 3 个测试全部 PASS**

```bash
bun test tests/api-agent-loop.test.ts
```

预期：原有测试全部 PASS，新增 3 个测试全部 PASS。

- [ ] **Step 2.4：Commit**

```bash
git add src/agents/providers/api/loop.ts
git commit -m "fix: API 模式每轮回复结束后记录完整文本，替代流式碎片逐条打印"
```

---

## Task 3：修改 `registry.ts` — 删除 `onStream` 逐碎片日志

**Files:**
- Modify: `src/agents/registry.ts`（约第 211-222 行）

- [ ] **Step 3.1：在 `registry.ts` 中找到精确位置**

打开 `src/agents/registry.ts`，定位到 `createApiAgentLoop()` 的 `return new ApiAgentLoop({...})` 块（约第 211-222 行）：

```ts
  return new ApiAgentLoop({
    adapter,
    toolExecutor,
    model: config.model ?? eff.default_model ?? "unknown",
    systemPrompt: config.system_prompt,
    maxTurns: config.max_turns ?? 10,
    onStream: (delta) => {
      // 推送到 logger（由 event-bus 分发到 WS）
      // 使用 %s 占位符防止 LLM 输出中的 %s/%d 等被当作 printf 格式串解析
      log.info("%s", delta);
    },
  });
```

- [ ] **Step 3.2：删除 `onStream` 回调，仅保留其他参数**

将上述块改为：

```ts
  return new ApiAgentLoop({
    adapter,
    toolExecutor,
    model: config.model ?? eff.default_model ?? "unknown",
    systemPrompt: config.system_prompt,
    maxTurns: config.max_turns ?? 10,
    // 不再逐 delta 记日志：流式碎片由 ApiAgentLoop 在每轮回复结束后合并为单条。
    // 参见 loop.ts run() 中的 log.info("[API] 本轮输出：%s", response.text)。
  });
```

- [ ] **Step 3.3：运行全量测试，确认无回归**

```bash
bun test tests/api-agent-loop.test.ts
```

预期：全部 PASS。

- [ ] **Step 3.4：Commit**

```bash
git add src/agents/registry.ts
git commit -m "fix: 去掉 registry.ts 中 onStream 的逐碎片 log.info，消除 API 模式日志刷屏"
```

---

## Task 4：最终验证

- [ ] **Step 4.1：运行完整测试套件**

```bash
bun test
```

预期：全部通过，无新 FAIL。

- [ ] **Step 4.2：类型检查**

```bash
bun run typecheck
```

预期：0 errors。

---

## 影响范围

| 维度 | 分析 |
|------|------|
| **API 模式日志行为** | 每次 LLM 回复由 N 条碎片日志 → 1 条完整日志 |
| **Web 执行视图实时效果** | agent 文本在该轮结束时一次性显示（无逐字效果），用户已接受 |
| **CLI 子进程模式** | 完全不受影响（走 `src/agents/providers/anthropic.ts` 等，不经过此路径）|
| **推理模型 reasoning_content** | `onDelta` 变 no-op（`onStream` 不再传入）；不进合并日志路径 |
| **工具调用日志** | `loop.ts` 里 `log.info("[API] 工具调用：%s", tc.name)` 保持不变 |
| **错误/重试日志** | `log.warn`/`log.error` 路径不受影响 |
| **WS 实时推送** | `log:entry` 事件仍会触发，只是从 N 条/回复变为 1 条/轮 |
| **磁盘日志大小** | 显著减小（N→1 条/轮） |

---

## 测试计划（已内置于 Task 1-4）

### 新增单元测试（`tests/api-agent-loop.test.ts`）

| 测试用例 | 验证要点 |
|---------|---------|
| 有文本的轮次 | `log.info` 被调用 1 次，msg 含 `本轮输出`，参数是完整文本 |
| 纯工具调用轮次（text 为空） | `log.info` 的 `本轮输出` 条目 = 0 条 |
| 多轮对话 | `log.info` 的 `本轮输出` 条目 = 2 条，各含对应轮的文本 |

### 不受影响的现有测试（回归保障）

- `onStream 回调接收文本增量`：`ApiAgentLoop` 的 `onStream` 选项本身仍可用，测试不变
- `工具调用 → 执行 → 继续对话 → 返回`：业务流程不变，只是多了日志调用
- 所有重试逻辑、task_complete、max_turns 测试：不涉及日志路径

### 测试设计原则（对应历史遗留问题的规避）

1. **不使用 Bash 工具**：测试全部为纯 TypeScript，文件操作只用 Node.js 内置 `fs` API
2. **不依赖 `createMockAdapter` 内部细节**：新增测试全部使用内联 adapter 对象，直接实现 `completeStream` 接口
3. **不依赖真实 API 请求**：内联 adapter 直接返回 mock 数据，无网络访问
4. **`log.info` 猴子补丁**：在 `beforeEach`/`afterEach` 中完整恢复，不污染其他测试
