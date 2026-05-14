# 配置首跑引导 + doctor 设计文档

- 日期：2026-05-14
- 范围：用户操作流 ①「配置」环节端到端打透
- 方案：A · 核心后端先行 + 双前端并行

## 一、背景与目标

### 当前痛点

- `autopilot init` 只建目录 + initDb，**不写 config.yaml**，用户首跑后无任何配置文件参考
- `~/.autopilot/config.yaml` 完全靠用户手编，无引导
- Web 配置散在 SettingsHub 的 6 个 Tab，新用户进来面对一组空表单不知从何下手
- Provider 类没有健康检查，无法验证「凭证有效 / CLI 已装」
- CLI 没有 `config doctor` 之类的诊断命令
- `task start` 不前置校验配置，错误延迟到运行时才暴露

### 目标

把「新用户从 `bun run dev init` 到能跑通第一个工作流」这一段端到端打透：

1. **`config doctor`** — 分层检查（L1 静态 / L2 CLI 探测 / L3 凭证 ping），统一报告契约
2. **`config doctor --fix`** — CLI 交互式修复向导
3. **Web `/setup`** — 三步分页式首跑向导（Provider → Agent → Codebase 可跳）
4. **`task start` 前置校验** — 跑 L2，error 时拒绝入队
5. **`init` 改造** — 写一个带全注释的 config.yaml 模板，结尾打印下一步提示

### 非目标

- 不做 daemon 启动时 health check 常驻显示（首跑工具，不需要常驻）
- 不做配置变更 watch / 实时刷新
- 不做配置 diff / 历史
- 不代办凭证操作（`claude login` 之类永远不自动跑）

## 二、核心模块：`src/core/doctor.ts`

单一真相源。CLI、Web、`task start` 都从这里取检查结果，不再分别实现校验逻辑。

### 2.1 检查规则

**L1 静态校验**（纯文件 IO，<10ms）：

| ID | 检查 | 错误级别 |
|---|---|---|
| C1 | `config.yaml` 存在 | error，stop 后续 |
| C2 | `config.yaml` 解析成功 | error，stop 后续 |
| C3 | 已声明 provider 的 yaml 结构合法（仅校验已声明） | error |
| C4 | **底线**：≥1 个 `enabled: true` 且 `default_model` 非空的 provider | error |
| C5 | 一致性：每个 agent 的 `provider` 引用已声明 + enabled 的 provider | error |
| C6 | ≥1 个 agent | error |
| C7 | projects ≥1 | warning（可跳，dashboard 创建） |

**L2 CLI 探测**（含 L1 + 并发 spawn `--version`，~500ms 内）：

- 只对 enabled provider 探测，未启用 → `status: skipped`
- `where claude` / `which claude` 兜底定位
- 每个 provider 5s 硬超时
- shell mode 关闭，参数列表传入

**L3 凭证 ping**（含 L2 + 串行 ping，~8s/provider）：

- 串行避免凭证 race
- 每 provider 跑一次极简 prompt（如 `echo ping`），仅验证认证态
- 失败信息区分「未登录 vs CLI bug」

### 2.2 报告契约

```ts
interface DoctorReport {
  level: 1 | 2 | 3;
  status: "ok" | "warning" | "error";
  checks: CheckResult[];
  durationMs: number;
  generatedAt: string;  // ISO
}

interface CheckResult {
  id: string;                    // e.g. "providers.anthropic.cli"
  category: "config" | "provider" | "agent" | "project" | "codebase";
  status: "ok" | "warning" | "error" | "skipped";
  title: string;                 // 面向终端用户的最终文案
  detail?: string;
  fix?: {
    cli?: string;                // shell 命令字符串
    url?: string;                // dashboard URL
    auto?: string;               // --fix 能处理的 fix id 白名单
  };
}
```

**约束**：

- `title` 是面向终端用户的最终文案，CLI / Web 同一份，不再翻译
- `fix.auto` 仅出现在「能交互式修复」的检查项上；无 `auto` = 只能手动
- 检查器纯函数无副作用（除 L2/L3 spawn），独立单测
- L2/L3 spawn 超时 → status=error，detail="探测超时"

### 2.3 框架边界

`doctor.ts` 放在 `src/core/`，只检查框架基础设施（providers、agents、config.yaml 结构、projects 表），**不引入任何工作流专属字段**。符合 CLAUDE.md「框架核心不得引入工作流专属逻辑」。

### 2.4 主入口

```ts
export async function runChecks(opts: {
  level: 1 | 2 | 3;
  providers?: string[];  // 可选限定探测某些 provider
}): Promise<DoctorReport>;
```

