# /now 主屏 + 信息架构重构 设计文档

**日期**：2026-05-12
**状态**：设计已批准，待实现
**涉及模块**：daemon 核心 (`src/core/`)、daemon 路由 (`src/daemon/`)、Web UI (`src/web/`)、TUI (`src/tui/`)、CLI (`src/cli/`)、文档 (`docs/quickstart.md`)
**设计方法**：Brainstorming skill 生成，用户旅程地图 → 痛点定位 (B 类「主链路节奏断」) → 5 段方案逐节确认

---

## 1. 背景与目标

### 1.1 问题陈述

autopilot 当前的用户体感是 **"主链路节奏断"**：每一步看起来都能用、各组件单独看也都正常，但**串起来不顺**——用户从"想做一件事"到"事情做完"中间断节、岔路、找不到下一步去哪。

通过用户旅程地图定位，痛感分布在从 **02 初始化、05 注册 Project/Codebase、06 配置 Agent、07 选/写工作流、08 创建需求、09 入队、10 任务执行中、12 PR/复盘** 一连串环节上（覆盖 12 段旅程中的 8 段），呈现"千刀万剐"型的弥散感受，而非某个具体崩点。

进一步澄清后用户明确选择 **B 类（主链路节奏断）**：解法不是修单点，而是**重构"从想做一件事到事情做完"的整体流程**。

### 1.2 根因分析

1. **导航按"实体类型"组织而非按"用户意图"**：当前 Web UI 11 个顶级页面（Projects / Tasks / Workflows / Agents / Providers / Schedules / Settings / Chat ...）是 CRUD admin 视角，用户想"做一件事"要在多页面之间跳。
2. **没有"现在该做什么"的统一视图**：用户回到系统第一眼看不出需要决策的事、活跃任务、异常状态，必须主动点进各页面才能拼出全貌。
3. **CLI / TUI / Web 三套形态心智模型不一致**：术语、流程、信息呈现各异，记不住。

### 1.3 目标

将 autopilot 主交互模型从「按实体导航」改为 **「状态驱动的卡片流」**：

1. **主屏 `/now`**：进入系统第一眼，永远看到"现在该做什么"卡片流。每张卡自带行动按钮，点完事情就推进。
2. **导航缩减**：11 页 → 4 个意图区（`/now` `/start` `/library` `/settings`）+ 浮动 Chat 入口。
3. **状态推导引擎**：daemon 后端聚合多源状态成卡片列表，Web/TUI/未来菜单栏共用。
4. **CLI / TUI 一致化**：新增 `autopilot now` 与 `autopilot start`；TUI 默认 Tab 改为 Now。

### 1.4 非目标（YAGNI）

- 不做 telemetry / 埋点（第一版人工跑用户故事验收）
- 不做 A/B 测试（单用户产品无意义）
- 不做 feature flag（4 PR 分阶段已足够安全）
- 不做卡片自定义配置（先让默认卡片做好）
- 不做卡片系统通知（浏览器开着 /now 就够，避免吵）
- 不重构现有数据模型（Project / Codebase / Requirement / Task / Workflow / Phase 全部保留不动）
- 不重构 daemon 与 agent 的核心机制

### 1.5 设计原则

- **状态驱动**：UI 的内容由 daemon 的当前状态决定，不由用户的"导航选择"决定。
- **行动可达**：每张卡片必须包含明确的行动按钮（看 / 审 / 驳回 / 关闭）。
- **渐进发布**：4 个独立 PR，每个能独立 merge / 验证 / 回滚。
- **共用基础设施**：不引入新依赖，复用现有 SQLite + event-bus + WebSocket。
- **保留深链**：所有旧路由 redirect 而非 404，详情页（TaskDetail / RequirementDetail）继续可深链访问。

---

## 2. 信息架构（11 → 4）

### 2.1 顶层导航重组

| 区 | 路径 | 装什么 | 心智模型 |
|---|---|---|---|
| **/now** ★ 主屏 | `/` 重定向到 `/now` | 待审批需求、卡住的 task、运行中的 task、待回答的 question、系统异常 | "现在该做什么" |
| **/start** | `/start` | 对话式 +  表单式两条提需求入口 | "我要做新东西" |
| **/library** | `/library` | 项目 + 代码库 + 历史 task/requirement（复盘） | "我有什么 / 以前干过啥" |
| **/settings** | `/settings/{workflows,agents,providers,schedules,general}` | 工作流 + Agents + Providers + 定时任务 + 通用配置（5 子 Tab） | "调参数（很少碰）" |
| 💬 浮动 Chat | 任意页面右下角气泡 | 全屏模式仍可通过 `/chat` 深链访问 | 辅助入口 |

