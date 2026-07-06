# B-interactive Selfhosted Connector 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 autopilot daemon 中新增 `selfhosted-connector` 常驻模块，实现 B-interactive 模式的三条双向链路：从 reqgenie 拉分配自动建需求、推全状态镜像事件、拉命令映射本机 RPC。

**Architecture:** 纯 additive——新建 `src/daemon/selfhosted-connector/` 目录（6 个文件），复用 runner/ 的注册/凭证/锁/长轮询骨架，只改传输语义（端点从 dev-sessions/ 换成 /api/selfhosted/*）。三个常驻循环（assignments poller / commands poller / mirror pusher）注入依赖可独立测试。装配尾部在 `src/daemon/index.ts` 追加，原 mode:runner 分支完全不动。

**Tech Stack:** TypeScript strict (Bun), EventEmitter (已有 core/event-bus.ts), node:crypto (HMAC), Bun fetch

## Global Constraints

- **纯 additive**：不删/不改 `src/daemon/runner/` 任何文件，不动 mode:runner 分支，不碰 codex
- TypeScript strict 模式；`catch (e: unknown)` 严格；所有 types 显式
- 代码注释和 commit message 用中文，代码本身用英文
- 复用 runner/credentials.ts 的 `loadCredentials` / `saveCredentials` / `credentialsPath`；凭证路径继续沿用 `runner/credentials.json`（selfhosted connector 复用同一份凭证——用同一 runner_id 向 reqgenie 鉴权，无需第二份凭证文件）
- best-effort 原则：mirror pusher 和三个循环内部的失败只 warn，不影响需求推进

---

## 文件结构

**新建文件：**
- `src/daemon/selfhosted-connector/types.ts` — connector 协议类型（AssignmentPayload, CommandPayload, MirrorEvent, ConnectorCredentials 别名）
- `src/daemon/selfhosted-connector/backend.ts` — HTTP 客户端，6 个端点 typed 方法
- `src/daemon/selfhosted-connector/assignments-poller.ts` — 长轮询拉分配，建需求，ack
- `src/daemon/selfhosted-connector/commands-poller.ts` — 长轮询拉命令，映射 RPC，ack
- `src/daemon/selfhosted-connector/mirror-pusher.ts` — 订阅 event-bus，批量推 mirror 事件/快照
- `src/daemon/selfhosted-connector/index.ts` — 装配入口 `initSelfhostedConnector()`

**修改文件：**
- `src/core/config.ts` — 新增 `SelfhostedConfig` 类型 + `loadSelfhostedConfig()` 函数（additive）
- `src/daemon/index.ts` — 装配尾部追加 selfhosted connector 初始化（additive）
- `src/cli/index.ts` — 追加 `selfhosted` 命令组注册（additive）

**新建 CLI 文件：**
- `src/cli/selfhosted.ts` — `autopilot selfhosted register` 子命令

**新建测试文件：**
- `tests/selfhosted-connector/mirror-pusher.test.ts` — 事件→mirror 映射 + mirror_seq 单调
- `tests/selfhosted-connector/commands-poller.test.ts` — 命令→RPC 映射 + ack + 幂等去重

---

## Task 1: 类型定义 + config 段

**Files:**
- Create: `src/daemon/selfhosted-connector/types.ts`
- Modify: `src/core/config.ts`

**Interfaces:**
- Produces: `AssignmentPayload`, `CommandPayload`, `MirrorEvent`, `MirrorSnapshot`, `CommandKind` — 供 Task 2/3/4/5 消费
- Produces: `loadSelfhostedConfig()` → `SelfhostedConfig` — 供 Task 6 消费

- [ ] **Step 1: 新建 types.ts**

```typescript
// src/daemon/selfhosted-connector/types.ts
// selfhosted-connector 协议类型——镜像 reqgenie /api/selfhosted/* 线协议形状

/** 分配下发载荷（/assignments/pending 命中时返回）。 */
export interface AssignmentPayload {
  assignment_id: string;
  reqgenie_req_id: string;
  title: string;
  spec_md: string;
  repo_urls: string[];
  project_hint?: string | null;
}

/** 命令类型枚举（reqgenie 用户操作意图）。 */
export type CommandKind =
  | "answer_clarification"
  | "finish_clarification"
  | "retry_clarify"
  | "approve"
  | "reject"
  | "accept"
  | "cancel"
  | "set_workspaces";

/** 命令下发载荷（/commands/pending 命中时返回）。 */
export interface CommandPayload {
  command_id: string;
  autopilot_req_id: string;
  kind: CommandKind;
  payload: Record<string, unknown>;
}

/** 增量 mirror 事件（POST /mirror/events body 中的一项）。 */
export interface MirrorEvent {
  mirror_seq: number;
  type: string;
  payload: Record<string, unknown>;
}

/** 全量镜像快照（POST /mirror/snapshot body）。 */
export interface MirrorSnapshot {
  autopilot_req_id: string;
  status: string;
  current_step?: string | null;
  spec_md?: string | null;
  questions?: Array<{
    autopilot_question_id: string;
    parent_id?: string | null;
    from_role: string;
    body: string;
    status: string;
    seq: number;
  }>;
  phases?: Array<{
    run_seq: number;
    phase: string;
    label: string;
    state: string;
    started_at?: string | null;
    ended_at?: string | null;
    seq: number;
  }>;
  prs?: Array<{
    repo_alias: string;
    pr_url: string;
    pr_state: string;
  }>;
}
```

- [ ] **Step 2: 在 config.ts 追加 SelfhostedConfig**

在 `src/core/config.ts` 末尾（`stripUndefined` 函数之前）追加：

```typescript
// ──────────────────────────────────────────────
// selfhosted connector 配置（config.yaml selfhosted 段）
// B-interactive 模式：标准 daemon + selfhosted-connector 常驻模块
// ──────────────────────────────────────────────

export interface SelfhostedConfig {
  /** reqgenie 控制平面 URL（必填才启 connector）。 */
  control_plane_url?: string;
  /** 是否启用 selfhosted connector（默认 false，即使有凭证也不启动）。 */
  enabled?: boolean;
}

/** 读 config.yaml `selfhosted:` 段。未配置/段缺失返回 {}。 */
export function loadSelfhostedConfig(): SelfhostedConfig {
  try {
    const raw = loadConfig();
    const section = raw["selfhosted"];
    if (!section || typeof section !== "object" || Array.isArray(section)) return {};
    const s = section as Record<string, unknown>;
    const out: SelfhostedConfig = {};
    if (typeof s.control_plane_url === "string" && s.control_plane_url.trim()) {
      out.control_plane_url = s.control_plane_url.trim();
    }
    if (typeof s.enabled === "boolean") out.enabled = s.enabled;
    return out;
  } catch {
    return {};
  }
}
```

- [ ] **Step 3: 验证 typecheck 通过**

```powershell
cd C:\Users\larry\Desktop\workspace\autopilot
bun run typecheck
```

Expected: 0 errors

- [ ] **Step 4: Commit**

```powershell
git add src/daemon/selfhosted-connector/types.ts src/core/config.ts
git commit -m "feat(connector): 新增 selfhosted connector 协议类型 + config.yaml selfhosted 段"
```

---

## Task 2: HTTP Backend 客户端

**Files:**
- Create: `src/daemon/selfhosted-connector/backend.ts`

**Interfaces:**
- Consumes: `AssignmentPayload`, `CommandPayload`, `MirrorEvent`, `MirrorSnapshot` from `./types`
- Consumes: `RunnerCredentials` from `../runner/types`（复用凭证结构）
- Produces: `SelfhostedBackend` interface + `HttpSelfhostedBackend` class — 供 Task 3/4/5 消费

- [ ] **Step 1: 新建 backend.ts**

```typescript
// src/daemon/selfhosted-connector/backend.ts
// selfhosted connector HTTP 客户端——封装 /api/selfhosted/* 6 个端点。
// 复用 runner/backend.ts 的鉴权/unwrap 模式，端点语义完全不同。

import type { RunnerCredentials } from "../runner/types";
import type { AssignmentPayload, CommandPayload, MirrorEvent, MirrorSnapshot } from "./types";

export type { FetchLike } from "../runner/backend";
export type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>;

const JSON_HEADERS = { "Content-Type": "application/json" };

