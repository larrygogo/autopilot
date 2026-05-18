# Dogfood 实战记录

autopilot 用自己开发自己 — 本文档记录的是从"提需求 → 跑 dev workflow → 产出 PR"完整流程实战过程中发现并修复的真实 bug。客户跑同样的场景应该已经踩不到这些坑。

如果你跑 dogfood 又发现了新 bug，欢迎追加这份 log。

---

## 第一轮（2026-05-17 ~ 2026-05-18）

提需求：`docs 里中文版有些文件英文版根本没有，肯定漏译了好几个。能否做个对比脚本？`

**用 CLI 提交（模拟真实用户口语化输入）**：
```bash
autopilot req new --from-prompt "docs 里中文版有些文件..." -p proj-002
```

走通 5 阶段：design → review → develop → code_review → submit_pr。产物：`scripts/check-docs-translation.ts` + `.github/workflows/ci.yml` + `package.json` 加 `check:docs` script。

中途抓到 7 个真实 bug（commit 引用 `git log` 可查）：

| # | bug | 修在哪 | commit |
|---|---|---|---|
| 1 | clarifier 严格 JSON 解析在 LLM 返回 markdown 围栏 / 中文 spec 时卡死 | `src/daemon/requirement-clarifier.ts` 切 YAML wrapper | `548ea2e` |
| 2 | `routes-auth-token.test.ts` afterAll 误删真实 `~/.autopilot/runtime/api-token` 文件，daemon 起不来 | 测试 afterAll 备份+恢复 | `3802c91` |
| 3 | 状态机 `awaiting_approval → queued` 转换缺失，用户审批后入队报"非法状态转换" | `src/core/requirements.ts` ALLOWED_TRANSITIONS 加 queued | `0341c37` |
| 4 | requirement-scheduler 硬编码工作流名 `req_dev` 不存在（registry 是 `dev`），tickRepo 始终失败回滚 | 改为 `dev` | `b2174ec` |
| 5 | dev workflow develop 阶段 `git add -A` 把用户工作目录所有未提交散改一起卷入 commit，污染下游 code_review 的 diff | develop 阶段开头 `git stash --include-untracked`，commit 后 stash pop | `3fde8c6` |
| 6 | submit_pr 完成后 HEAD 卡在 task feature branch，daemon 主机后续 git 操作默认 base 错位 | submit_pr 末尾 `checkout default_branch` | `10c1bd7` |
| 7 | code_review reject 重做时 developer agent 没拿到 reviewer 反馈，看到 commit 已存在就回答"任务已完成"摆烂，循环到 max_rejections | develop reject 重做 prompt 拼入 `code_review_report.md` | `7304ab9` |

## 第二轮（2026-05-18）

提需求：`README 顶部加个 dogfood 状态徽章` → PR 真实创出 [#82](https://github.com/larrygogo/autopilot/pull/82)。

5 阶段端到端跑通，零 rejection。又抓到一个：

| # | bug | 修在哪 | commit |
|---|---|---|---|
| 11 | bug 5 fix 的 `git stash pop` 用 `check=false` 容错，pop 冲突时静默失败留 UU conflict markers，连锁让 bug 6 fix 的 `checkout default_branch` 也因 unmerged 失败 | pop 失败时把 unmerged 文件列表 + 恢复指引写到 `dev_report.md` | `0badbfc` |

## Onboarding 体验补足

| # | bug | 修在哪 | commit |
|---|---|---|---|
| 8 | `autopilot init` 只创空目录，新用户跑任何 dev task 都报"找不到工作流" | init 末尾自动 `cloneTemplate("dev", "dev")` | `312d633` |
| 9 | 老用户已 init 过的，examples 后续改 bug fix 拿不到 | 新增 `autopilot workflow sync <name>` 命令（dry-run + `--apply`） | `659a908` |

---

## 客户从 0 上手现在应该走的路径

```bash
git clone https://github.com/larrygogo/autopilot && cd autopilot
bun install
autopilot init                       # 自动装 dev workflow（commit 312d633）
autopilot daemon start               # 后台启动 daemon + supervisor
autopilot dashboard                  # 浏览器 → 创建 project / codebase → 提需求
```

老用户（init 已经在 fix 之前跑过）拉 repo 后跑一次：

```bash
git pull
autopilot workflow sync dev          # dry-run 显示 diff
autopilot workflow sync dev --apply  # 真覆盖
autopilot daemon restart             # 让新 workflow.ts 生效
```

## 测试覆盖现状

本次实战同时补的测试（防回归）：

- `tests/recover-dangling-tasks.test.ts` 7 用例：daemon 主动重启 vs 崩溃路径区分
- `tests/routes-auth-token.test.ts` 8 用例：token 鉴权 4 条路径（loopback 豁免 / Bearer / X-header / `?token=`）
- `tests/rpc-daemon-setHost.test.ts` 7 用例：setHost 网卡校验，防 daemon 进崩溃循环
- `tests/workflow-templates.test.ts` +9 用例：workflow sync diff / 覆盖行为
- `tests/supervisor-logic.test.ts` 11 用例：supervisor 退避决策（exit 0/75/crash、crash loop 30s 窗口、attempt 退避索引）
- `tests/workspace-retention.test.ts` 10 用例：days / max_total_mb 策略 + isTerminal 注入保护运行中任务

760 测试 / 0 失败（截至 commit `34471d8`）。

## 还没验过的边界（欢迎补）

- supervisor 真子进程端到端（spawn 实际 daemon 验证 RESTART_SENTINEL 立即重启 + crash loop 退避真生效）
- daemon log 长跑切割 / 大小限制
- workspace_retention 在 daemon 实际跑一段时间后真触发清理（单测只覆盖纯函数路径）
- 多设备局域网访问 token 二维码扫码流程（需要真实手机/平板）
