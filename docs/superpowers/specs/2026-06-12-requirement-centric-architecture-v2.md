# 需求中心架构 v2：实体模型重构（Requirement ⊃ Run）

> 状态：架构设计稿（2026-06-12 与用户三轮对齐后定稿方向）。
> 取代/吸收：`2026-06-12-requirement-centric-runtime.md`（其目录布局/双根解析器/clone 生命周期/声明层全部仍有效，
> 成为本架构的文件层推论）；本文补上它缺失的**实体关系重定义**——用户指出的「架构本质」。

## 0. 用户的架构观（三轮对齐结论）

**需求 = 数据层，工作流 = 逻辑层。**

| 对齐点 | 结论 |
|---|---|
| 需求生命周期 | **平台固定不变**（drafting→clarifying→ready→awaiting_approval→queued→running→awaiting_review⇄fix_revision→done/failed/cancelled）——不交给工作流编排 |
| Run 的状态机 | **保留**——工作流定义的 phase 状态机就是 run 的状态机，这是逻辑层的合法形态 |
| 阶段类型 | 平台内置阶段类型集合（clarify/approve/agent/acceptance/fix）可后期拓展 |

## 1. 病灶：平行缝合 vs 层级从属

```
现状（演化遗留：先有 Task+Workflow，后补 Requirement，bridge 缝合）：

Requirement ←─requirement-task-bridge─→ Task
（状态机A，平台）   事件监听互相同步      （状态机B，工作流）
                  【两个平级真相】

代价清单（全部源于缝合）：
- 状态不一致温床：cancel 不级联 / req-task 不同步 / restart 乱捡（state-machine-robustness 全部实例）
- task 持有 requirement 字段副本、独立标题——数据冗余两处
- UI 双视图 + 流水线页「已派生任务的需求由任务行代表」的去重拼接
- 文件区分离 runtime/requirements/ vs runtime/tasks/（用户由此发现本质）
- fix_revision 要独立 runner 在需求侧另起炉灶（task 状态机管不到需求级回路）
```

```
目标（层级从属，单向汇报）：

Requirement（数据层 = 唯一对外实体）
│  状态机：平台固定生命周期（不变）
│  物料：runtime/requirements/<id>/{spec, codebase/, attachments/, research/, deliveries/, runs/}
│
└─⊃ Run（逻辑层执行记录，从属于需求，不独立对外）
     状态机：所选 workflow 实例化（pending_design→…→done/failed）——保留
     创建：需求进入执行性状态时由平台创建（见 §3 触发表）
     终结：向需求**显式汇报** outcome → 需求状态机做宏观转移
     历史：每次执行 = 新 run（重跑不再清史）

Workflow（逻辑层模板）
     requires:（输入闸门：git 与否、必填项）
     phases + 流转（run 状态机模板——现有能力不变）
     delivers:（产出形态与验收方式）
```

**关系铁律**：信息流单向——需求驱动 run 创建（向下委托），run 终结汇报 outcome（向上报告）。
run 永不直接改需求状态；需求服务永不伸手进 run 的 phase 状态机。bridge 的「事件监听双向同步」消亡，
替换为一个显式接口：`reportRunOutcome(reqId, runId, outcome)`（outcome = delivered{prs}/delivered{artifacts}/failed{reason}/cancelled）。

## 2. 实体定义

### Requirement（数据层）
- 唯一对外实体：UI 主视图、通知、CLI 操作对象全部围绕需求
- 持有：spec / 附件 / codebase 集合 / 调研 / 交付物 / **runs 列表** / 当前状态 / 所选 workflow
- 状态机平台固定；其中 `running` 与 `fix_revision` 是「委托态」——内部展开为一个活跃 run

### Run（逻辑层执行记录）
- = 现 Task 的语义降级：从「平行实体」降为「需求的执行历史项」
- 有自己的状态机（workflow 实例化）——**保留现有 task 状态机机制原样**
- 种类（kind）：`execution`（主执行，dev 的 design→submit_pr）/ `fix`（修复轮，fix_revision 触发的轻量 run）/ 未来可扩展（如 `clarify` 也可建模为 run——后期拓展项，本期不做）
- 每次执行 = 新 run：重跑、fix 轮都是追加 run，历史保留；活跃 run 同时最多一个（需求级互斥）
- 物料：`runs/<seq>-<runId>/`（artifacts/logs/agent-calls/manifest）

### Workflow（逻辑层模板）
- 现有 phases/转换/agent 内联全部不变
- 新增声明：`requires:`（输入闸门）+ `delivers:`（产出与验收）——承接既有声明层设计

## 3. 状态机层级与触发表

需求状态机（不变）中每个状态的「执行器」与 run 的关系：

| 需求状态 | 执行器 | 与 Run 的关系 |
|---|---|---|
| drafting | 用户（确认代码库/编辑 spec） | 无 run |
| clarifying | clarify 执行器（现 clarifier） | 无 run（后期可建模为 clarify-run） |
| ready / awaiting_approval | 用户（审批 gate） | 无 run |
| queued | 调度器（全局 FIFO，已落地） | 出队时**创建 execution run** → 需求→running |
| **running** | **活跃 run 的状态机**（runner 推进 phase） | 委托态：run done+有交付→汇报 delivered；run failed→汇报 failed |
| awaiting_review | acceptance 执行器（delivers=pr→poller；delivers=artifacts→Web 人工验收） | 无活跃 run |
| **fix_revision** | **新建 fix run**（吸收现 fix-revision-runner） | 委托态：fix run 终结→汇报→回 awaiting_review 或 failed |
| done/failed/cancelled | 终态（failed 可重试=重新入队→新 execution run） | 无活跃 run |