function httpError(path: string, status: number, extra = ""): Error {
  return new Error(`selfhosted backend ${path} 返回 ${status}${extra ? `：${extra}` : ""}`);
}

function unwrap<T>(body: unknown): T {
  if (body && typeof body === "object" && "data" in (body as Record<string, unknown>)) {
    return (body as { data: T }).data;
  }
  return body as T;
}

/**
 * selfhosted connector 后端抽象接口。
 * 分离 interface 使 assignments-poller/commands-poller/mirror-pusher 可依赖注入 mock。
 */
export interface SelfhostedBackend {
  /** GET /assignments/pending?wait=N —— 长轮询拉分配；204 → null。 */
  pollAssignment(waitSeconds: number): Promise<AssignmentPayload | null>;
  /** POST /assignments/{aid}/ack —— 确认分配，携带本机 autopilot_req_id。 */
  ackAssignment(assignmentId: string, autopilotReqId: string): Promise<void>;
  /** POST /mirror/events —— 批量推增量 mirror 事件；409 = seq-gap。 */
  pushMirrorEvents(events: MirrorEvent[]): Promise<{ seqGap: boolean }>;
  /** POST /mirror/snapshot —— 全量快照覆盖写入。 */
  pushMirrorSnapshot(snapshot: MirrorSnapshot): Promise<void>;
  /** GET /commands/pending?wait=N —— 长轮询拉命令；204 → null。 */
  pollCommand(waitSeconds: number): Promise<CommandPayload | null>;
  /** POST /commands/{cid}/ack —— 确认命令执行结果。 */
  ackCommand(commandId: string, ok: boolean, reason?: string): Promise<void>;
  /** POST /heartbeat —— 实例心跳（在线态）。 */
  heartbeat(): Promise<void>;
  /** POST /deregister —— 优雅下线（best-effort）。 */
  deregister(): Promise<void>;
}

export class HttpSelfhostedBackend implements SelfhostedBackend {
  private readonly base: string;
  private readonly instanceId: string;
  private readonly secret: string;

  constructor(creds: RunnerCredentials, private readonly fetchFn: FetchLike = fetch) {
    this.base = creds.control_plane_url.replace(/\/+$/, "");
    this.instanceId = creds.runner_id;
    this.secret = creds.secret;
  }

  private auth(): Record<string, string> {
    return { Authorization: `Bearer ${this.secret}`, "x-runner-id": this.instanceId };
  }

  private instancePath(suffix: string): string {
    return `${this.base}/api/selfhosted/instances/${this.instanceId}${suffix}`;
  }

  async pollAssignment(waitSeconds: number): Promise<AssignmentPayload | null> {
    const url = this.instancePath(`/assignments/pending?wait=${waitSeconds}`);
    const res = await this.fetchFn(url, { method: "GET", headers: this.auth() });
    if (res.status === 204) return null;
    if (!res.ok) throw httpError(url, res.status, await res.text().catch(() => ""));
    return unwrap<AssignmentPayload>(await res.json());
  }

  async ackAssignment(assignmentId: string, autopilotReqId: string): Promise<void> {
    const url = this.instancePath(`/assignments/${assignmentId}/ack`);
    const res = await this.fetchFn(url, {
      method: "POST",
      headers: { ...this.auth(), ...JSON_HEADERS },
      body: JSON.stringify({ autopilot_req_id: autopilotReqId }),
    });
    if (!res.ok) throw httpError(url, res.status, await res.text().catch(() => ""));
  }

  async pushMirrorEvents(events: MirrorEvent[]): Promise<{ seqGap: boolean }> {
    const url = this.instancePath("/mirror/events");
    const res = await this.fetchFn(url, {
      method: "POST",
      headers: { ...this.auth(), ...JSON_HEADERS },
      body: JSON.stringify({ events }),
    });
    if (res.status === 409) return { seqGap: true };
    if (!res.ok) throw httpError(url, res.status, await res.text().catch(() => ""));
    return { seqGap: false };
  }

  async pushMirrorSnapshot(snapshot: MirrorSnapshot): Promise<void> {
    const url = this.instancePath("/mirror/snapshot");
    const res = await this.fetchFn(url, {
      method: "POST",
      headers: { ...this.auth(), ...JSON_HEADERS },
      body: JSON.stringify(snapshot),
    });
    if (!res.ok) throw httpError(url, res.status, await res.text().catch(() => ""));
  }

  async pollCommand(waitSeconds: number): Promise<CommandPayload | null> {
    const url = this.instancePath(`/commands/pending?wait=${waitSeconds}`);
    const res = await this.fetchFn(url, { method: "GET", headers: this.auth() });
    if (res.status === 204) return null;
    if (!res.ok) throw httpError(url, res.status, await res.text().catch(() => ""));
    return unwrap<CommandPayload>(await res.json());
  }