### 2.2 旧路径 → 新位置映射

| 旧路径 | 新位置 | 处理 |
|---|---|---|
| `/projects` | `/library?tab=projects` | redirect |
| `/projects/:id` | `/library/projects/:id` | redirect（保留深链） |
| `/requirements/:id` | `/requirements/:id` | 保留路径，无顶层导航入口 |
| `/tasks` | 活跃 → `/now`；完成 → `/library?tab=history` | 按 status 拆分 redirect |
| `/tasks/:id` | `/tasks/:id` | 保留作深链（Now 卡片也指向此） |
| `/workflows` | `/settings/workflows` | redirect |
| `/schedules` | `/settings/schedules` | redirect |
| `/providers` | `/settings/providers` | redirect |
| `/agents` | `/settings/agents` | redirect |
| `/settings` | `/settings/general` | redirect |
| `/chat` | `/chat`（全屏模式）+ 浮动气泡 | 保留 + 加浮动入口 |
| `/` | `/now` | redirect |

### 2.3 关键决策

1. **Tasks 拆三半**：活跃任务 → `/now` 卡片；已完成 → `/library/history`；详情仍保留 `/tasks/:id` 完整页面。Now 卡片"看日志"等按钮跳转 TaskDetail。
2. **Requirements 没有顶层位置**：调查中 / 待审批 → `/now`；已完成 → `/library/history`；编辑详情通过卡片点开抽屉或深链 `/requirements/:id`。
3. **Schedules 放 settings**：日常很少看，归入配置区。
4. **Chat 退出顶层**：变所有页面右下角浮动入口（FloatingChat 组件）。原 `/chat` 路径保留作全屏模式深链。

---

## 3. /now 卡片流系统

### 3.1 卡片优先级（4 层）

| 层 | 颜色 | 类型 | 内容 |
|---|---|---|---|
| **P0** | 红 | 异常 | provider 凭证失效 / daemon 自检异常 / task failed 未 dismiss / 磁盘或 workspace 容量告警 |
| **P1** | 橙 | 决策 | 审方案（await_review）/ 回 question / 审批需求（awaiting_approval）/ task 卡住（watcher 标记） |
| **P2** | 绿 | 进行 | task running，附 phase 进度条 + 预估剩余时间 |
| **P3** | 蓝灰 | 完成 | 24h 内完成的 task，附 PR 链接，可手动 dismiss |

**排序规则**：先按优先级层，同层按"等待时长"降序（卡得越久越靠前）。
**Dismiss 规则**：P0 / P1 不可手动关闭（必须处理）；P2 / P3 可关。

### 3.2 卡片类型清单

| 类型 | 优先级 | 触发条件 | 行动按钮 |
|---|---|---|---|
| provider-error | P0 | provider 健康检查失败 | [去修] |
| daemon-self-check | P0 | daemon 自检异常 | [看详情] |
| task-failed | P0 | task.status = failed 且未 dismiss | [看错误] [关闭] |
| workspace-capacity | P0 | workspace 容量超阈值 | [清理] |
| await-review | P1 | task 卡在 await_review 状态 | [看方案] [驳回] |
| open-question | P1 | requirement_questions 中存在 open 状态问题 | [回答] |
| awaiting-approval | P1 | requirement.status = awaiting_approval | [去看] |
| stuck-task | P1 | watcher 标记任务卡死 | [继续] [取消] [看日志] |
| running-task | P2 | task.status LIKE 'running_%' | [看日志] |
| completed-task | P3 | task 完成时间 < 24h 且未 dismiss | [看 PR] [关闭] |

### 3.3 空状态（4 阶段渐进引导）

| 状态 | 引导文案 | 行动 |
|---|---|---|
| 没有项目 | "先建一个项目吧" | [新建项目] → `/library/projects/new` |
| 有项目但没 codebase | "给 X 项目加一个代码库" | [选目录] → `/library/projects/X/add-codebase` |
| 准备就绪没活儿 | "提一个新需求开始" | [/start] |
| 一切清空 🎉 | "所有任务已完成。来点新的？" | [/start] |

### 3.4 实时性

