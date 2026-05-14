# 对话式提需求（extract + clarifier 接管）设计文档

- 日期：2026-05-14
- 范围：用户操作流 ②「提需求」环节端到端打透
- 方案：A · 共享 core + Web/CLI 并行做（3 个 PR）
- 依赖：PR #64（① 配置首跑）已 merge；clarifier 系统（PR #62 进度反馈）已就绪

## 一、背景与目标

### 当前痛点

- `Start.tsx` 是表单：`mode=choose` 提供"对话式"和"表单式"二选一，但"对话式"只跳通用 `/chat`，不引导提需求；"表单式"是裸表单（标题 + spec_md + project/codebase 选择）
- CLI 完全没有提需求入口（`task start` 接 `--requirement` 直跑工作流但不引导）
- Project / Codebase 选择对新手是黑盒
- 提需求后才进入 clarifier 调查，但"提需求"本身这一段缺少 AI 帮忙

### 目标

把"提需求"做成 **AI 帮忙整理 + 用户选环境**：

1. 用户描述一段口语化需求 → AI 生成 `title` + `spec_md`
2. Project / Codebase 用户自己选（顶部固定选择器，默认最近活跃）
3. 抽取完毕**立即**建 draft requirement、跳详情页，clarifier 自动接管走调查阶段
4. CLI 提供 `req new` 交互/非交互双模式
5. Web 的 `/start` 删表单 / 删通用 chat 入口卡，对话式成为唯一入口

### 非目标

- 多轮抽取追问（一次性 AI 生成，不准让 clarifier 后期澄清）
- AI 抽取后的"编辑确认"卡片
- `req new` 草稿保存机制（用 `-f file.md` 替代）
- 表单式入口 fallback（完全干掉）

## 二、核心模块：clarifier extract stage

复用现有 clarifier agent，加 `stage=extract/investigate` 参数，prompt 内分支。

### 2.1 入口签名

`src/cli/requirement-clarifier.ts` 已存在 `runClarifierRound`（调查阶段）。新增并列函数：

```ts
export interface ExtractInput {
  raw_text: string;
  project_id: string;
  codebase_id?: string | null;
}

export interface ExtractResult {
  title: string;
  spec_md: string;
  trace?: ClarifierTrace;  // 复用 PR #62 进度反馈
}

export async function runClarifierExtract(input: ExtractInput): Promise<ExtractResult>;
```

### 2.2 兜底语义

抽取**永不失败**：

| 失败场景 | 兜底 |
|---|---|
| agent 未配 / provider 未启用 | `title = raw_text.slice(0, 30)`, `spec_md = raw_text` |
| 返回非法 JSON | 同上 |
| 网络/超时 | 同上 |

设计意图：抽取是"锦上添花"，不应阻塞用户提需求。即使 LLM 不可用也能落 draft，clarifier 调查阶段（已有）再帮用户精修。

### 2.3 框架边界

`runClarifierExtract` 放 `src/cli/requirement-clarifier.ts`（已有），不放 `src/core/`——工作流专属。符合 CLAUDE.md。

agent 配置不动（`config.yaml.agents.clarifier` 已存在），prompt 内 if/else 分支 stage。

## 三、HTTP API

```
POST /api/requirements/extract
  body: { raw_text: string, project_id: string, codebase_id?: string }
  → 200: { title, spec_md, trace? }
  → 400: 缺 raw_text / project_id / project_id 不存在 / codebase_id 不属于该 project
```

**约束**：
- API 永远 200 + 兜底（除参数校验外）
- 400 仅用于参数校验，业务层失败兜底
- `trace` 字段透传 clarifier 现有 trace，前端可选展示

放 `src/daemon/routes.ts`，参考 `/api/setup/*` 的 import 风格。

## 四、Web `/start` 改造

### 4.1 文件改动

| 路径 | 改动 |
|---|---|
| `src/web/src/pages/Start.tsx` | **整体重写**：删 mode 切换 / 删表单 / 删 chat 入口卡 |
| `src/web/src/hooks/useApi.ts` | 加 `extractRequirement(input)` |

不新建组件——重写后 `Start.tsx` 约 80-100 行，单文件足够。

### 4.2 UI 骨架

```
┌─ 开始 · START ─────────────────────────────┐
│                                                │
│ 项目 *      [ Select: 项目 A         ▾ ]      │
│ 代码库      [ Select: codebase-1 (可空) ▾ ]   │
│                                                │
│ 说说你想做什么                                 │
│ ┌──────────────────────────────────────────┐ │
│ │ 比如：给登录页加忘记密码功能。需要邮件...│ │
│ │ (大文本框，~12 行)                       │ │
│ └──────────────────────────────────────────┘ │
│                                                │
│ [ 生成需求 →（loading 时显示「AI 整理中…」）] │
└────────────────────────────────────────────────┘
```

### 4.3 默认值规则

| 字段 | 默认 |
|---|---|
| project_id | 最近活跃 project（按 requirements.updated_at desc 找）→ 取不到则 `listProjects[0]` |
| codebase_id | 空（不抽取，让用户选；Web 没有 cwd 概念） |
| raw_text | 空 |

只有 1 个 project 时 select 禁用（视觉灰 + 不可选）。codebase 同规则，按 project 过滤。

### 4.4 提交流程

```
按钮 onClick:
  submitting = true
  ↓ api.extractRequirement({ raw_text, project_id, codebase_id }) → { title, spec_md }
  ↓ api.createRequirement({ project_id, codebase_id, title, spec_md }) → { id }
  ↓ navigate(`/requirements/${id}`)
  失败 → toast.error + submitting = false
```

