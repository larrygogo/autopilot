# 交付物抽象（输入 / 产出双轴）设计备忘

> 状态：**探针阶段**（Step 1 进行中）。本文沉淀 2026-06-12 architect + pm 两份评估的共识，
> 作为 P0 落地时的设计基准。P0 开工前须先用探针数据校订本文。

## 背景与决策

定位声明（CLAUDE.md「产品分层定位」末条，2026-06-12）确认：当前产品支持范围 =
PR 交付管线的定制轴。同日用户决定开泛化闸门，提案按「输入 / 产出」双轴抽象：
git 仓库只是输入的一种，PR 只是产出的一种。

**评估结论：方向成立，但两条轴不等价，且这期只开各自的一格。**

- **产出轴**：「文件产物」不是新物种——PR 本身就是可评审持久物，现有
  `awaiting_review ⇄ fix_revision` 回路对文件产物同构复用。变的只有三件事：
  ①交付物在哪看（GitHub → autopilot Web）②验收信号从哪来（poller 判 merge →
  Web 上的人点按钮）③反馈怎么回注（CHANGES_REQUESTED → 评论注入，RPC 路径已存在）。
  **正确抽象点 = 验收信号源可插拔，不新增状态机状态。**
- **输入轴**：只开「无库」一格。阻塞不在沙盒（ad-hoc 已支持空目录退化），在三道
  人为闸门 + 调度器（见下）。「上传参考文件 / URL 抓取」是另一套基建，这期不碰。
- **action 型产出（发邮件等不可逆动作）：整体推迟**。前置 gate 挡不住真正的风险——
  起草 agent 跑 bypassPermissions，在 gate 之前就有能力执行动作。正解 =
  「agent 只起草 payload，执行由确定性框架代码做」+ 能力级隔离（L2 沙盒），
  两个前置都不存在。`delivers:` 枚举不预留 `'action'` 值。

## 三步走

1. **探针（当前）**：零内核改动，用现有引擎手搓 `artifact` workflow（gate 人工验收 +
   deliver 阶段 copy-out 产物到持久目录），跑 2-3 个真实设计图 / 网页 demo 需求。
   验证场景为真 + 拿实测痛点。实施计划：`docs/superpowers/plans/2026-06-12-artifact-probe-workflow.md`。
2. **P0 本体**：探针确认场景真实后，按下文骨架拆 Phase A / B 两批 PR。
3. **看数据**：实际痛感决定要不要碰轻重分档、输入轴下一格。

## P0 技术骨架（architect 评估，待探针校订）

### 输入侧：`requirements.input_mode` 列（迁移 041）

`TEXT NULL`：`NULL`=未确认（drafting 默认）/ `'git'`=基于代码库 / `'none'`=确认无库。
回填 `input_mode='git' WHERE workspace_id IS NOT NULL`。不能只靠 `workspace_id IS NULL`
推导——create 会自动派生主库，NULL 区分不了「尚未确认」和「确认为无」。

闸门改动清单（输入侧全部改造面）：

| 位置 | 现状 | 改为 |
|---|---|---|
| `requirements.create`（rpc-methods.ts ~:1038） | 项目无 workspace 拒建需求 | 删守卫；无库则 workspace_id=NULL |
| `transition → clarifying`（~:1130） | 卡 workspace_id 非空 | 卡 `input_mode IS NOT NULL`（none 走 clarifier 纯文本模式——现有第 3 级降级变声明态） |
| `requirements.enqueue`（~:1145） | 卡 workspace_id 非空 | 卡 input_mode + 交叉校验（none × delivers:pr → 拒） |
| `requirement-scheduler`（~:260 + tickRepo + :114 globalActive） | 无库需求不调度（queued 永久死锁） | 无库调度道（groupId 保留值 `"::none"`）；**globalActive 过滤同步改**，否则并发上限被穿透 |
| `requirements.setWorkspaces` | 不接受空集 | 显式空集 → 清集合 + `input_mode='none'`；非空 → `'git'`。冻结闸门原样适用 |

### 产出侧：`delivers:` 声明 + `requirement_deliveries` 表（迁移 042）

- `workflow.yaml` 顶层 `delivers: pr | artifacts`（缺省 `auto` = 事实推断，老用户副本零影响）。
  声明只用于 enqueue 预检和 UI 预告；**运行时判定以事实为准**（hasPr / hasDeliveries）。
  registry（core）只透传字符串，枚举语义全在 daemon。