- 首屏：`GET /api/now/cards` 拉一次全量快照
- 后续：WebSocket 订阅 `now:*` channel，收增量推送
- 不走轮询；复用 daemon 现有 WS 基础设施
- WS 断线 → 客户端自动重连并重新拉全量（复用现有 client 重连逻辑）

---

## 4. 状态推导引擎

### 4.1 架构

新增模块 **`src/core/now-aggregator.ts`**，运行在 daemon 内：

```
数据源 ─── 事件 ───▶ now-aggregator ─── 推送 ───▶ 客户端
                    （内存快照）              （Web / TUI / CLI）
```

**数据源**（已有，不新增）：
- `tasks` 表 / `requirements` 表 / `requirement_questions` 表
- `projects` 表 / `codebases` 表（用于空状态判断）
- provider 健康检查 / watcher 卡死检测 / workspace 容量监控 / daemon self-check

**aggregator 行为**：
- **启动时**：依次调用所有 CardSource 的 `scan()` 建立内存快照 `Map<id, NowCard>`
- **运行时**：订阅 event-bus 事件，分发给对应 CardSource 拿 `CardDelta[]`，更新快照
- **对外**：HTTP 拉全量（首屏）+ WS 推增量（后续）

订阅的事件（均已存在于 event-bus）：
- `task:created` / `task:transition`
- `requirement:updated` / `question:opened` / `question:replied`
- `provider:health_changed`
- `watcher:recovery` / `watcher:stuck`
- `system:*`（磁盘 / 凭证 / workspace 容量）

### 4.2 NowCard 协议

```ts
type NowCard = {
  id: string;                         // 稳定 ID
  priority: 'P0' | 'P1' | 'P2' | 'P3';
  category: 'error' | 'decision' | 'running' | 'completed';
  title: string;
  subtitle: string;
  detail?: string;
  related?: {
    type: 'task' | 'requirement' | 'provider' | 'system';
    id: string;
  };
  actions: NowCardAction[];
  waited_seconds?: number;            // 由前端基于 created_at 实时计算
  dismissable: boolean;
  created_at: number;                 // epoch seconds
};

type NowCardAction = {
  label: string;
  kind: 'primary' | 'secondary' | 'danger';
  // 二选一：
  href?: string;                      // 客户端路由跳转
  invoke?: {                          // 触发后端动作
    method: 'POST' | 'PATCH';
    path: string;
    body?: unknown;
  };
};
```

### 4.3 CardSource 抽象

每种卡片类型 = 一个独立模块：

```ts
interface CardSource {
  name: string;                                       // 'await-review' / 'open-question' / ...
  subscribes: string[];                               // ['task:transition', 'watcher:stuck']
  scan(): Promise<NowCard[]>;                         // 启动时全扫
  onEvent(event: BusEvent): Promise<CardDelta[]>;     // 事件来时计算增量
}

type CardDelta =
  | { op: 'add'; card: NowCard }
  | { op: 'update'; id: string; patch: Partial<NowCard> }
  | { op: 'remove'; id: string; reason: 'resolved' | 'dismissed' };
```

aggregator 持有 `sources: CardSource[]`，新增卡片类型 = 新增一个 CardSource 模块，**不改 aggregator 本身**。

### 4.4 HTTP / WebSocket 接口

```
GET    /api/now/cards                     → { cards: NowCard[] }
POST   /api/now/cards/:id/dismiss         → { ok: true }
```

**dismiss 持久化**：新增一张轻量表 `now_dismissed_cards (card_id TEXT PRIMARY KEY, dismissed_at INTEGER)`，aggregator 启动 `scan()` 时过滤掉已 dismiss 的 ID。`task_id` / `requirement_id` 本身的状态不变 —— dismiss 只影响"是否在 /now 显示"，TaskDetail 等深链页面仍能看到。当对应实体状态发生变化时（如 task 从 failed 转出，或被用户重新触发），aggregator 会清掉对应 dismiss 记录（让卡可以再次出现）。

WebSocket channel **`now:*`**，事件类型：
- `now:card_added`     `{ card: NowCard }`
- `now:card_updated`   `{ id, patch: Partial<NowCard> }`
- `now:card_removed`   `{ id, reason: 'resolved' | 'dismissed' }`
- `now:snapshot`       `{ cards: NowCard[] }`（极少触发，aggregator 异常重建后用）

### 4.5 工程决策

