# 废除需求「主库」概念 — 技术改造 Spec

> 决策（2026-06-12，用户拍板）：需求的代码库不再有主/副之分。三点依据：
> ① 每任务独立 clone 沙盒，仓库不再是冲突域 → 调度只按全局并发上限，不按仓库串行；
> ② 需求天然跨库（前端页面+后端接口源自同一需求），澄清无主次 → 澄清浅 clone 拉全部所选库；
> ③ 沙盒布局统一：废除「单库=顶层即仓库根 / 多库=子目录」双形态，永远 `workspace/<alias>/` 子目录。

## A. 数据层：`requirements.workspace_id` 语义降级（不删列）

**方案 (b)**：列保留、继续写、语义降级为「冗余缓存 = 集合第一个」；一切主库语义读方改走 `requirement_workspaces`。
- 不删列（表重建不可逆，024 教训）；不停写（遗漏读方拿到的仍是集合内合法库，最坏退化为 2026-06-11 前行为而非崩溃）。
- 迁移 043：纯数据校验回填（集合空但列非空→补集合行；列 NULL 但集合非空→回填列=created_at 最早），无 DDL、幂等。
- `setRequirementWorkspaces` 去 `primaryId` 参数，内部写 `workspace_id = wsIds[0]`。
- 读方清单：scheduler 三处（→B）、clarifier（→C）、task-factory 排序改集合自然序、RPC transition 守卫改「集合非空」、`listRequirements({workspace_id})` 改 EXISTS 子查询（任一关联库命中）、pr-poller main-scope fallback **不动**（服务存量）。

## B. 调度器：纯全局上限 FIFO

- 删 `tickRepo/tickGroup/_inflightGroups/groupId`；保留 `_globalSchedulerLock`；`_pendingTicks: Set` → `_pendingTick: boolean`。新签名 `tick()`。
- 调度体：active = 全部 `running|fix_revision` 计数；queued 按 created_at FIFO；while 循环填满空槽（N>1 一次事件填满）。
- 删 `workspace_id !== null` 过滤与无库守卫 → **无库需求可调度**（失败可见替代静默死锁，符合失败自愈哲学）。
- **补 daemon 启动 tick**（现状重启后存量 queued 要等下一事件才被捡起）。

## C. 澄清器：全集多库浅 clone

- 布局 `runtime/requirements/<reqId>/workspace/<alias>/`（safeAliasDir 从 sandbox.ts export 共用）；`ensureRequirementClones(reqId, wsList)` 逐库幂等、**并行 clone**、每库 120s 超时。
- 旧单库平铺布局（`workspace/.git` 存在）→ 整目录删除重建（暂态缓存不写双格式 reader）。
- **按库降级**：clone 成功→子目录；失败→该库走远程快照拼 prompt；全失败→纯文本。（与沙盒「任一失败整体退化」有意不同：澄清只读，半套无害）
- prompt 布局段改列表式（单库同格式）；agent cwd = `workspace/` 根。
- 冻结闸门、生命周期清理零改动。

## D. 任务沙盒：统一 multi-clone 布局

- `ensureTaskSandbox` 删除单/多分叉，凡 git 一律 multi-clone（单库=长度 1 repos）。`.worktree.json`：`mode:"multi-clone"` + 顶层镜像字段保留写（=repos[0]，防御未排查 reader）+ `repos[].primary` 保留=「第一个 true」（纯位置语义，接口不动）。
- 旧格式 reader 全部保留（历史任务可浏览/清理/删分支）。
- `listTaskRepos` 零改动（repos.length≥1 分支已覆盖单元素）。
- **dev workflow 必改**：`repoLayoutSection` 条件 `repos.length <= 1→空串` 改为 `repos.length === 0 || repos.every(r => r.dir === "")→空串`（新布局单库代码在 `./alias/`，不告知=agent 在根上 git fatal）；`submit_pr` 的 `appendSubPr` 条件从 `length>1` 改为 `r.workspace_id && reqId`（**单库也落 sub_prs**，poller 全走聚合路径，main-scope 兼容退役为历史通道）；去「★主库」文案。
- **老用户必须 `autopilot workflow sync dev --apply`**——这次破坏面比上次大：老副本在新框架下**所有 git 单库任务都会坏**（repo_path=workspace 根不再是仓库）。三件套提示：task-factory warn 日志 / release note / CLAUDE.md。

## E. UI / RPC

- `requirements.setWorkspaces` 入参 `primary_workspace_id` 接受但忽略（兼容老 web-dist 一版）。
- Picker 去星标单选→纯多选；顺势修正过期文案「任务只在主库改动」→「所有已选库均可改动、各自交付 PR」。
- RequirementDetail 侧栏去「主仓库」标记；`pr_url` 降级为「展示镜像=第一个交付 PR」（真相在 sub_prs）。

## F. 分期（4 Stage，PR 路径零回归为验收线）

1. **Stage 1 数据层**：043 + setRequirementWorkspaces 签名 + 读方清单 + 守卫改集合非空 + Picker 去星标。
2. **Stage 2 调度器**：tick() 重写 + 启动补 tick + 无库可调度。测试：组串行用例删、全局 FIFO/无库可调度/启动捡存量/N=2 填满。
3. **Stage 3 澄清器**：多库 clone + 旧布局重建 + 按库降级 + prompt。测试四态：单库/多库/部分失败/全失败。
4. **Stage 4 沙盒统一**（最大风险，最后发布）：ensureTaskSandbox + dev workflow + task-factory + 回归清单 6 条（单库全链路 / 多库全链路 / 历史任务 / fix_revision / poller 新旧路径 / retention）。发布动作：release note + CLAUDE.md + sync 提示。

### 风险表

| 风险 | 等级 | 缓解 |
|---|---|---|
| 老 dev 副本 × 新框架 → 单库任务全坏 | 高 | sync 三件套提示；Stage 4 单独发布 |
| 遗漏的主库语义读方 | 中 | 列继续写=最坏退化旧行为；合并前全量 grep workspace_id 过语义 |
| 调度顺序变化感知 | 低 | 决策预期 |
| 澄清旧平铺与新布局冲突 | 低 | 检测删除重建 |
| 迁移 043 撞号 | 低 | 合并前查号 |