## 三、CLI 体验

### 3.1 `init` 改造

```ts
program.command("init").action(() => {
  mkdirs(...);
  initDb();
  writeConfigTemplateIfMissing();
  printNextSteps();
});
```

- `writeConfigTemplateIfMissing`：**不覆盖已有文件**
- 模板顶部三行注释 + `providers.anthropic` 已启用 + `default_model` 给到 claude-sonnet-4-6
- 其他 provider 全注释保留为范例

模板（最终形态）：

```yaml
# autopilot 配置文件。
# 用 `bun run dev config doctor` 检查当前状态。
# providers / agents 是最少需要填的两项。

providers:
  anthropic:
    default_model: claude-sonnet-4-6
    enabled: true

  # openai:
  #   default_model: gpt-5
  #   enabled: true
  #
  # google:
  #   default_model: gemini-2.5-pro
  #   enabled: true

agents:
  # coder:
  #   provider: anthropic
  #   model: claude-sonnet-4-6
  #   max_turns: 10
  #   permission_mode: auto
```

init 结尾输出：

```
✓ 已初始化 AUTOPILOT_HOME
✓ 已生成配置模板 ~/.autopilot/config.yaml

下一步（三选一）：
  » bun run dev config doctor       检查配置
  » bun run dev config doctor --fix 交互式配置
  » bun run dev dashboard           浏览器配置
```

### 3.2 `config` 命令组

| 命令 | 行为 |
|---|---|
| `config doctor` | 跑 L1，打印人类可读报告，按 status 返回退出码 |
| `config doctor --probe` | 跑 L2 + L3 全探测 |
| `config doctor --json` | 输出 `DoctorReport` JSON（Web/CI 用） |
| `config doctor --fix` | 进入交互式修复向导，处理 `fix.auto` 白名单 |
| `config show` | 打印当前 config.yaml（脱敏 `base_url` 里的 `*://*@host`） |
| `config path` | 打印 config.yaml 绝对路径 |

### 3.3 `--fix` 交互式向导

- 内部按 `fix.auto` id 路由到对应处理器（如 `init.providers` → 跑 provider 选择步骤）
- 只处理白名单内的 fix；凭证操作（`claude login` 等）**永远不代办**
- 向导结束统一打印「仍需手动」清单

### 3.4 退出码约定

| 退出码 | 含义 |
|---|---|
| 0 | report.status = ok |
| 1 | report.status = warning |
| 2 | report.status = error |
| 3 | doctor 自身异常（IO 失败、yaml 解析失败） |

CI 可 `config doctor && task start ...` 串联。

### 3.5 `task start` 前置接入

在 `task start` action 起点跑 `runChecks({ level: 2 })`，仅在 `status === "error"` 时拦：

```ts
if (report.status === "error") {
  console.error("配置不就绪，请先修复：");
  printReport(report);
  console.error("\n或运行：bun run dev config doctor --fix");
  process.exit(2);
}
```

不在 task start 跑 L3（8s 太重）。L3 失败由任务运行时调 provider 失败时报错，错误信息里指向 `doctor --probe`。

### 3.6 错误信息原则

- 每条 error 必有 `fix.cli` 或 `fix.url`
- L2 失败时给出具体路径：「codex CLI 未找到（PATH 中无 `codex`）」
- L3 区分「网络/CLI bug」和「未登录」，前者建议重试，后者建议登录命令

## 四、Web `/setup`

### 4.1 路由与组件

```
src/web/src/pages/Setup.tsx              ← 新页面，三步分页
src/web/src/router.tsx                   ← 加 /setup 路由
src/web/src/components/SetupProgress.tsx ← 顶部进度条
```

`/setup` 不在导航栏，独立 flow。完成或跳过后跳 `/now`，并在 daemon 写 `setupDismissed: true`。

### 4.2 三步流转

| 步 | 内容 | 提交动作 |
|---|---|---|
| 1/3 Provider | 复选启用哪些；每个 enabled provider 填 `default_model`（下拉默认值）；底部固定提示「凭证需在终端 `xxx login`」 | `POST /api/setup/providers` |
| 2/3 Agent | 至少建一个；预填 `coder` + 步 1 选的第一个 provider；可加更多 | `POST /api/setup/agents` |
| 3/3 Codebase | 可跳过；表单 = 名称 + 本地路径，**复用已有 `<FolderPicker>` + `GET /api/fs/list`** | `POST /api/setup/codebases` 或 Skip |