1. **引擎放后端**：所有客户端（Web/TUI/CLI now 命令）共用一套聚合逻辑，避免重写。
2. **事件驱动 + 内存快照**：贴合现有 event-bus 架构；daemon 重启后重扫一遍（几百毫秒可接受）。
3. **等待时长前端算**：`waited_seconds` 由前端基于 `created_at` 实时计算，后端不推送秒级更新，避免 WS 雪崩。
4. **CardSource 模块化**：新增卡片类型不动 aggregator 本身。
5. **不引入新依赖**：完全复用 SQLite + event-bus + WebSocket。

---

## 5. 改动范围与迁移策略

### 5.1 新建文件清单

**后端**（`src/core/`）：
- `now-aggregator.ts`
- `card-sources/await-review.ts`
- `card-sources/open-question.ts`
- `card-sources/awaiting-approval.ts`
- `card-sources/running.ts`
- `card-sources/stuck.ts`
- `card-sources/completed.ts`
- `card-sources/provider-error.ts`
- `card-sources/empty-state.ts`

**daemon 路由**（`src/daemon/`）：
- `routes/now.ts`

**Web**（`src/web/src/`）：
- `pages/Now.tsx`
- `pages/Start.tsx`
- `pages/Library.tsx`
- `pages/SettingsHub.tsx`
- `components/NowCard.tsx`
- `components/FloatingChat.tsx`

**CLI / TUI**：
- `src/cli/now.ts`
- `src/cli/start.ts`
- `src/tui/components/NowScreen.tsx`

### 5.2 修改文件

- `src/web/src/App.tsx` — 新增 4 区路由 + 旧路径 redirect
- `src/web/src/components/Nav.tsx` — 顶层导航缩到 4 项
- `src/tui/app.tsx` — 默认 Tab 改为 Now
- `src/cli/index.ts` — 注册 `now` / `start` 命令
- `docs/quickstart.md` — 完全重写（当前文档严重过期：仍写 `pip install`、错误的命令名 `autopilot workflows` / `autopilot start <id>`、错误的端口 8080，与实际 Bun/TS + Commander CLI + 6180 端口完全对不上）

### 5.3 保留作"内嵌 / 深链"

- `src/web/src/pages/TaskDetail.tsx` — `/tasks/:id` 深链，/now 卡片[看日志]等按钮跳转目标
- `src/web/src/pages/RequirementDetail.tsx` — 同上
- `src/web/src/pages/ProjectDetail.tsx` — `/library/projects/:id` 子页面
- `src/web/src/pages/Workflows.tsx` / `Agents.tsx` / `Providers.tsx` / `Schedules.tsx` — `/settings` 子 Tab 内嵌
- `src/web/src/pages/Chat.tsx` — 全屏模式 + 浮动气泡组件复用其内部逻辑

### 5.4 最终可删除（PR 4 时执行）

- `src/web/src/pages/Tasks.tsx` — 逻辑分流到 Now + Library 后
- `src/web/src/pages/Projects.tsx` — 顶层入口移除后

前期保留以便回滚，待 PR 1-3 稳定后再删。

### 5.5 渐进发布 · 4 个独立 PR

| PR | 范围 | 验证方式 |
|---|---|---|
| **PR 1** | now-aggregator + 9 个 CardSource + HTTP/WS endpoint | curl + 单元测试 + WS 客户端手测；不改 UI |
| **PR 2** | `Now.tsx` + `NowCard` 组件 + `/now` 路由 | 在浏览器访问 `/now`；老导航和老路由保持不变；dogfood 几天 |
| **PR 3** | 顶层导航缩 4 项 + Start/Library/SettingsHub + 旧路径 redirect + FloatingChat | 全量 redirect 测试 + 7 条用户故事 |
| **PR 4** | `autopilot now` / `autopilot start` 命令 + TUI Now 屏 + 删 Tasks.tsx/Projects.tsx + quickstart 完全重写 | CLI / TUI 跑通用户故事 US-1 |

每个 PR 都能独立 merge / 验证 / 回滚。**不引入 feature flag**：因为 PR1/2 加新东西不破旧的，PR3/4 改动可逐项 redirect 兜底，flag 会显著增加维护负担。

### 5.6 迁移决策

1. **TUI 第一版范围**：只做 Now 屏，其他 Tab（Workflows / Tasks 列表）暂留旧版。后续视用户反馈再扩。
2. **CLI 新命令保留 task 子命令**：`autopilot now` 和 `autopilot start "<需求>"` 是快捷入口；底层 `autopilot task start / status / logs / cancel` 仍保留作运维命令。
3. **quickstart 重写时机**：放最后一个 PR，避免改的过程中文档反复返工。

