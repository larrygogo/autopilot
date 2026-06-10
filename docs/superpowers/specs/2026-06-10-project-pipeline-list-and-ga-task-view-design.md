# 设计：项目页需求列表流水线化 + 执行界面 GitHub Actions 化

> 2026-06-10 · 已经用户批准。两个独立 Web UI 改造，共享"流水线卡片"组件抽取。

## 背景与决策

1. **改造 A**：项目详情页（ProjectDetail.tsx）的需求列表现为极简 divide-y 行列表，改成与流水线页（Tasks.tsx）完全一致的形态：**4 段 tab + 时间分组 + RowCard 卡片**（用户选"完整复刻含 4 段 tab"）。
2. **改造 B**：任务执行界面（TaskDetail.tsx）改成 **GitHub Actions job 页形态**：左侧 phase 导航 + 右侧折叠日志 section 流（用户选完整 GA 布局）；移除横向 PhasePipeline DAG 与 TaskPhaseTimeline 耗时轴（用户确认）。

## 改造 A：项目页需求列表

### 组件抽取

从 `src/web/src/pages/Tasks.tsx` 抽取到 `src/web/src/components/PipelineList.tsx`：
`TONE`、`reqMeta`、`taskMeta`、`relTime`、`tsToMs`、`bucketOf`、`TimeGroupedList`、`RowCard`、`RequirementRow`、`TaskRow`。`TimeGroupedList` 接口为 `TimedRow[]`，天然兼容"纯需求行"（项目页）与"需求+任务混合行"（流水线页）。

### 项目页 tab 分桶（需求自己代表全生命周期，无 `if (r.task_id) continue` 过滤）

| Tab | requirement status |
|---|---|
| 全部 | 所有 |
| 等待人工 | drafting / clarifying / ready / awaiting_approval / awaiting_review / failed |
| 运行中 | queued / running / fix_revision |
| 归档 | done / cancelled |

`reqMeta` 需补全后段状态（Tasks.tsx 现版只覆盖前置态）：running→accent spin"执行中"、awaiting_review→warning Hand"待 PR review"、fix_revision→accent spin"修复中"、done→success"已完成"、failed→destructive"失败"、cancelled→muted"已取消"。

### 行为与边界

- 时间分组：今天/昨天/一周内/一月内/更早，与流水线页同构同样式。
- 卡片点击进 `/requirements/{id}`（不变）；secondary 行 = req.id + 派生任务时 task_id。
- **不带**流水线页的搜索框与 workflow chips（项目内量级小，YAGNI）。
- 空态：项目无任何需求时**不渲染 tab 行**，保留现有引导空卡（无工作区→先建工作区提示；有工作区→新建需求 CTA）。有需求但当前 tab 为空：`py-10` 居中 mono 小字（等待人工→"没有等你处理的需求"；运行中→"没有正在推进的需求"；归档→"还没有归档的需求"）。
- 数据源不变：`api.listProjectRequirements(projectId)`。

## 改造 B：TaskDetail 执行界面

### 布局（宽屏）

- 页头、TaskOutcomeCard / 来源需求卡 / GateBanner / AskBanner / DanglingBanner / TaskProgressCard：**保持不动**，在双栏区之上。
- 双栏区：左导航 `w-60 sticky`（状态 icon + 业务标签 + mono 内核名 + 右对齐耗时；选中/可视条目左 2px accent 竖条），右侧 section 流（独立滚动）。
- 右栏顶部 sticky 工具栏：日志搜索框 + INFO/WARN/ERROR/DEBUG chips（复用 PhaseLogsViewer 的 LEVEL_RE/extractLevel）。作用域=所有已展开 section 的已加载内容；激活时各 section 头显示命中数 `· N 处`，零命中的展开 section 显示"无匹配行"。
- 并行块：左导航组头（mono 10px muted `<组名> · PARALLEL`）+ 子项缩进 12px + 1px 竖线；右侧浅容器（`border bg-muted/20 rounded-xl p-2`）包子 section。
- section header：icon + 业务标签 + mono 名 + 耗时 + `ⓘ`（开 PhaseDetailDrawer，stopPropagation）+ chevron；整个 header 可点折叠。
- 左导航底部分隔后给「⏱ 状态转移」入口；LogTimeline 变 section 流末尾折叠 section（badge 显条数，默认收起）。

### 移除 / 保留

