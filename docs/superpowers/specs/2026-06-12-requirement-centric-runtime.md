# 需求中心化运行时（Requirement-Centric Runtime）架构设计 Spec

> 状态：设计稿（2026-06-12 评审通过，分期实施中：Stage 0 先行，Stage 1-3 等主库废除 dogfood 一轮后开工）。
> 愿景（用户原话归纳）：**需求 = 数据层，工作流 = 逻辑层**。需求创建即建运行时文件夹，统一承载需求文件、codebase（可多库）、附件、调研产物、交付物——可拓展可兼容；工作流声明输入要求（是否选 git、必填限制）、执行方式、状态流转、产出形态。

## 0. 结论速览

| 问题 | 结论 |
|---|---|
| 统一目录 | `runtime/requirements/<reqId>/` 成为「一件工作」的唯一物料根；`runtime/tasks/` 不删除、降级为**历史只读区**（双根解析器，零文件迁移） |
| clone 所有权 | 归需求所有，路径唯一 `codebase/<alias>/`；浅→全升级 = **删除重 clone**（不做 --unshallow 原地升级——bypassPermissions agent 可能弄脏浅 clone，重 clone 无需证明干净）；重跑语义维持「删了重 clone」 |
| 执行历史 | `runs/<taskId>/`；维持 req:task 1:1 + 重跑清空，多 attempt 历史另立项（先回答产品问题再动 DB） |
| 工作流声明 | yaml 顶层 `requires: {git: true|false|"optional"}` + `delivers: pr|artifacts`；registry 透传形状、daemon 持枚举语义；`requires.git` 缺省派生自 `sandbox.git`（老副本零感知）；闸门 = clarifying / enqueue / setWorkflow 三处按当前所选工作流动态校验 |
| DB | 零表结构改动（布局纯文件层）；声明层复用交付物 spec 的 `input_mode`（**迁移号修正为 044**，交付物 spec 原写 041/042 已被占用） |
| 节奏 | **先 dogfood 主库废除 ≥3 个真实需求闭环**；期间只做 Stage 0（纯重构零行为）+ 交付物探针回填 |

## A. 目标目录形态

```
runtime/
├── requirements/<reqId>/        ← 一件工作的唯一物料根
│   ├── codebase/<alias>/        ← 代码库 clone（唯一一份；浅/全由 .codebase.json 标注）
│   ├── .codebase.json           ← clone 清单（alias/dir/ws_id/fidelity/branch/base/remote_url）
│   ├── attachments/             ← 附件（自 AUTOPILOT_HOME/attachments/<reqId> 双读迁入）
│   ├── research/                ← 澄清调研产物（预留）
│   ├── deliveries/round-<N>/    ← artifact 交付物（接管交付物 spec 的 deliverables 落点）
│   └── runs/<taskId>/           ← 每次执行（= 现 runtime/tasks/<id>/ 减 workspace/）
│       ├── artifacts/  logs/  agent-calls.jsonl  events.jsonl  agent-home/
│       ├── task-manifest.json
│       └── .worktree.json       ← 镜像保留写（防御历史 reader）
└── tasks/<taskId>/              ← 历史只读区（存量原地不动，双根解析；自然老化清空）
```

可拓展原则：新物料类型 = 新子目录 + core 路径 helper（`getRequirementDir(reqId, kind)`），不动状态机/DB/工作流契约；物料语义在 daemon/workflow 层（核心零业务知识红线不变）。

## B. Clone 生命周期

```
clarifying：ensureCodebase(shallow)（--depth 1 -b default）
task 启动：ensureCodebase(full, feat 分支)——现存浅 clone 整库删除重 clone
fix_revision：fixer 直接用 codebase/<alias>/（交付分支原地）——「沙盒被 retention 清走则 failed」在新需求上消失
重跑：删 codebase/* + 删远程 feat/ 分支 + 重 clone（现语义照搬）
```

| 物料 | 清理 |
|---|---|
| codebase/（重） | done 即清；cancelled/failed 走 retention（**按需求终态**，非终态永不清）；需求删除整树删 |
| runs/ 日志、deliveries、attachments（轻） | 不进 retention，随需求删除 |