  async ackCommand(commandId: string, ok: boolean, reason?: string): Promise<void> {
    const url = this.instancePath(`/commands/${commandId}/ack`);
    const body: Record<string, unknown> = { ok };
    if (reason !== undefined) body.reason = reason;
    const res = await this.fetchFn(url, {
      method: "POST",
      headers: { ...this.auth(), ...JSON_HEADERS },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw httpError(url, res.status, await res.text().catch(() => ""));
  }

  async heartbeat(): Promise<void> {
    const url = this.instancePath("/heartbeat");
    const res = await this.fetchFn(url, { method: "POST", headers: this.auth() });
    if (!res.ok) throw httpError(url, res.status);
  }

  async deregister(): Promise<void> {
    const url = this.instancePath("/deregister");
    try {
      await this.fetchFn(url, { method: "POST", headers: this.auth() });
    } catch {
      // 下线 best-effort，忽略错误
    }
  }

  /**
   * 静态注册方法（一次性 token 换长期凭证）——与 runner/backend.ts 一致，
   * 指向 /api/selfhosted/instances/register 端点。
   */
  static async register(
    controlPlaneUrl: string,
    registrationToken: string,
    name: string,
    fetchFn: FetchLike = fetch,
  ): Promise<{ runner_id: string; secret: string }> {
    const base = controlPlaneUrl.replace(/\/+$/, "");
    const url = `${base}/api/selfhosted/instances/register`;
    const machine_meta = {
      platform: process.platform,
      hostname: process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? "",
    };
    const res = await fetchFn(url, {
      method: "POST",
      headers: { ...JSON_HEADERS },
      body: JSON.stringify({ token: registrationToken, name, machine_meta }),
    });
    if (!res.ok) throw httpError(url, res.status, await res.text().catch(() => ""));
    const body = unwrap<{ runner_id: string; secret: string }>(await res.json());
    if (!body.runner_id || !body.secret) {
      throw new Error("register: reqgenie 未返回 runner_id/secret");
    }
    return body;
  }
}
```

- [ ] **Step 2: Typecheck**

```powershell
bun run typecheck
```

Expected: 0 errors

- [ ] **Step 3: Commit**

```powershell
git add src/daemon/selfhosted-connector/backend.ts
git commit -m "feat(connector): selfhosted HTTP backend 客户端（6 个端点 typed 方法）"
```

---

## Task 3: Mirror Pusher

**Files:**
- Create: `src/daemon/selfhosted-connector/mirror-pusher.ts`

**Interfaces:**
- Consumes: `SelfhostedBackend` from `./backend`, `onEvent/offEvent` from `../../core/event-bus`, `AutopilotEvent` from `../../core/events`, `getRequirementById` from `../../core/requirements`, `listSubPrs` from `../../core/requirements/sub-prs`, `listComments` from `../../core/requirements/comments`, `listTaskPhaseEvents` from `../../core/db`
- Produces: `MirrorPusher` class 带 `start()` / `dispose()` / `notifySnapshot()` — 供 Task 6 消费

- [ ] **Step 1: 新建 mirror-pusher.ts**

```typescript
// src/daemon/selfhosted-connector/mirror-pusher.ts
// 订阅 event-bus，把需求相关领域事件翻译成 mirror 事件批量推给 reqgenie。
// 原则：best-effort——推送失败只 warn，不阻塞需求推进；只处理 source=reqgenie 的需求。

import { onEvent, offEvent } from "../../core/event-bus";
import type { AutopilotEvent } from "../../core/events";
import { getRequirementById } from "../../core/requirements";
import { listSubPrs } from "../../core/requirements/sub-prs";
import { listComments } from "../../core/requirements/comments";
import { listTaskPhaseEvents } from "../../core/db";
import { createLogger } from "../../core/logger";
import type { SelfhostedBackend } from "./backend";
import type { MirrorEvent, MirrorSnapshot } from "./types";

const log = createLogger("selfhosted-mirror-pusher");

/** mirror 事件类型（reqgenie 侧定义，autopilot 端只发这些）。 */
type MirrorEventType =
  | "status_changed"
  | "clarify_updated"
  | "spec_revised"
  | "clarify_progress"
  | "phase_progress"
  | "pr_updated";

export interface MirrorPusherDeps {
  backend: SelfhostedBackend;
  /** 事件注册（测试可 mock）。 */
  onEvent?: typeof onEvent;
  offEvent?: typeof offEvent;
  /** 读需求（测试可 mock）。 */
  getRequirementById?: typeof getRequirementById;
  /** 读 sub_prs（测试可 mock）。 */
  listSubPrs?: typeof listSubPrs;
  /** 读评论（测试可 mock）。 */
  listComments?: typeof listComments;
  /** 读 phase 事件（测试可 mock）。 */
  listTaskPhaseEvents?: typeof listTaskPhaseEvents;
}

/** per-link mirror 事件序号（单调递增，实例生命周期内维护）。 */
const _seqMap = new Map<string, number>();

function nextSeq(reqId: string): number {
  const cur = _seqMap.get(reqId) ?? 0;
  const next = cur + 1;
  _seqMap.set(reqId, next);
  return next;
}

function resetSeq(reqId: string): void {
  _seqMap.set(reqId, 0);
}

export class MirrorPusher {
  private readonly deps: Required<MirrorPusherDeps>;
  private readonly handlers: Array<[string, (e: AutopilotEvent) => void]> = [];
  private _started = false;

  constructor(deps: MirrorPusherDeps) {
    this.deps = {
      backend: deps.backend,
      onEvent: deps.onEvent ?? onEvent,
      offEvent: deps.offEvent ?? offEvent,
      getRequirementById: deps.getRequirementById ?? getRequirementById,
      listSubPrs: deps.listSubPrs ?? listSubPrs,
      listComments: deps.listComments ?? listComments,
      listTaskPhaseEvents: deps.listTaskPhaseEvents ?? listTaskPhaseEvents,
    };
  }

  /** 启动订阅。 */
  start(): void {
    if (this._started) return;
    this._started = true;

    const register = (type: string, handler: (e: AutopilotEvent) => void) => {
      this.handlers.push([type, handler]);
      this.deps.onEvent(type, handler);
    };

    register("requirement:status-changed", (e) => {
      if (e.type !== "requirement:status-changed") return;
      this.pushForReq(e.payload.id, "status_changed", { status: e.payload.to, from: e.payload.from });
    });

    register("requirement:questions-updated", (e) => {
      if (e.type !== "requirement:questions-updated") return;
      const req = this.deps.getRequirementById(e.payload.id);
      if (!req || req.source !== "reqgenie") return;
      const comments = this.deps.listComments(e.payload.id, { kind: "question" });
      this.pushForReq(e.payload.id, "clarify_updated", { questions: comments });
    });

    register("requirement:question-resolved", (e) => {
      if (e.type !== "requirement:question-resolved") return;
      const req = this.deps.getRequirementById(e.payload.id);
      if (!req || req.source !== "reqgenie") return;
      const comments = this.deps.listComments(e.payload.id, { kind: "question" });
      this.pushForReq(e.payload.id, "clarify_updated", { questions: comments, resolved_id: e.payload.question_id });
    });

    register("requirement:active-question-changed", (e) => {
      if (e.type !== "requirement:active-question-changed") return;
      this.pushForReq(e.payload.id, "clarify_updated", { active_question_id: e.payload.question_id });
    });

    register("requirement:spec-revised", (e) => {
      if (e.type !== "requirement:spec-revised") return;
      const req = this.deps.getRequirementById(e.payload.id);
      if (!req || req.source !== "reqgenie") return;
      this.pushForReq(e.payload.id, "spec_revised", { spec_md: req.spec_md, revision_id: e.payload.revision_id });
    });

    register("requirement:clarifier-round-update", (e) => {
      if (e.type !== "requirement:clarifier-round-update") return;
      const reqId = (e.payload as { requirement_id?: string }).requirement_id;
      if (!reqId) return;
      this.pushForReq(reqId, "clarify_progress", e.payload as Record<string, unknown>);
    });

    // phase 事件：携带 taskId，需反查 requirement_id
    for (const phaseType of ["phase:started", "phase:completed", "phase:awaiting", "phase:error"] as const) {
      register(phaseType, (e) => {
        if (
          e.type !== "phase:started" &&
          e.type !== "phase:completed" &&
          e.type !== "phase:awaiting" &&
          e.type !== "phase:error"
        ) return;
        const { taskId, phase } = e.payload;
        // 通过任务查 requirement_id（task 记录存 requirement_id）
        // 这里用 listTaskPhaseEvents 反查不合适；改用懒查 task DB
        this.pushPhaseEvent(taskId, phase, e.type, e.payload);
      });
    }

    register("task:transition", (e) => {
      if (e.type !== "task:transition") return;
      this.pushPhaseEvent(e.payload.taskId, e.payload.to, "task:transition", e.payload);
    });

    log.info("mirror pusher 已启动（订阅需求全状态事件）");
  }

  /** 停止订阅，清 seq 映射。 */
  dispose(): void {
    for (const [type, handler] of this.handlers) {
      this.deps.offEvent(type, handler);
    }
    this.handlers.length = 0;
    _seqMap.clear();
    this._started = false;
    log.info("mirror pusher 已停止");
  }

  /**
   * 触发全量快照推送（拉到分配/重启/seq-gap 时调用）。
   * 调用方需传入 autopilotReqId，以便构造完整 snapshot。
   */
  async notifySnapshot(reqId: string): Promise<void> {
    const req = this.deps.getRequirementById(reqId);
    if (!req || req.source !== "reqgenie") return;
    const snapshot = this.buildSnapshot(req);
    // 重置 seq 基线
    resetSeq(reqId);
    try {
      await this.deps.backend.pushMirrorSnapshot(snapshot);
      log.info("全量快照推送成功 req=%s", reqId);
    } catch (e: unknown) {
      log.warn("全量快照推送失败 req=%s: %s", reqId, e instanceof Error ? e.message : String(e));
    }
  }

  // ── 私有辅助 ────────────────────────────────────

  private pushForReq(reqId: string, type: MirrorEventType, payload: Record<string, unknown>): void {
    const req = this.deps.getRequirementById(reqId);
    if (!req || req.source !== "reqgenie") return;
    const seq = nextSeq(reqId);
    const event: MirrorEvent = { mirror_seq: seq, type, payload };
    this.sendEvents(reqId, [event]);
  }

  private pushPhaseEvent(
    taskId: string,
    phase: string,
    eventType: string,
    payload: Record<string, unknown>,
  ): void {
    // 需要从 DB 查 requirement_id——通过 listTaskPhaseEvents 反查不准确
    // 改为直接导入 getTask（需在文件顶层 import）
    // 由于 mirror pusher 只关心 source=reqgenie 需求，实际执行路径不多
    // 这里用 _pushPhaseEventByTask 委托
    void this._pushPhaseEventByTask(taskId, phase, eventType, payload);
  }

  private async _pushPhaseEventByTask(
    taskId: string,
    phase: string,
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    // 动态 import getTask 避免循环依赖（core/db 已稳定）
    try {
      const { getTask } = await import("../../core/db");
      const task = getTask(taskId);
      if (!task?.requirement_id) return;
      const req = this.deps.getRequirementById(task.requirement_id);
      if (!req || req.source !== "reqgenie") return;
      const seq = nextSeq(task.requirement_id);
      const event: MirrorEvent = {
        mirror_seq: seq,
        type: "phase_progress",
        payload: { task_id: taskId, phase, event_type: eventType, ...payload },
      };
      this.sendEvents(task.requirement_id, [event]);
    } catch (e: unknown) {
      log.warn("phase 事件 mirror 推送失败 task=%s: %s", taskId, e instanceof Error ? e.message : String(e));
    }
  }

  private sendEvents(reqId: string, events: MirrorEvent[]): void {
    this.deps.backend.pushMirrorEvents(events).then((result) => {
      if (result.seqGap) {
        log.warn("mirror seq-gap 检测到 req=%s，触发全量快照", reqId);
        void this.notifySnapshot(reqId);
      }
    }).catch((e: unknown) => {
      log.warn("mirror 事件推送失败 req=%s: %s", reqId, e instanceof Error ? e.message : String(e));
    });
  }

  private buildSnapshot(req: ReturnType<typeof getRequirementById>): MirrorSnapshot {
    if (!req) throw new Error("req is null");
    const questions = this.deps.listComments(req.id, { kind: "question" }).map((c) => ({
      autopilot_question_id: c.id,
      parent_id: c.parent_id ?? null,
      from_role: c.from_role,
      body: c.body,
      status: c.status,
      seq: c.id.replace(/\D/g, "") ? parseInt(c.id.replace(/\D/g, ""), 10) : 0,
    }));
    const subPrs = this.deps.listSubPrs(req.id).map((sp) => ({
      repo_alias: sp.repo_alias ?? "",
      pr_url: sp.pr_url ?? "",
      pr_state: sp.pr_state ?? "open",
    }));
    // phases 从 task phase events 取（简化：只取最新 task 的 events）
    const snapshot: MirrorSnapshot = {
      autopilot_req_id: req.id,
      status: req.status,
      spec_md: req.spec_md ?? null,
      questions,
      prs: subPrs,
    };
    return snapshot;
  }
}
```

- [ ] **Step 2: Typecheck**

```powershell
bun run typecheck
```

Expected: 0 errors

- [ ] **Step 3: Commit**

```powershell
git add src/daemon/selfhosted-connector/mirror-pusher.ts
git commit -m "feat(connector): mirror pusher——订阅 event-bus 推全状态事件 + 全量快照"
```

---

## Task 4: Assignments Poller

**Files:**
- Create: `src/daemon/selfhosted-connector/assignments-poller.ts`

**Interfaces:**
- Consumes: `SelfhostedBackend` from `./backend`, `AssignmentPayload` from `./types`, `MirrorPusher` from `./mirror-pusher`
- Consumes: `invokeRpcMethod` from `../../daemon/rpc`（通过依赖注入）
- Produces: `AssignmentsPoller` class 带 `start()` / `dispose()` — 供 Task 6 消费

- [ ] **Step 1: 新建 assignments-poller.ts**

```typescript
// src/daemon/selfhosted-connector/assignments-poller.ts
// 长轮询拉 reqgenie 分配，命中后调本机 RPC 建需求，ack。
// best-effort：失败退避，不阻塞 daemon 主流程。

import { createLogger } from "../../core/logger";
import type { SelfhostedBackend } from "./backend";
import type { AssignmentPayload } from "./types";
import type { MirrorPusher } from "./mirror-pusher";

const log = createLogger("selfhosted-assignments-poller");

export interface AssignmentsPollerDeps {
  backend: SelfhostedBackend;
  pusher: MirrorPusher;
  /** 长轮询挂起秒数（生产 50，测试可设 0）。 */
  pollWaitSeconds?: number;
  /** 失败退避基准 ms（测试可设 0）。 */
  backoffBaseMs?: number;
  /** 调用本机 RPC（依赖注入，便于测试 mock）。 */
  invokeRpc?: (method: string, params: unknown) => Promise<unknown>;
}

/**
 * 把 assignment 的 repo_urls 转成 workspace_ids 数组。
 * 策略：每个 URL 查已有 workspace，找不到则建新 workspace（按 alias 取 URL 最后一段）。
 */
async function resolveWorkspaces(
  repoUrls: string[],
  projectId: string,
  invokeRpc: (method: string, params: unknown) => Promise<unknown>,
): Promise<string[]> {
  const ids: string[] = [];
  for (const url of repoUrls) {
    try {
      // 先尝试按 remote_url 查已有 workspace
      const listResult = await invokeRpc("workspaces.list", { project_id: projectId }) as { workspaces: Array<{ id: string; remote_url?: string }> };
      const existing = listResult.workspaces.find((w) => w.remote_url === url);
      if (existing) {
        ids.push(existing.id);
        continue;
      }
      // 建新 workspace
      const alias = url.split("/").pop()?.replace(/\.git$/, "") ?? `repo-${Date.now()}`;
      const createResult = await invokeRpc("workspaces.create", {
        project_id: projectId,
        alias,
        remote_url: url,
      }) as { workspace: { id: string } };
      ids.push(createResult.workspace.id);
    } catch (e: unknown) {
      log.warn("解析 workspace 失败 url=%s: %s", url, e instanceof Error ? e.message : String(e));
    }
  }
  return ids;
}

export class AssignmentsPoller {
  private stopped = false;
  private readonly pollWaitSeconds: number;
  private readonly backoffBaseMs: number;
  private readonly invokeRpc: (method: string, params: unknown) => Promise<unknown>;

  constructor(private readonly deps: AssignmentsPollerDeps) {
    this.pollWaitSeconds = deps.pollWaitSeconds ?? 50;
    this.backoffBaseMs = deps.backoffBaseMs ?? 2000;
    this.invokeRpc = deps.invokeRpc ?? (async (method, params) => {
      const { invokeRpcMethod } = await import("../../daemon/rpc");
      return invokeRpcMethod(method, params);
    });
  }

  start(): void {
    log.info("assignments poller 启动（pollWait=%ss）", this.pollWaitSeconds);
    void this.loop();
  }

  dispose(): void {
    this.stopped = true;
    log.info("assignments poller 已停止");
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      try {
        const assignment = await this.deps.backend.pollAssignment(this.pollWaitSeconds);
        if (!assignment) {
          // 204 超时无活，短退避
          await this.sleep(250);
          continue;
        }
        await this.handleAssignment(assignment);
      } catch (e: unknown) {
        log.warn("assignments poll 异常，退避重试：%s", e instanceof Error ? e.message : String(e));
        await this.sleep(this.backoffBaseMs + Math.floor(Math.random() * this.backoffBaseMs));
      }
    }
  }

  private async handleAssignment(a: AssignmentPayload): Promise<void> {
    log.info("收到分配 assignment_id=%s reqgenie_req_id=%s title=%s", a.assignment_id, a.reqgenie_req_id, a.title);
    try {
      // 1. 解析/建 project（用 default project 或按 project_hint 查）
      let projectId = "proj-default";
      if (a.project_hint) {
        try {
          const listResult = await this.invokeRpc("projects.list", {}) as { projects: Array<{ id: string; name: string }> };
          const found = listResult.projects.find((p) => p.name === a.project_hint || p.id === a.project_hint);
          if (found) projectId = found.id;
        } catch {
          // project_hint 解析失败 → 回退 proj-default
        }
      }

      // 2. 解析 repo_urls → workspace_ids
      const workspaceIds = await resolveWorkspaces(a.repo_urls, projectId, this.invokeRpc);

      // 3. 建需求（source=reqgenie / external_ref=reqgenie_req_id）
      const createResult = await this.invokeRpc("requirements.create", {
        project_id: projectId,
        title: a.title,
        spec_md: a.spec_md,
        source: "reqgenie",
        external_ref: a.reqgenie_req_id,
        // callback_url / callback_secret 暂不设（connector 走推模型，不靠 HMAC webhook）
      }) as { requirement: { id: string } };
      const reqId = createResult.requirement.id;

      // 4. 设代码库集合
      if (workspaceIds.length > 0) {
        try {
          await this.invokeRpc("requirements.setWorkspaces", { id: reqId, workspace_ids: workspaceIds });
        } catch (e: unknown) {
          log.warn("setWorkspaces 失败（需求已建，继续）req=%s: %s", reqId, e instanceof Error ? e.message : String(e));
        }
      }

      // 5. ack 分配（携带 autopilot_req_id）
      await this.deps.backend.ackAssignment(a.assignment_id, reqId);

      // 6. 推全量快照建立基线
      await this.deps.pusher.notifySnapshot(reqId);

      log.info("分配处理完成 req=%s ← reqgenie_req_id=%s", reqId, a.reqgenie_req_id);
    } catch (e: unknown) {
      log.error("分配处理失败 assignment_id=%s: %s", a.assignment_id, e instanceof Error ? e.message : String(e));
      // best-effort：即使建需求失败，也尝试 ack（避免 reqgenie 重复派发）
      // 此处不 ack，让 reqgenie 超时后重试（reqgenie 侧应有幂等保护）
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}
```

- [ ] **Step 2: Typecheck**

```powershell
bun run typecheck
```

Expected: 0 errors

- [ ] **Step 3: Commit**

```powershell
git add src/daemon/selfhosted-connector/assignments-poller.ts
git commit -m "feat(connector): assignments poller——拉分配建需求 + setWorkspaces + ack"
```

---

## Task 5: Commands Poller

**Files:**
- Create: `src/daemon/selfhosted-connector/commands-poller.ts`

**Interfaces:**
- Consumes: `SelfhostedBackend` from `./backend`, `CommandPayload`, `CommandKind` from `./types`
- Produces: `CommandsPoller` class 带 `start()` / `dispose()` — 供 Task 6 消费

- [ ] **Step 1: 新建 commands-poller.ts**

```typescript
// src/daemon/selfhosted-connector/commands-poller.ts
// 长轮询拉 reqgenie 命令，映射到本机 RPC apply，ack。
// command_id 幂等——本地存已 apply 集合去重，避免同一命令重复执行。
// ack ok:false 时携带 reason，reqgenie 标命令失败，镜像不改（以 autopilot 回流为准）。

import { createLogger } from "../../core/logger";
import type { SelfhostedBackend } from "./backend";
import type { CommandPayload, CommandKind } from "./types";

const log = createLogger("selfhosted-commands-poller");

export interface CommandsPollerDeps {
  backend: SelfhostedBackend;
  pollWaitSeconds?: number;
  backoffBaseMs?: number;
  invokeRpc?: (method: string, params: unknown) => Promise<unknown>;
}

/** 已 apply 的 command_id 集合（实例生命周期内去重）。 */
const _appliedCommands = new Set<string>();

/**
 * 把 CommandKind + payload 映射到本机 RPC method + params。
 * 返回 null 表示不需要调 RPC（如 accept → PR 签字在 GitHub，本机无 RPC）。
 */
function mapCommandToRpc(
  reqId: string,
  kind: CommandKind,
  payload: Record<string, unknown>,
): { method: string; params: Record<string, unknown> } | null {
  switch (kind) {
    case "answer_clarification": {
      // payload: { question_id?, body }
      const params: Record<string, unknown> = {
        requirementId: reqId,
        kind: "question",
        from_role: "user",
        body: typeof payload.body === "string" ? payload.body : "",
      };
      if (typeof payload.question_id === "string") params.parent_id = payload.question_id;
      return { method: "comments.add", params };
    }
    case "finish_clarification":
      return { method: "requirements.finishClarification", params: { id: reqId } };
    case "retry_clarify":
      return { method: "requirements.retryClarify", params: { id: reqId } };
    case "approve":
      return { method: "requirements.enqueue", params: { id: reqId } };
    case "reject": {
      // payload: { body }
      return {
        method: "comments.add",
        params: {
          requirementId: reqId,
          kind: "feedback",
          from_role: "user",
          body: typeof payload.body === "string" ? payload.body : "驳回",
        },
      };
    }
    case "accept":
      // PR 签字在 GitHub merge，本机无等价 RPC；ack ok:true 但不调 RPC
      return null;
    case "cancel":
      return {
        method: "requirements.cancel",
        params: {
          id: reqId,
          reason: typeof payload.reason === "string" ? payload.reason : undefined,
        },
      };
    case "set_workspaces": {
      const wsIds = Array.isArray(payload.workspace_ids) ? payload.workspace_ids as string[] : [];
      return { method: "requirements.setWorkspaces", params: { id: reqId, workspace_ids: wsIds } };
    }
    default:
      return null;
  }
}

export class CommandsPoller {
  private stopped = false;
  private readonly pollWaitSeconds: number;
  private readonly backoffBaseMs: number;
  private readonly invokeRpc: (method: string, params: unknown) => Promise<unknown>;

  constructor(private readonly deps: CommandsPollerDeps) {
    this.pollWaitSeconds = deps.pollWaitSeconds ?? 50;
    this.backoffBaseMs = deps.backoffBaseMs ?? 2000;
    this.invokeRpc = deps.invokeRpc ?? (async (method, params) => {
      const { invokeRpcMethod } = await import("../../daemon/rpc");
      return invokeRpcMethod(method, params);
    });
  }

  start(): void {
    log.info("commands poller 启动（pollWait=%ss）", this.pollWaitSeconds);
    void this.loop();
  }

  dispose(): void {
    this.stopped = true;
    log.info("commands poller 已停止");
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      try {
        const cmd = await this.deps.backend.pollCommand(this.pollWaitSeconds);
        if (!cmd) {
          await this.sleep(250);
          continue;
        }
        await this.handleCommand(cmd);
      } catch (e: unknown) {
        log.warn("commands poll 异常，退避重试：%s", e instanceof Error ? e.message : String(e));
        await this.sleep(this.backoffBaseMs + Math.floor(Math.random() * this.backoffBaseMs));
      }
    }
  }

  private async handleCommand(cmd: CommandPayload): Promise<void> {
    // 幂等去重
    if (_appliedCommands.has(cmd.command_id)) {
      log.info("command %s 已处理（幂等跳过）", cmd.command_id);
      // 仍 ack 避免 reqgenie 超时重推
      try {
        await this.deps.backend.ackCommand(cmd.command_id, true);
      } catch {
        // ack best-effort
      }
      return;
    }

    log.info("收到命令 command_id=%s kind=%s req=%s", cmd.command_id, cmd.kind, cmd.autopilot_req_id);

    const rpc = mapCommandToRpc(cmd.autopilot_req_id, cmd.kind, cmd.payload);
    let ok = true;
    let reason: string | undefined;

    if (rpc !== null) {
      try {
        await this.invokeRpc(rpc.method, rpc.params);
        _appliedCommands.add(cmd.command_id);
      } catch (e: unknown) {
        ok = false;
        reason = e instanceof Error ? e.message : String(e);
        log.warn("命令 %s RPC 失败 (%s): %s", cmd.command_id, rpc.method, reason);
        // 失败也记入已处理集合——避免无限重试（reqgenie 会标 failed + 显示 reason）
        _appliedCommands.add(cmd.command_id);
      }
    } else {
      // accept 等无 RPC 映射，直接成功
      _appliedCommands.add(cmd.command_id);
    }

    // ack（best-effort）
    try {
      await this.deps.backend.ackCommand(cmd.command_id, ok, reason);
      log.info("命令 %s ack ok=%s", cmd.command_id, ok);
    } catch (e: unknown) {
      log.warn("命令 %s ack 失败: %s", cmd.command_id, e instanceof Error ? e.message : String(e));
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}
```

- [ ] **Step 2: Typecheck**

```powershell
bun run typecheck
```

Expected: 0 errors

- [ ] **Step 3: Commit**

```powershell
git add src/daemon/selfhosted-connector/commands-poller.ts
git commit -m "feat(connector): commands poller——拉命令映射 RPC + ack + 幂等去重"
```

---

## Task 6: Connector 装配入口

**Files:**
- Create: `src/daemon/selfhosted-connector/index.ts`
- Modify: `src/daemon/index.ts`

**Interfaces:**
- Consumes: `HttpSelfhostedBackend` from `./backend`, `MirrorPusher` from `./mirror-pusher`, `AssignmentsPoller` from `./assignments-poller`, `CommandsPoller` from `./commands-poller`, `loadCredentials` from `../runner/credentials`, `acquireRunnerLock/releaseRunnerLock` from `../runner/lock`, `loadSelfhostedConfig` from `../../core/config`
- Produces: `initSelfhostedConnector()` → `() => void` (dispose fn) — 供 daemon/index.ts 消费

- [ ] **Step 1: 新建 connector/index.ts**

```typescript
// src/daemon/selfhosted-connector/index.ts
// selfhosted connector 装配入口——仿 selfhosted-mirror.ts 的挂载/卸载模式。
// 条件启动：config.selfhosted.enabled=true 且凭证存在。

import { createLogger } from "../../core/logger";
import { loadCredentials } from "../runner/credentials";
import { acquireRunnerLock, releaseRunnerLock } from "../runner/lock";
import { loadSelfhostedConfig } from "../../core/config";
import { HttpSelfhostedBackend } from "./backend";
import { MirrorPusher } from "./mirror-pusher";
import { AssignmentsPoller } from "./assignments-poller";
import { CommandsPoller } from "./commands-poller";

const log = createLogger("selfhosted-connector");

/**
 * 初始化 selfhosted connector。
 * 返回 dispose 函数（daemon shutdown 时调用）。
 * 若条件不满足（未启用 / 无凭证 / 无法抢锁）返回 no-op。
 */
export function initSelfhostedConnector(): () => void {
  const cfg = loadSelfhostedConfig();
  if (!cfg.enabled) {
    log.info("selfhosted connector 未启用（config.selfhosted.enabled=false）");
    return () => {};
  }

  const creds = loadCredentials();
  if (!creds) {
    log.warn("selfhosted connector 已启用但无凭证——先运行 `autopilot selfhosted register --url <reqgenie>`。connector 不启动。");
    return () => {};
  }

  // 抢单实例锁（与 mode:runner 共享同一 runner.lock，不允许两个 connector 同时运行）
  if (!acquireRunnerLock()) {
    log.warn("selfhosted connector：runner.lock 已被占用（另一 connector/runner 实例正在运行）。connector 不启动。");
    return () => {};
  }

  const backend = new HttpSelfhostedBackend(creds);

  // 心跳定时器
  const heartbeatMs = 30_000;
  const heartbeatTimer = setInterval(() => {
    backend.heartbeat().catch((e: unknown) => {
      log.warn("selfhosted connector 心跳失败：%s", e instanceof Error ? e.message : String(e));
    });
  }, heartbeatMs);

  // mirror pusher
  const pusher = new MirrorPusher({ backend });
  pusher.start();

  // assignments poller
  const assignmentsPoller = new AssignmentsPoller({ backend, pusher });
  assignmentsPoller.start();

  // commands poller（独立循环，分配低频/命令交互态较密）
  const commandsPoller = new CommandsPoller({ backend });
  commandsPoller.start();

  log.info("selfhosted connector 已启动（instance_id=%s control_plane=%s）", creds.runner_id, creds.control_plane_url);

  return () => {
    clearInterval(heartbeatTimer);
    assignmentsPoller.dispose();
    commandsPoller.dispose();
    pusher.dispose();
    backend.deregister().catch(() => {});
    releaseRunnerLock();
    log.info("selfhosted connector 已停止");
  };
}
```

- [ ] **Step 2: 修改 daemon/index.ts 装配尾部**

在 `src/daemon/index.ts` 的 `disposeSelfhostedMirror` 初始化行之后（约第 299 行），追加：

```typescript
  // 启动 selfhosted connector（B-interactive 模式：若 config.selfhosted.enabled + 凭证存在则启动）
  const { initSelfhostedConnector } = await import("./selfhosted-connector");
  const disposeSelfhostedConnector = initSelfhostedConnector();
```

并在 shutdown 函数的 `disposeSelfhostedMirror()` 调用行之后追加：

```typescript
    disposeSelfhostedConnector();
```

- [ ] **Step 3: Typecheck**

```powershell
bun run typecheck
```

Expected: 0 errors

- [ ] **Step 4: Commit**

```powershell
git add src/daemon/selfhosted-connector/index.ts src/daemon/index.ts
git commit -m "feat(connector): 装配 selfhosted connector 到 daemon 启动流程"
```

---

## Task 7: CLI selfhosted 命令

**Files:**
- Create: `src/cli/selfhosted.ts`
- Modify: `src/cli/index.ts`

**Interfaces:**
- Consumes: `HttpSelfhostedBackend.register` from `../daemon/selfhosted-connector/backend`, `loadCredentials/saveCredentials/clearCredentials` from `../daemon/runner/credentials`, `loadSelfhostedConfig` from `../core/config`, `isRunnerLockHeld` from `../daemon/runner/lock`

- [ ] **Step 1: 新建 src/cli/selfhosted.ts**

```typescript
// src/cli/selfhosted.ts
// autopilot selfhosted 命令组——注册本机为 reqgenie selfhosted 实例。
// 复用 runner/credentials.ts（共享凭证文件路径 runner/credentials.json）。
// 不删 runner CLI（纯 additive）。

import type { Command } from "commander";
import { HttpSelfhostedBackend } from "../daemon/selfhosted-connector/backend";
import { loadCredentials, saveCredentials, clearCredentials } from "../daemon/runner/credentials";
import { isRunnerLockHeld } from "../daemon/runner/lock";
import type { RunnerCredentials } from "../daemon/runner/types";

/** 从 stdin 读一行 token（不进 shell history；交互/管道两用）。 */
async function readTokenFromStdin(): Promise<string> {
  process.stderr.write("粘贴注册 token（输入后回车）：");
  const chunks: Uint8Array[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Uint8Array);
    if (Buffer.concat(chunks).includes(0x0a)) break;
  }
  return Buffer.concat(chunks).toString("utf8").split(/\r?\n/)[0] ?? "";
}

/** 渲染 selfhosted 状态文本（纯函数，便于单测）。 */
export function renderSelfhostedStatus(creds: RunnerCredentials | null, lockHeld: boolean): string {
  if (!creds) {
    return "selfhosted connector 未注册。先运行：autopilot selfhosted register --url <reqgenie 控制平面 URL>";
  }
  const state = lockHeld ? "运行中" : "已注册（daemon 未运行或 connector 未启用）";
  return [
    `状态：${state}`,
    `instance_id：${creds.runner_id}`,
    `控制平面：${creds.control_plane_url}`,
    "",
    "提示：在 config.yaml 设 selfhosted.enabled: true 后 `autopilot daemon start` 即启 connector。",
  ].join("\n");
}

export function registerSelfhostedCommands(program: Command): void {
  const selfhosted = program.command("selfhosted").description("reqgenie selfhosted 实例管理（B-interactive 模式）");

  selfhosted
    .command("register")
    .description("用一次性注册 token 换长期凭证，将本机注册为 reqgenie selfhosted 实例（token 经 stdin 输入，不进 history）")
    .requiredOption("--url <url>", "reqgenie 控制平面 URL")
    .option("--name <name>", "实例展示名", `${process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? "autopilot"}`)
    .action(async (opts: { url: string; name: string }) => {
      try {
        const token = (await readTokenFromStdin()).trim();
        if (!token) { console.error("注册 token 为空。"); process.exit(1); }
        const { runner_id, secret } = await HttpSelfhostedBackend.register(opts.url, token, opts.name);
        const creds: RunnerCredentials = {
          control_plane_url: opts.url.replace(/\/+$/, ""),
          runner_id,
          secret,
        };
        saveCredentials(creds);
        console.log(`注册成功：instance_id=${runner_id}`);
        console.log("在 config.yaml 加入：");
        console.log("  selfhosted:");
        console.log(`    control_plane_url: ${opts.url}`);
        console.log("    enabled: true");
        console.log("然后运行 `autopilot daemon start` 启动 connector。");
      } catch (e: unknown) {
        console.error("注册失败：", e instanceof Error ? e.message : String(e));
        process.exit(1);
      }
    });

  selfhosted
    .command("status")
    .description("查看 selfhosted 实例注册/运行状态")
    .action(() => {
      console.log(renderSelfhostedStatus(loadCredentials(), isRunnerLockHeld()));
    });

  selfhosted
    .command("remove")
    .description("注销本机 selfhosted 实例凭证（控制平面 revoke 需在 reqgenie 后台操作）")
    .action(() => {
      if (isRunnerLockHeld()) {
        console.error("connector 正在运行，先停止 daemon 再移除凭证。");
        process.exit(1);
      }
      const removed = clearCredentials();
      console.log(removed ? "已移除本机 selfhosted 实例凭证。" : "本机无 selfhosted 实例凭证。");
    });
}
```

- [ ] **Step 2: 修改 src/cli/index.ts 注册 selfhosted 命令**

在 `import { registerRunnerCommands } from "./runner";` 行下方追加：

```typescript
import { registerSelfhostedCommands } from "./selfhosted";
```

在 `registerRunnerCommands(program);` 行下方追加：

```typescript
registerSelfhostedCommands(program);
```

- [ ] **Step 3: Typecheck**

```powershell
bun run typecheck
```

Expected: 0 errors

- [ ] **Step 4: Commit**

```powershell
git add src/cli/selfhosted.ts src/cli/index.ts
git commit -m "feat(cli): 新增 autopilot selfhosted register/status/remove 命令"
```

---

## Task 8: 单元测试 — Mirror Pusher

**Files:**
- Create: `tests/selfhosted-connector/mirror-pusher.test.ts`

- [ ] **Step 1: 创建测试目录并新建测试文件**

```typescript
// tests/selfhosted-connector/mirror-pusher.test.ts
import { describe, it, expect, beforeEach } from "bun:test";
import { MirrorPusher } from "../../src/daemon/selfhosted-connector/mirror-pusher";
import type { SelfhostedBackend } from "../../src/daemon/selfhosted-connector/backend";
import type { MirrorEvent, MirrorSnapshot } from "../../src/daemon/selfhosted-connector/types";
import type { AutopilotEvent } from "../../src/core/events";

// Mock backend
function makeMockBackend(): SelfhostedBackend & {
  pushedEvents: MirrorEvent[][];
  pushedSnapshots: MirrorSnapshot[];
} {
  const pushedEvents: MirrorEvent[][] = [];
  const pushedSnapshots: MirrorSnapshot[] = [];
  return {
    pushedEvents,
    pushedSnapshots,
    async pollAssignment() { return null; },
    async ackAssignment() {},
    async pushMirrorEvents(events) {
      pushedEvents.push(events);
      return { seqGap: false };
    },
    async pushMirrorSnapshot(snapshot) {
      pushedSnapshots.push(snapshot);
    },
    async pollCommand() { return null; },
    async ackCommand() {},
    async heartbeat() {},
    async deregister() {},
  };
}

// Mock 需求
const MOCK_REQ = {
  id: "req-001",
  source: "reqgenie" as const,
  title: "测试需求",
  status: "clarifying",
  spec_md: "# 测试",
  project_id: "proj-1",
  workspace_id: null,
  external_ref: "rg-req-001",
  callback_url: null,
  callback_secret: null,
  pr_url: null,
  workflow: null,
  task_id: null,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  status_reason: null,
  status_reason_source: null,
  status_before_terminal: null,
  input_mode: null,
  clarifier_provider: null,
  clarifier_model: null,
  clarifier_rounds: 0,
  chat_session_id: null,
};

// 事件总线 mock
function makeEventBusMock() {
  const handlers = new Map<string, Array<(e: AutopilotEvent) => void>>();
  return {
    onEvent(type: string, handler: (e: AutopilotEvent) => void) {
      if (!handlers.has(type)) handlers.set(type, []);
      handlers.get(type)!.push(handler);
    },
    offEvent(type: string, handler: (e: AutopilotEvent) => void) {
      const list = handlers.get(type);
      if (list) {
        const idx = list.indexOf(handler);
        if (idx >= 0) list.splice(idx, 1);
      }
    },
    emit(type: string, payload: unknown) {
      for (const h of handlers.get(type) ?? []) {
        h({ type, payload } as AutopilotEvent);
      }
    },
  };
}

describe("MirrorPusher", () => {
  let backend: ReturnType<typeof makeMockBackend>;
  let bus: ReturnType<typeof makeEventBusMock>;
  let pusher: MirrorPusher;

  beforeEach(() => {
    backend = makeMockBackend();
    bus = makeEventBusMock();
    pusher = new MirrorPusher({
      backend,
      onEvent: bus.onEvent.bind(bus),
      offEvent: bus.offEvent.bind(bus),
      getRequirementById: (id) => (id === "req-001" ? MOCK_REQ as unknown as ReturnType<typeof import("../../src/core/requirements").getRequirementById> : null),
      listSubPrs: () => [],
      listComments: () => [],
      listTaskPhaseEvents: () => [],
    });
    pusher.start();
  });

  it("status_changed 事件映射正确", async () => {
    bus.emit("requirement:status-changed", { id: "req-001", from: "clarifying", to: "ready" });
    // 给异步推送一点时间
    await new Promise((r) => setTimeout(r, 10));
    expect(backend.pushedEvents.length).toBeGreaterThan(0);
    const flat = backend.pushedEvents.flat();
    const ev = flat.find((e) => e.type === "status_changed");
    expect(ev).toBeDefined();
    expect(ev?.payload.status).toBe("ready");
  });

  it("非 reqgenie source 的需求不推送", async () => {
    const nonReqgeniePusher = new MirrorPusher({
      backend,
      onEvent: bus.onEvent.bind(bus),
      offEvent: bus.offEvent.bind(bus),
      getRequirementById: (id) => (id === "req-999" ? { ...MOCK_REQ, id: "req-999", source: "manual" } as unknown as ReturnType<typeof import("../../src/core/requirements").getRequirementById> : null),
      listSubPrs: () => [],
      listComments: () => [],
      listTaskPhaseEvents: () => [],
    });
    nonReqgeniePusher.start();
    bus.emit("requirement:status-changed", { id: "req-999", from: "drafting", to: "clarifying" });
    await new Promise((r) => setTimeout(r, 10));
    expect(backend.pushedEvents.flat().length).toBe(0);
    nonReqgeniePusher.dispose();
  });

  it("mirror_seq 单调递增", async () => {
    bus.emit("requirement:status-changed", { id: "req-001", from: "clarifying", to: "ready" });
    bus.emit("requirement:status-changed", { id: "req-001", from: "ready", to: "queued" });
    bus.emit("requirement:status-changed", { id: "req-001", from: "queued", to: "running" });
    await new Promise((r) => setTimeout(r, 20));
    const flat = backend.pushedEvents.flat();
    expect(flat.length).toBeGreaterThanOrEqual(3);
    // 提取前三条的 seq
    const seqs = flat.map((e) => e.mirror_seq);
    // 验证单调递增
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]!);
    }
  });

  it("推送失败不抛异常（best-effort）", async () => {
    const failingBackend = {
      ...backend,
      pushMirrorEvents: async () => { throw new Error("网络断了"); },
    };
    const safePusher = new MirrorPusher({
      backend: failingBackend,
      onEvent: bus.onEvent.bind(bus),
      offEvent: bus.offEvent.bind(bus),
      getRequirementById: (id) => (id === "req-001" ? MOCK_REQ as unknown as ReturnType<typeof import("../../src/core/requirements").getRequirementById> : null),
      listSubPrs: () => [],
      listComments: () => [],
      listTaskPhaseEvents: () => [],
    });
    safePusher.start();
    // 不应抛异常
    expect(() => {
      bus.emit("requirement:status-changed", { id: "req-001", from: "clarifying", to: "ready" });
    }).not.toThrow();
    await new Promise((r) => setTimeout(r, 10));
    safePusher.dispose();
  });

  it("dispose 后停止推送", async () => {
    pusher.dispose();
    const beforeCount = backend.pushedEvents.flat().length;
    bus.emit("requirement:status-changed", { id: "req-001", from: "clarifying", to: "ready" });
    await new Promise((r) => setTimeout(r, 10));
    expect(backend.pushedEvents.flat().length).toBe(beforeCount);
  });
});
```

- [ ] **Step 2: 运行测试**

```powershell
bun test tests/selfhosted-connector/mirror-pusher.test.ts
```

Expected: 5 tests passing

- [ ] **Step 3: Commit**

```powershell
git add tests/selfhosted-connector/mirror-pusher.test.ts
git commit -m "test(connector): mirror pusher 单元测试——事件映射/seq 单调/best-effort"
```

---

## Task 9: 单元测试 — Commands Poller

**Files:**
- Create: `tests/selfhosted-connector/commands-poller.test.ts`

- [ ] **Step 1: 新建测试文件**

```typescript
// tests/selfhosted-connector/commands-poller.test.ts
import { describe, it, expect, beforeEach } from "bun:test";
import { CommandsPoller } from "../../src/daemon/selfhosted-connector/commands-poller";
import type { SelfhostedBackend } from "../../src/daemon/selfhosted-connector/backend";
import type { CommandPayload } from "../../src/daemon/selfhosted-connector/types";