- 新表 `requirement_deliveries(id dlv-NNN, requirement_id, task_id, round, path, summary, created_at, UNIQUE(requirement_id, round))`。
  每**验收轮**一行（驳回重交 = round+1，对应 PR 模型的新 commit），不做文件级行。
- **物理存放：交付时 promote 出任务沙盒**到需求级持久目录。原则：交付物生命周期属于
  需求（这件工作），不属于任务（某次执行尝试）——PR 模型里交付物在 GitHub（沙盒外），
  artifact 对称放需求目录。⚠ 注意 `deleteRequirementClone` 在需求 done/cancelled 时
  **整目录删除 `runtime/requirements/<reqId>/`**（requirement-clarifier.ts ~:752）——
  P0 落地时要么把清理收窄到 `workspace/` 子目录，要么交付目录放
  `AUTOPILOT_HOME/deliverables/<reqId>/`（探针采用后者）。promote 后 done 清沙盒、
  retention、重跑都不再威胁交付物。

### 改造面（PR 路径零回归是底线）

| 模块 | 改动 | 量级 |
|---|---|---|
| bridge `targetReqStatus` | hasPr 分支不动；else 前插 `hasDeliveries → awaiting_review`（**hasPr 优先**，混合交付不支持） | +3 行 |
| pr-poller `pollOne` | 有 deliveries 时静默 return（人签收，poller 无事可做），消除 5 分钟一条的 warn | +2 行 |
| fix-revision-runner | repos 空 **且** 有 deliveries → artifact 修复模式（cwd=沙盒根、prompt 去 git push 要求、结束 promote round+1）；repos 空且无 deliveries 维持 fail | ~80 行 |
| 状态机 / sandbox / dev workflow / submit_pr / CI 回路 | **零改动** | 0 |

验收 affordance：Web 需求页 awaiting_review 态——PR 模式显示 PR 链接，artifact 模式显示
验收卡（文件树 + 预览 + 通过/驳回）。CLI 对等 `req accept / req reject -m`。
**验收 ≠ 审批**（结果 vs 承诺，两个产品概念不合并；UI 组件形态可共享）。
通知零改动（notification-recorder 已订阅 awaiting_review）。

### 红线分层（core 零业务知识）

core 持有数据管道（`input_mode` 列、deliveries 表 + CRUD 入单写白名单、`delivers:` 透传、
promote 纯文件搬运），daemon 持有行为语义（枚举合法值、bridge/poller/fix-runner 分发、
enqueue 交叉校验）——沿用 requirement-sub-prs 的既有分界。`'email'/'send'` 字样哪层都不进。

## 范围警戒线（pm 评估）

- **预览不运行任何东西**：图片直显 + 静态单文件 HTML iframe，其余文件列表 + 下载。
  别从「预览 demo」滑向跑 dev server / npm install。
- **交付终点 = 持久区 + 下载**。不做交付到 S3 / vercel / 另一 repo。
- **轻重分档这期不做**，artifact 需求全走重流程；重流程痛感本身是分档该切在哪的数据。
- 不做清单：action 型、调度泛化、TUI 适配、文件上传通道、预览运行时、外部交付目标、
  产物版本 diff、工作流编辑器的交付形态图形化定制。

## 风险表

| 风险 | 阶段 | 等级 | 缓解 |
|---|---|---|---|
| scheduler 并发计数穿透 | A | 高 | tickGroup 单测覆盖 NULL workspace 候选 + 计数 |
| 无库 queued 死锁（漏改调度道） | A | 高 | 端到端测试：无库需求 enqueue 后必须起 task |
| bridge 误把 artifact 需求直通 done | B | 高 | targetReqStatus 三分支测试矩阵 |
| fix-runner「repos 空」语义分裂误伤 PR 路径 | B | 高 | 守卫 = deliveries 存在；PR 模式回归测试 |
| 沙盒被清后 artifact 驳回无处修 | B | 中 | 复用现有 failed 停下报人语义 |
| 'pr'/'artifacts' 枚举漂进 core | 全程 | 中 | 分层表 + code review 红线 |

## 探针反馈（跑完填这里）

- [ ] 场景为真？（实际跑了几个需求、是真实需要还是演练）
- [ ] 澄清期痛点（PR 语义提问框架对 artifact 需求的违和度）
- [ ] 验收时刻痛点（gate 在任务页 vs 期望在需求页；沙盒文件浏览够不够看产物）
- [ ] 归档痛点（手动去 `AUTOPILOT_HOME/deliverables/` 拿文件的体验）
- [ ] 重流程痛点（哪一步最想跳过：澄清？审批？）
- [ ] 对 P0 骨架的修正