⚠ `deleteRequirementClone`（现 done/cancelled 整删需求目录）必须**收窄为只清 codebase/**——否则误删日志/交付物/附件。需求删除才整树删。

零痕迹原则不变。clarifier 在 failed 重澄清时可能见到交付分支脏树：prompt 如实声明（既有哲学），不静默 reset。

## C. 执行历史

`runs/<taskId>/` 与 task 1:1，重跑清空重建（现语义平移）。TaskRunView / task logs / 沙盒浏览按 taskId 寻址经双根解析器，前端零改动。多 attempt 保留推迟（届时先回答：旧 attempt 怎么展示、占多少盘、谁看；可选路径=重新评估「重跑=新 task」模型，但与现行 1:1 相悖不在本 spec 翻案）。

## D. 工作流声明层

```yaml
requires:
  git: true        # true|false|"optional"；缺省派生自 sandbox.git（老副本零感知）
delivers: pr       # pr|artifacts；缺省 auto=事实推断（与交付物 spec 同一字段，单一定义）
sandbox:
  git: true        # 执行机制（怎么建沙盒）；requires.git 是入口闸门（能不能往下走）——分层不合并
```

三闸门（按 `req.workflow ?? "dev"` 动态校验）：clarifying 守卫（requires.git true→卡集合非空；optional/false→放行走纯文本）、enqueue（同上+集合空×delivers:pr 交叉拒）、setWorkflow（warn 提示，enqueue 兜底重验）。与审批后冻结无冲突（闸门全在冻结点前）。registry 加载 lint：requires.git true 而 sandbox.git 缺失 → warn。

与交付物 spec 整合：`input_mode` 列=迁移 **044**；`requirement_deliveries`=迁移 **045**；deliveries 落点改 `runtime/requirements/<reqId>/deliveries/`（原 AUTOPILOT_HOME/deliverables workaround 废弃）；探针结论回填本节再动工。

## E. 兼容（基石 = 双根解析器，零文件迁移）

```ts
getTaskRoot(taskId): 旧 runtime/tasks/<id>/ 存在 → 用旧（存量只读）；否则 → requirements/<reqId>/runs/<id>/
```

- 判定锚=目录存在性；新任务永不建旧根，两根互斥
- 硬编码收口清单（grep 实测 ~20 处 9 模块）：sandbox.ts(10)、task-logs.ts:37,58、artifacts.ts:33,51、manifest.ts:78,189、infra.ts:71（锁目录**不迁**减少面）、registry.ts:1225（零代码 prompt cwd）、done-workspace-cleanup.ts:31、cli/index.ts:602,724（展示串）
- `listTaskRepos` 签名/返回形状不变（布局唯一消费接口的价值兑现）→ **dev workflow 目标零 sync**（连续两次强制 sync 后用户成本敏感；做不到则并入一次 sync 绝不拆两次）
- `.worktree.json` 降级为 runs/ 内镜像；真相在需求级 `.codebase.json`；旧 reader 全保留
- DB 零 DDL；attachments 双读

## F. 分期

| Stage | 内容 | 风险 | 验收 |
|---|---|---|---|
| **0 路径收口** | ~20 处硬编码收口 `getTaskRoot()`（恒返回旧路径，零行为） | 极低 | bun test 0 fail + smoke + grep 仅剩定义处 |
| **1 需求目录骨架** | getRequirementDir + deleteRequirementClone 收窄 + attachments 双读迁入 | 低 | done 后轻物料存活；删需求整树清 |
| **2 runs 落位** | 新任务写 runs/；manifest/retention 双根扫描。★ 此后可见统一需求文件夹 | 中 | 6 条回归：新任务 PR 全链/旧任务可浏览清理/重跑/删除/retention 双根/logs --follow |
| **3 codebase 统一** | ensureCodebase 取代两处 clone；fix-runner cwd；done-cleanup/retention 按需求 | **高**（PR 主路径） | 单独发布；PR 零回归 5 条 |
| **4 声明层** | requires/delivers + 三闸门 + 迁移 044（与交付物 P0 合流，可与 1-3 并行） | 中 | 闸门矩阵 + 无库 enqueue 必须起 task |

### 风险表（要点）

| 风险 | 缓解 |
|---|---|
| 与未 dogfood 的主库废除叠加，失败归因失效（高） | 先 dogfood ≥3 需求闭环；Stage 0 先行 |
| Stage 3 动 PR 主路径（高） | 单独发布；重 clone 沿用已验证语义不发明新机制 |
| 双根漏改硬编码（中） | grep 收口进 Stage 0 DoD |
| deleteRequirementClone 收窄遗漏误删（中） | 单测「done 后轻物料存活」 |
| Windows MAX_PATH（runs 路径深两级）（中） | 文档 core.longpaths + smoke 深路径用例 |
| 迁移撞号重演（低） | 已修正 044/045；合并前查号 |