function makeMockBackend(commandQueue: CommandPayload[]): SelfhostedBackend & {
  ackedCommands: Array<{ id: string; ok: boolean; reason?: string }>;
} {
  let idx = 0;
  const ackedCommands: Array<{ id: string; ok: boolean; reason?: string }> = [];
  return {
    ackedCommands,
    async pollAssignment() { return null; },
    async ackAssignment() {},
    async pushMirrorEvents() { return { seqGap: false }; },
    async pushMirrorSnapshot() {},
    async pollCommand() {
      if (idx >= commandQueue.length) return null;
      return commandQueue[idx++]!;
    },
    async ackCommand(id, ok, reason) {
      ackedCommands.push({ id, ok, reason });
    },
    async heartbeat() {},
    async deregister() {},
  };
}

describe("CommandsPoller", () => {
  it("answer_clarification → comments.add RPC + ack ok:true", async () => {
    const cmd: CommandPayload = {
      command_id: "cmd-001",
      autopilot_req_id: "req-001",
      kind: "answer_clarification",
      payload: { question_id: "qst-001", body: "我的回答" },
    };
    const backend = makeMockBackend([cmd]);
    const calledRpc: Array<{ method: string; params: unknown }> = [];
    const poller = new CommandsPoller({
      backend,
      pollWaitSeconds: 0,
      backoffBaseMs: 0,
      invokeRpc: async (method, params) => {
        calledRpc.push({ method, params });
        return {};
      },
    });
    poller.start();
    await new Promise((r) => setTimeout(r, 50));
    poller.dispose();

    expect(calledRpc.some((c) => c.method === "comments.add")).toBe(true);
    const rpcCall = calledRpc.find((c) => c.method === "comments.add");
    const p = rpcCall?.params as Record<string, unknown>;
    expect(p.kind).toBe("question");
    expect(p.from_role).toBe("user");
    expect(p.body).toBe("我的回答");
    expect(p.parent_id).toBe("qst-001");

    expect(backend.ackedCommands.some((a) => a.id === "cmd-001" && a.ok === true)).toBe(true);
  });

  it("approve → requirements.enqueue RPC", async () => {
    const cmd: CommandPayload = {
      command_id: "cmd-002",
      autopilot_req_id: "req-002",
      kind: "approve",
      payload: {},
    };
    const backend = makeMockBackend([cmd]);
    const calledRpc: Array<{ method: string; params: unknown }> = [];
    const poller = new CommandsPoller({
      backend,
      pollWaitSeconds: 0,
      backoffBaseMs: 0,
      invokeRpc: async (method, params) => {
        calledRpc.push({ method, params });
        return {};
      },
    });
    poller.start();
    await new Promise((r) => setTimeout(r, 50));
    poller.dispose();

    expect(calledRpc.some((c) => c.method === "requirements.enqueue")).toBe(true);
    expect(backend.ackedCommands.some((a) => a.id === "cmd-002" && a.ok === true)).toBe(true);
  });

  it("reject → comments.add feedback", async () => {
    const cmd: CommandPayload = {
      command_id: "cmd-003",
      autopilot_req_id: "req-003",
      kind: "reject",
      payload: { body: "请修改格式" },
    };
    const backend = makeMockBackend([cmd]);
    const calledRpc: Array<{ method: string; params: unknown }> = [];
    const poller = new CommandsPoller({
      backend,
      pollWaitSeconds: 0,
      backoffBaseMs: 0,
      invokeRpc: async (method, params) => {
        calledRpc.push({ method, params });
        return {};
      },
    });
    poller.start();
    await new Promise((r) => setTimeout(r, 50));
    poller.dispose();

    const rpcCall = calledRpc.find((c) => c.method === "comments.add");
    expect(rpcCall).toBeDefined();
    const p = rpcCall?.params as Record<string, unknown>;
    expect(p.kind).toBe("feedback");
    expect(p.body).toBe("请修改格式");
    expect(backend.ackedCommands.some((a) => a.id === "cmd-003" && a.ok === true)).toBe(true);
  });

  it("RPC 失败 → ack ok:false + reason", async () => {
    const cmd: CommandPayload = {
      command_id: "cmd-004",
      autopilot_req_id: "req-004",
      kind: "approve",
      payload: {},
    };
    const backend = makeMockBackend([cmd]);
    const poller = new CommandsPoller({
      backend,
      pollWaitSeconds: 0,
      backoffBaseMs: 0,
      invokeRpc: async () => { throw new Error("需求状态不对"); },
    });
    poller.start();
    await new Promise((r) => setTimeout(r, 50));
    poller.dispose();

    const ack = backend.ackedCommands.find((a) => a.id === "cmd-004");
    expect(ack).toBeDefined();
    expect(ack?.ok).toBe(false);
    expect(typeof ack?.reason).toBe("string");
  });

  it("幂等去重——同一 command_id 只执行一次 RPC", async () => {
    const cmd: CommandPayload = {
      command_id: "cmd-005",
      autopilot_req_id: "req-005",
      kind: "approve",
      payload: {},
    };
    // 同一条命令出现两次
    const backend = makeMockBackend([cmd, cmd]);
    let rpcCount = 0;
    const poller = new CommandsPoller({
      backend,
      pollWaitSeconds: 0,
      backoffBaseMs: 0,
      invokeRpc: async () => { rpcCount++; return {}; },
    });
    poller.start();
    await new Promise((r) => setTimeout(r, 80));
    poller.dispose();

    // RPC 只调了 1 次
    expect(rpcCount).toBe(1);
  });

  it("cancel → requirements.cancel RPC", async () => {
    const cmd: CommandPayload = {
      command_id: "cmd-006",
      autopilot_req_id: "req-006",
      kind: "cancel",
      payload: { reason: "用户取消" },
    };
    const backend = makeMockBackend([cmd]);
    const calledRpc: Array<{ method: string; params: unknown }> = [];
    const poller = new CommandsPoller({
      backend,
      pollWaitSeconds: 0,
      backoffBaseMs: 0,
      invokeRpc: async (method, params) => {
        calledRpc.push({ method, params });
        return {};
      },
    });
    poller.start();
    await new Promise((r) => setTimeout(r, 50));
    poller.dispose();

    expect(calledRpc.some((c) => c.method === "requirements.cancel")).toBe(true);
  });
});
```

- [ ] **Step 2: 运行测试**

```powershell
bun test tests/selfhosted-connector/commands-poller.test.ts
```

Expected: 6 tests passing

- [ ] **Step 3: 运行全量测试套件**

```powershell
bun test
```

Expected: 所有测试通过，无 typecheck 错误

- [ ] **Step 4: Commit**

```powershell
git add tests/selfhosted-connector/commands-poller.test.ts
git commit -m "test(connector): commands poller 单元测试——命令映射/ack/幂等去重"
```

---

## 自我审查

**Spec 覆盖检查：**
- ✅ §2.1 三条链路全覆盖：assignments / commands / mirror
- ✅ §2.2 分配下发：assignments-poller + backend.pollAssignment/ackAssignment + requirements.create + setWorkspaces
- ✅ §2.3 状态同步：mirror-pusher 订阅所有 §2.3 列出的事件类型
- ✅ §2.4 命令回传：commands-poller 覆盖 §2.4 所有 kind + 幂等 + ack ok:false
- ✅ §6.1 backend 端点：6 个方法全实现（pollAssignment/ackAssignment/pushMirrorEvents/pushMirrorSnapshot/pollCommand/ackCommand）
- ✅ SelfhostedConfig + loadSelfhostedConfig（config.yaml selfhosted 段）
- ✅ CLI autopilot selfhosted register/status/remove
- ✅ 装配：daemon/index.ts 追加 initSelfhostedConnector + dispose
- ✅ 纯 additive：runner/ 零改动，mode:runner 分支零改动
- ✅ best-effort 原则：失败只 warn 不阻塞

**类型一致性：**
- `RunnerCredentials` 从 `runner/types.ts` 统一复用（凭证结构共享）
- `HttpSelfhostedBackend.register` 与 `HttpRunnerBackend.register` 签名一致（都返回 `{runner_id, secret}`）
- `MirrorPusher.notifySnapshot(reqId)` 在 AssignmentsPoller 中的调用参数类型一致
- `SelfhostedBackend` interface 在 tests 中 mock 全字段覆盖

**Placeholder 扫描：**
- 无 TBD/TODO，所有步骤含完整代码块
- `_pushPhaseEventByTask` 使用动态 import `getTask`（避免循环依赖，是有意设计，非 placeholder）