| 项 | 处置 |
|---|---|
| PhasePipeline 横向 DAG 卡、TaskPhaseTimeline | 删除 |
| TaskDetailTabs 的「阶段日志」「实时日志」「状态日志」tab | 删除（旧"倒序顶部跟随"实现一并删，不留两种滚动方向） |
| 「沙盒」「Agent 调用」tab、基本信息卡、危险操作区 | 不动，移到执行区下方 |
| PhaseDetailDrawer | 保留，入口改 section 头 `ⓘ` |
| 失败重试 | failed section 头 `[↻ 重试此阶段]`（调 api.restartTask）；页头「重新执行」保留兜底 |

### 状态矩阵

| phase 状态 | icon / 色 | 耗时 | 默认展开 | 日志区 |
|---|---|---|---|---|
| pending | Circle 空心 / muted 50% | `—` | 收起 | 展开显"尚未开始"，不发请求 |
| running | Loader2 spin / accent | 实时 elapsed 每秒走字，有 P50 附 `· 常约Xm` | 自动展开 | 初始 getPhaseLog 200 行 + WS log:entry 增量 + 4s 轮询兜底；底部追尾 |
| done | CheckCircle2 / success | 定格 | 收起 | 懒加载（首次展开拉 500 行，缓存） |
| failed | XCircle / destructive，header 左缘红 2px | 到失败为止 | **强制展开**（清 override） | 尾部 200 行 + 顶部错误摘要条（transitions 最近 note）+ 重试按钮 |
| awaiting（人工 gate） | Hand / warning | 定格 + `· 已等Xm` 走字 | 自动展开 | 完整日志 + 底部引导"在顶部横幅里通过/驳回"（决策不下沉） |
| 驳回重跑（第 N 轮） | Loader2 spin + `×N` badge | 当前轮 elapsed | 自动展开 | 同 running；日志插入分隔行"── 第 N 次执行（评审驳回）──" |
| 日志为空 | — | — | — | "本阶段无日志输出" |
| 日志加载失败 | — | — | — | destructive 文案 + [重试] ghost |

左导航条目与 section header 视觉同源：单一 `phaseVisual(status)` 两处用。

### 交互规格

**自动展开 vs 手动**：维护 `userOverride: Map<phase, "collapsed"|"expanded">`。
1. 自动展开只在状态跃迁瞬间（→running / →failed / →awaiting）。
2. 手动收起 running section → 当前状态周期内不再自动展开。
3. 状态跃迁清除该 phase override；**跃迁到 failed 一律强制展开并清 override**。
4. 自动逻辑只展开、从不收起；多 section 展开共存。

**追尾滚动（per-section，正序底部跟随）**：新行到达滚到底；用户上滚（距底 >24px）即暂停，浮出 pill "已暂停 · N 条新日志 [↓ 跳到最新]"；滚回底部（<24px）或点 pill 恢复；折叠再展开重置为跟随。

**左导航**：点击=展开（触发懒加载）+ `scrollIntoView` 平滑定位；再点已展开项只定位不折叠；scroll-spy（IntersectionObserver）高亮视口顶 section，点击高亮优先 600ms。左导航不承载折叠/重试/决策动作。

### 数据与分发

- phase 运行状态：复用 `phaseRunStatuses`（transitions 推导）+ `useTaskPhaseEvents`（起止/耗时）+ `phaseStats`（P50）。
- WS `log:entry` payload **已带 `phase` 字段**（`src/core/events.ts:29`，值为 logger 的 phase tag——是 label 文案，前端需建 label→phase name 映射，workflow 定义里有 label），并行块日志可精确分发到对应 section。
- 4s 轮询继续兜底 WS 断线。

### Embedded 窄容器（嵌在 RequirementDetail running 步）

左导航撤掉，降级为横向可滚 phase chip 条（icon+label+耗时，当前 phase 居中；点 chip 同左导航点击语义）。断点用 **CSS 容器查询（@container，Tailwind v4 原生）**而非视口断点——embedded 时视口宽但容器窄。

## 测试要点

- PipelineList 抽取后 Tasks 页行为回归（分桶/分组纯函数单测已有的保留迁移）。
- 项目页 tab 分桶映射纯函数单测（全状态覆盖）。
- 自动展开 override 状态机纯函数化 + 单测（跃迁/手动收起/failed 强制）。
- 追尾滚动阈值逻辑纯函数化 + 单测。
- log:entry phase 分发（label→name 映射、并行块两 running 同时增量）单测。