**统一收口**：现在散落的 scheduler/runner/bridge/fix-runner 对需求状态的写入，全部收敛为两类：
执行器推进（平台服务驱动自己负责的状态）+ `reportRunOutcome`（run 终结的唯一汇报口）。
cancel 级联变平凡：取消需求 = abort 活跃 run（已有 task-lifecycle AbortController）+ 需求置 cancelled——一处代码。

## 4. 数据与文件层（承接 runtime spec，对齐 run 实体）

> R2 实施修正（2026-06-12 落地）：迁移号实际取 **044**（写 spec 时预估 046；迁移按号递增执行，
> 预留跳号会让后落低号被静默跳过——撞号教训变体，后续 spec 一律写「实施时取当时最大+1」）。
> 目录实际为 **`runs/<taskId>/`（不带 seq 前缀）**——getTaskRoot(taskId) 无法廉价查 seq，
> seq 是 DB 列只供排序展示。

- `tasks` 表 → 语义演进为 runs：**不改表名**（成本不对称），加列 `kind`（execution/fix）+ `seq`（需求内序号）（迁移 044 ✅）；
  `requirement_id` 已非空；title/requirement 字段副本停止使用（数据从需求读）
- req:run 从 1:1 改 **1:N**：重跑=新 run 替代 resetTaskForRerun 的清史复用（✅ 已删除，`startNewRunForRequirement` 接替）；task-factory 的 409 守卫改为「无活跃 run」（✅）
- 文件：`runtime/requirements/<id>/runs/<taskId>/`（✅ 双根解析器照旧服务存量 runtime/tasks/）
- 执行视图：TaskRunView 改挂需求页内（按 run 切换的执行历史），独立任务页降级为 run 详情路由
- 流水线页去重拼接逻辑消亡：一行=一个需求（其活跃 run 的 phase 进度内联展示）

## 5. 它根治什么（动机清单）

| 旧问题 | 在新模型下 |
|---|---|
| cancel 不级联 / req-task 状态不一致 | reportRunOutcome 单口 + 委托态语义，一致性由层级保证 |
| 重跑丢历史（执行时间线只有最后一轮） | 每次执行新 run，历史天然保留 |
| fix-revision-runner 独立炉灶 + 沙盒被清则 failed | fix=标准 run；codebase 归需求所有（runtime spec B3）后沙盒尴尬消失 |
| 自定义工作流拿不到增值服务（前提讨论） | 增值服务=需求生命周期各状态的执行器，**任何 workflow 的 run 都嵌在同一生命周期里**——天然全拿 |
| artifact 探针靠 gate hack 模拟验收 | delivers=artifacts → awaiting_review 用人工验收执行器，正规化 |
| 文件分离 | runs/ 从属需求目录 |
| 流水线页双行去重 | 一需求一行 |

## 6. 迁移分期（在 runtime spec F 节之上修订）

| Phase | 内容 | 依赖 |
|---|---|---|
| **R0** ✅ | 路径收口 getTaskRoot（已完成 a06d383） | — |
| **R1 汇报接口** | `reportRunOutcome` 落地，bridge 改为其唯一调用方（外壳保留行为不变）——先把单口立起来，缝合代码逐步迁入 | dogfood 主库废除通过 |
| **R2 run 多历史** ✅（2026-06-12，迁移实为 044） | tasks 加 kind/seq、重跑=新 run、文件落 runs/（执行视图按 run 切换属 R6 UI 收束，本期流水线先只显示最新 run） | R1 |
| **R3 fix=run** ✅（2026-06-12） | fix-revision-runner 重构为创建 fix run（内置 `__fix` 工作流走标准 runner 管线；沙盒=clone 远程交付分支续作；bridge 翻译 fixed outcome 经 reportRunOutcome；fix-progress 退役） | R1、R2 |
| **R4 codebase 统一** | = runtime spec Stage 3（clone 归需求） | R2 |
| **R5 声明层** | requires/delivers + 三闸门 + acceptance 执行器按 delivers 分发（与交付物 P0 合流） | R1 |
| **R6 UI 收束** | 需求页为唯一主视图（run 历史内联）、流水线一需求一行、任务路由降级 run 详情 | R2 |

节奏不变：先 dogfood 主库废除一轮；期间可做 R1（外壳不变的接口收口，低风险）。

## 7. 风险与开放问题

- **tasks 表名不改但语义变**：代码注释与文档必须旗帜鲜明（「task=run 的历史名」），防新代码按旧语义消费
- run 1:N 后磁盘增长：runs 轻物料（codebase 已剥离），retention 按需求终态清 codebase、runs 日志随需求删除——可控
- 并行块 fork 的子 task：在 run 模型下是 run 的内部结构（parent_task_id 已有），不升格为独立 run
- 开放：clarify 是否最终也建模为 run（统一「一切执行皆 run」）——后期拓展，本期不动
- 开放：run 状态机与需求状态机的「委托态」在 UI 上怎么表达（需求 running 时展开 run phase 进度）——R6 设计