---

## 6. 验收

### 6.1 用户故事（7 条必须跑通）

| ID | 场景 | 验证什么 |
|---|---|---|
| **US-1** | 清空 `~/.autopilot/` → 跟着新版 quickstart 5 分钟内跑通第一个 demo 需求，全程不查文档以外的东西 | 金路径成立、quickstart 真实可执行 |
| **US-2** | 打开浏览器到 `/` → 自动落 `/now` → 一眼看到所有"需要决策"的事（审方案 / 回 question / 审批需求），不需要点其他页面 | `/now` 真正承担"状态唤起"主屏 |
| **US-3** | /now 看到"审方案"卡 → [看方案] → 觉得不对 → [驳回] + 写理由 → 任务自动回到 design 阶段，驳回理由能被下一轮 agent 读到 | 驳回链路通畅 |
| **US-4** | 手动 kill daemon → supervisor 拉起 → 回到 `/now` 看到"X 个任务被中断，已自动恢复"的状态卡 + 受影响 task 列表 | 异常对用户可见、不"安静地"出错 |
| **US-5** | watcher 标记卡住 → `/now` 自动出现"⚠ Task #X 卡在 Y 阶段 30 分钟"卡，附 [继续 / 取消 / 看日志] 三个按钮 | 不需要主动 watch；卡死被动暴露 |
| **US-6** | 同时跑 3 个 task → `/now` 一屏内看到 3 张进行中卡，每张显示当前 phase + 预计剩余时间，不需要切 tab | 信息密度足够，无需多 tab |
| **US-7** | 已完成卡 → 看完 PR 链接 → [关闭] → 卡消失 + 不再出现 | dismiss 机制有效，主屏不堆积 |

### 6.2 反向警示（出现这些迹象说明没做对）

- 你还是手动去 `/tasks` 列表 → `/now` 没承载住活跃任务，或者卡片不够直观
- 你开着多个 tab 来回切 → `/now` 信息密度不足，应该一屏看完
- 你 dismiss 完成卡的频率 = 0 → 完成卡不被注意 / 没价值，应该重新设计
- 你在 settings 区域待的时间 > 主屏 → 配置成本仍然太重
- 跑一个需求中途要重新看文档 → 引导和卡片提示不够，金路径没立住
- 有人问"我现在该做什么" → `/now` 没有完成核心使命

---

## 7. 风险与缓解

| 风险 | 严重度 | 缓解 |
|---|---|---|
| now-aggregator 在 daemon 启动时全表扫描慢 | 中 | 每个 CardSource 的 `scan()` 加索引（已有的 status / updated_at 索引足够）；预算 < 500ms |
| WS 推送量大（同时多任务运行） | 低 | 等待秒数前端算，后端只推状态变化；现有 WS 基础设施已稳定 |
| 旧路径 redirect 漏了某条 | 中 | PR 3 前列出全量旧路径清单，在 e2e 测试中逐项验证 |
| 用户已习惯老导航不去 `/now` | 低 | PR 2 dogfood 期间观察；如有问题在 PR 3 把 `/` 重定向到 `/now` 即可强制 |
| CardSource 之间状态不一致（如同一 task 被分到两个 source） | 中 | 每个 CardSource 用唯一 `name` 前缀生成 NowCard.id（如 `await-review:task-5`），aggregator 在内存快照中按 id 去重 |
| 删 Tasks.tsx / Projects.tsx 后有人深链 | 低 | PR 3 已配 redirect，PR 4 删文件不破链接 |

---

## 8. 后续

- 设计文档已批准 → 进入 writing-plans，生成 4 个 PR 的实施 plan
- 第一个实施 PR 是 **PR 1（后端基础）**，预计 ~600 行 + 测试

---

## 附录 · 设计过程记录

本设计经过 5 轮 visual brainstorming 确认：
1. **痛点定位**：用户旅程 12 段 → 选中 8 段 → 确认是"B 类主链路节奏断"
2. **方向选择**：3 个候选方向（金路径 / 状态-动作主屏 / 对话工作台）→ 选 B（状态-动作主屏）
3. **5 段 design**：信息架构 → 卡片流 → 推导引擎 → 改动范围 → 验收 ，每段用户单独确认

可视化 mockup 文件保留在 `.superpowers/brainstorm/2291-1778571819/content/` 下，供实施时回顾参考。