每步进入时调 `GET /api/setup/status` 重读真相，避免与 CLI / 手编的并发 stale。完成第 2 步即满足 doctor 底线，进入 3/3 时顶部 banner 显示「核心配置已就绪 ✓ 第 3 步可选」。

### 4.3 HTTP API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/setup/status` | 返回 `DoctorReport`（level=1） |
| POST | `/api/setup/providers` | body: `{ providers: { [name]: ProviderConfig } }` |
| POST | `/api/setup/agents` | body: `{ agents: { [name]: AgentConfig } }` |
| POST | `/api/setup/codebases` | body: `{ name, path, projectId? }` |
| POST | `/api/setup/dismiss` | 标记已 dismiss（daemon state） |

**约束**：

- POST 接口写完 yaml 后立刻跑 `runChecks({ level: 1 })`，把新 `DoctorReport` 一并返回，前端不必再 GET
- L2/L3 探测前端单独触发（按钮「测试连通性」），不卷在 setup 提交里
- 写 yaml 走 `saveProvider / saveAgent`（已有），保留注释

### 4.4 入口与提示

- `/now` 顶部检测 `report.status==='error' && !setupDismissed`，挂「未完成首跑配置 ▸ 开始」卡片
- dismiss 仅影响 banner，**不影响 `task start` 前置**
- `/setup` 直访已完成的场景：显示「配置已完成，去 /now ▸」，但允许继续走

### 4.5 dismiss 持久化

存 daemon state + DB（一行配置），不存 localStorage。跨浏览器同步，符合 daemon 主权模型。

### 4.6 复用边界

- `/setup` 表单**不复用** SettingsHub 里的 Providers/Agents 编辑器（CRUD 视角 vs 向导视角，硬复用反而拧巴）
- 底层 API（`/api/providers`, `/api/agents`, `/api/codebases`, `/api/fs/list`）**共用**

## 五、测试覆盖（完整版）

### 5.1 核心层（`tests/core/doctor.test.ts`）

- L1：全 enabled / 无 enabled / agent 引用未启用 provider / yaml 不存在 / yaml 损坏
- L2：CLI 找不到 / CLI 找到但报错 / 多 provider 并发
- L3：mock CLI ping 返回（避免真调远端）
- 报告契约：`fix.auto` id 白名单完整

### 5.2 CLI 层（`tests/cli/config-commands.test.ts`）

- doctor 退出码（0/1/2/3）
- `--json` 输出结构稳定
- `--fix` 交互式：stdin pipe 模拟用户输入，验证 yaml 落地结构 + 注释保留
- `init` 模板：不覆盖已有文件、首次写入内容匹配 fixture

### 5.3 集成（`tests/integration/task-start-gate.test.ts`）

- 空 config → task start 退出码 2 + stderr 含 fix 提示
- 完整 config → task start 正常入队

### 5.4 Web 层

- `Setup.tsx` 三步流转 + dismiss 状态（RTL）
- API 路由用 supertest 风格直击 daemon

## 六、边界与失败处理

| 场景 | 处理 |
|---|---|
| yaml 损坏 | C2 stop 后续；`fix.cli` 给 `config show --raw` + 提示 .bak |
| `config.yaml.bak` 已存在 | 沿用 `saveConfigRaw` 现行覆盖语义 |
| `--fix` 中途 Ctrl+C | 已写部分保留，无事务回滚；下次 doctor 接着补 |
| Web /setup 刷新 | 不存表单半成品，刷新 = 重来 |
| 多客户端并发改 yaml | 不引锁；前端检测到提交后 status 反向恶化则提示「可能被并发修改，请刷新」 |
| L2/L3 spawn 超时 | 各 5s；超时 → error，detail="探测超时" |
| Windows CLI 探测 | `where claude` 兜底；shell mode 关闭 |

## 七、顺手清单（本次一并做）

| 项 | 理由 | 估时 |
|---|---|---|
| `/api/fs/list` 加 host 校验，非 loopback 时 403 | setup 流程频繁触达；安全口子要先收 | 30 min |
| `bun run dev doctor` 顶级别名 | 用户可能本能输；零成本 | 10 min |

## 八、PR 拆分

```
PR-1  core/doctor.ts + types + 单测                  ~半天
PR-2  init 模板 + config 命令组 + --fix              ~1 天
PR-3  HTTP API + /setup 路由 + Setup.tsx             ~1 天
PR-4  task start 前置 + fs/list host 校验 + e2e      ~半天
       ────────────────────────────────────────
       合计 ~3 天
```

## 九、不做（YAGNI）

- doctor 缓存
- 配置变更 watch + 自动重新 doctor
- Web 实时 health header（首跑工具不需常驻）
- 配置 diff / 历史