抽取成功**不展示草稿确认**——直接建 requirement 跳详情页。title/spec_md 不准时由 clarifier 调查阶段处理。

### 4.5 删除项

- `mode === "choose"` 二选一界面整段删除
- `MessageSquare 跳 /chat` 入口卡删除（通用 chat 仍在导航栏，但不从 /start 进）
- 手输 `title` / `spec_md` textarea 删除

## 五、CLI `req new`

### 5.1 命令注册

新建 `src/cli/requirements-cli.ts`，导出 `registerRequirementCommands(program)`。在 `src/cli/index.ts` 调用。

```
autopilot req new                       # 交互式
autopilot req new --from-prompt "..."   # 一行内嵌
autopilot req new -f spec.md            # 从文件读
  -p, --project <id>                    # 显式指定，否则取默认
  -c, --codebase <id>                   # 可空
  --no-extract                          # 跳过 AI 抽取，title=前 30 字 / spec_md=原文
```

### 5.2 交互模式

```
$ autopilot req new
✓ 默认 project: proj-001（我的项目）
? 切换 project？[Enter 跳过 / 输入 id] »

✓ 默认 codebase: cb-002（autopilot/）  ← cwd 推断命中
? 切换 codebase？[Enter 跳过 / 输入 id / "none" 留空] »

? 描述你要做什么（多行，Ctrl+D 结束）：
> 给登录页加忘记密码功能。需要邮件...
> ^D

⠋ AI 整理中…
✓ 标题：登录页忘记密码功能
✓ 已创建需求 req-007  (状态: draft, clarifier 自动调查中)
  查看：http://127.0.0.1:6180/requirements/req-007
```

复用 T11 `--fix` 的 pipe vs TTY 双模式 stdin 读取（已在 Windows 验证可行）。

### 5.3 非交互模式

```
$ autopilot req new --from-prompt "给登录页加忘记密码功能" -p proj-001
$ autopilot req new -f ./spec.md
```

退出码：
- `0` 成功
- `1` 用户取消 / 输入空
- `2` project / codebase 找不到
- `3` 调用 daemon / extract 失败

### 5.4 cwd 推断 codebase

```ts
function inferCodebaseFromCwd(codebases: Codebase[]): string | null {
  const cwd = process.cwd();
  return codebases
    .filter((c) => cwd.startsWith(c.path))
    .sort((a, b) => b.path.length - a.path.length)[0]?.id ?? null;
}
```

CLI 比 Web "聪明"的一处——本地 cwd 是天然的项目上下文信号。

### 5.5 抽取调用路径

CLI **不直连 LLM**，通过 daemon HTTP 调 `POST /api/requirements/extract`：
- 复用 daemon 进程 + auth + log
- CLI 入口先 `ensureDaemon(client)`，未启则提示「先 `autopilot daemon start`」
- `--no-extract` 也仍需 daemon（建 requirement 走 daemon），但跳过 LLM 调用

## 六、测试覆盖

### 6.1 核心

```
tests/requirement-clarifier-extract.test.ts
  - extract 模式返回 { title, spec_md } 结构正确
  - agent 未配 / 失败 → 兜底（title=raw_text 头 30 字、spec_md=原文）
  - trace 字段在返回中存在
```

### 6.2 HTTP

```
tests/routes-extract-api.test.ts
  - POST /api/requirements/extract 正常路径
  - 非法 body 400（缺 raw_text、缺 project_id、project_id 不存在）
  - codebase_id 不属于该 project → 400
```

### 6.3 CLI

```
tests/cli-req-new.test.ts
  - --from-prompt 一行调用走通（mock extract）
  - -f file 路径读文件
  - --no-extract 跳过 LLM
  - cwd 命中 codebase 时默认选中
  - daemon 未启时提示 + 退出码 ≠ 0
```

### 6.4 Web

不做组件测试——参考 Setup 那次的做法，靠手测 + e2e dogfood。

## 七、边界与失败处理

| 场景 | 处理 |
|---|---|
| extract API agent 失败 | 返回 200 + 兜底（title=前 30 字、spec_md=原文）。不返 500 |
| project_id 必填没传 | API 400 + 文案；前端按钮 disable |
| codebase_id 不属于 project | API 400；前端切 project 时 reset codebase |
| 抽取返回非法 JSON | core 内 catch 解析错误，走兜底 |
| 抽取成功但建 requirement 失败 | 不做事务回滚，让用户重试 |
| 没有任何 project | UI 提示「先去 /library 创建 project」+ 链接；CLI 提示在 UI 创建 |
| `req new` 多行 stdin 在 Windows | 复用 T11 `--fix` 的 pipe vs TTY 双模式 |

## 八、PR 拆分

```
PR-1  core/clarifier extract stage + extract HTTP API + 测试    ~半天
PR-2  Web /start 重写 + project/codebase 选择器 + 删入口卡       ~半天
PR-3  CLI req new + cwd 推断 + 三种输入模式 + 测试               ~1 天
       ────────────────────────────────────────
       合计 ~2 天
```

PR-1 是 PR-2 / PR-3 的依赖。PR-2 与 PR-3 可并行。

## 九、不做（YAGNI）

- 多轮抽取追问
- AI 抽取后的编辑确认卡片
- `req new` 草稿保存
- 表单式 fallback
- `req list` / `req show` 子命令（需要时单独 PR）
