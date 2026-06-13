# Provider 条目化重构设计 (2026-06-13)

> 状态：**设计待审**（用户已拍板模型方向，实现分期，本文档是 P1/P2 实现的权威依据）。
> 来源：architect（技术）+ pm（产品）联合设计，主 agent 合成。

## 1. 动机与目标模型

现状：provider 是写死的 3 家官方（anthropic/openai/google，`PROVIDER_NAMES` 常量铺在 ~5 个文件）+ 每家「双模式」（cli/api）+ 内置 compat 预置（deepseek/kimi/minimax）。用户无法增删，API/CLI 在一张卡里耦合。

目标（用户拍板）：把 provider 改成**用户自管的单类型实例列表**。

- 每个 provider 条目带**类型标记 `cli` 或 `api`（单类型，二选一）**，两者平级
- claude 不再是「双模式卡」：`anthropic`(CLI)、`anthropic-api`(API)、`deepseek`(API)… **各自独立条目，可增可删**
- 加 **CLI 类型**条目时若本地没装对应 CLI → 标「本地不支持」（仍可添加，标记不可用，因为可能在别的机器跑）
- 删除**已被工作流引用**的 provider → 正在跑的任务**跑完当前最后一轮**，之后引用它的工作流标「无法使用」

### 已确认决策
1. **单类型条目**：workflow `agent.provider` 按条目 name 引用
2. **种子预置可删**：首次升级把官方三家预置为种子条目；compat 预置转「可选模板」一键添加
3. **先出设计 spec 再实现**（本文档）

## 2. 硬约束（不可违反，否则回归）

- **种子 name 必须沿用 `anthropic`/`openai`/`google`**（语义 = 「Anthropic 官方 CLI 接入」）。老 workflow.yaml 的 `provider: anthropic`、dev 副本冻结快照、`DEFAULT_AGENT.provider="anthropic"` 全部零改命中种子条目。`type`/`subtype` 是**新增维度**，name 不动。
- **name 是引用契约键，已被工作流引用的条目不允许改 name**（只能删了重建）。
- **core 零业务 / 不反向依赖 agents**：providers 表 schema 与 (type/subtype) 字符串是「形状」，core 只存查；CLI 子类→适配器、compat 模板数据全在 agents 层；迁移文件内联冻结 compat 数据（迁移是历史快照，冻结数据是正常形态，不算依赖）。
- **Single-Writer**：providers 表所有写操作收口 `src/core/db.ts` helper（同 notifications/requirement-deliveries 范式）。
- **迁移只新增表 + 插数据**，不删改既有 config.yaml / api_keys，可回退。

## 3. 数据模型

### 决策：新建 DB 表 `providers`（不再用 config.yaml 承载条目）

理由：条目要软删除 + 状态标记 + 被 workflow 反查引用；DB 优于 yaml。config.yaml 的 `providers.<name>` 段保留**只读兼容**给迁移一次性导入，导入后运行时以 DB 为准。

### 表 schema（迁移 047，实现时复核当时最大号 +1）

```
providers
  id            TEXT PK              -- prov-NNN
  name          TEXT NOT NULL UNIQUE -- 引用键（workflow agent.provider 写这个）。种子沿用 anthropic/openai/google
  display_name  TEXT NOT NULL
  type          TEXT NOT NULL        -- 'cli' | 'api'
  subtype       TEXT NOT NULL        -- cli: 'claude'|'codex'|'gemini'|'custom'
                                     -- api: 'anthropic'|'openai'|'google'|'openai-compat'（API 形状）
  cli_bin       TEXT                 -- subtype=custom 的二进制；内置子类留空走默认 map
  cli_login_cmd TEXT
  cli_status    TEXT                 -- 'ok'|'missing'|'unknown'
  cli_version   TEXT
  cli_checked_at TEXT
  base_url      TEXT                 -- 空则用 subtype 官方默认 / compat 模板
  env_key_name  TEXT                 -- API key 环境变量回落名
  default_model TEXT
  enabled       INTEGER NOT NULL DEFAULT 1
  state         TEXT NOT NULL DEFAULT 'active'  -- 'active'|'deleted'（P2 软删）
  origin        TEXT NOT NULL DEFAULT 'user'    -- 'seed'|'template'|'user'
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
```

- API key 仍存 `api_keys` 表（迁移 041，AES-256-GCM），`api_keys.provider` ↔ `providers.name` 字符串软关联，**零迁移、无外键**（key 可独立于 provider 生命周期，env 回落）。
- claude-CLI 与 claude-API = 两条独立行（name 不同：`anthropic` vs 如 `anthropic-api`）。

## 4. Provider 解析重写

去掉 `PROVIDER_NAMES` 硬枚举，解析按条目 **(type, subtype)** 驱动。新增 `src/core/providers.ts`（纯查询 `getProviderByName`/`listProviders`，写函数转调 db.ts 白名单）。

- **`resolveMode` 改写**：mode = 条目的 `type`。phase 内联 `mode:` 字段语义从「选接入方式」降为「断言」——显式写且 ≠ 条目 type 则报错。
- **`createAgent` / 适配器选择从 name 切到 subtype**：
  - `type=cli`：claude→AnthropicProvider、codex→OpenAIProvider、gemini→GoogleProvider、custom→通用 CLI provider（P2）
  - `type=api`：anthropic→AnthropicApiAdapter、openai→OpenAIApiAdapter、google→GoogleApiAdapter、openai-compat→createCompatAdapter（base_url 必填）
- **`isCompatOnlyProvider` 删除**（逻辑被 mode=type 替代）。`BUILTIN_COMPAT_PROVIDERS` 转「**模板目录**」（生成 type=api/subtype=openai-compat 条目用）。
- **`agentForPhase` 的 default_model fallback**：从 `loadProviders()[provider]` 改读 `getProviderByName(provider)?.default_model`。
- **DEFAULT_AGENT.provider 类型** 从字面量联合放开为 `string`，值仍 `"anthropic"`。

## 5. workflow 引用 + 迁移

- 引用键不变：`agent.provider: <name>`。种子 name 沿用旧名 → 老 yaml 零改。
- **迁移 047**：① 建表 ② 种子：anthropic→cli/claude、openai→cli/codex、google→cli/gemini（origin=seed，可删；若 config 里写了 mode:api 则种成对应 api 条目，尊重老用户显式选择）③ 导入 config.yaml 现有 compat/自定义 → type=api/subtype=openai-compat（命中 BUILTIN_COMPAT 用预置 base_url，origin=template；其他 origin=user）④ api_keys 有但无条目覆盖的 name 补占位条目（避免孤儿）。
- 迁移内联冻结 BUILTIN_COMPAT_PROVIDERS 数据（不 import agents）。可回退 = DROP TABLE。

## 6. 删除降级（P2，接 run 状态机）

- **软删除**：`providers.delete` 置 `state='deleted'`，不物理删（保留供反查 + 可 undelete + name 不被立即复用）。物理删独立 `providers.purge`（要求无引用 + 已 deleted）。
- **「跑完最后一轮」= 不拦正在跑的 run，只拦新 run 起跑**。三道闸门：
  1. **scheduler**（`requirement-scheduler.scheduleOne` 起跑前）：复核 workflow 引用的 provider 条目，任一 deleted/!enabled → 不起跑 + 回滚 queued→ready + 写 `schedule_error`（主闸门）
  2. **phase 解析**（`resolveProviderForPhase`）：兜底抛「无法使用」→ phase error → run 确定性失败 → 需求 failed（可重试，符合「停下报人」）
  3. **fix-revision-runner**：补建 fix run 前同闸门
- **provider→workflow 反查**：`listWorkflowsUsingProvider(name)` 遍历 registry workflows 的 phase.agent.provider；**注意 DEFAULT_AGENT 隐式引用**——phase 无 agent.provider 时实际用 `anthropic`，删 anthropic 种子会让所有「未显式指定」的 phase 失效 → 反查必须算上 → **anthropic 种子删除给强警告或禁纯删**。新 RPC `providers.usage(name)`。
- **重建同名恢复**：引用按 name 字符串，重建同名 provider → 引用自动复活。在删除确认弹窗 + 工作流失效提示两处告知用户这条退路。

## 7. CLI 本地不支持检测

- **添加 CLI 条目时探测**（复用 `cli-status.ts` 的 Bun.which + --version），结果落条目 `cli_status/cli_version/cli_checked_at`。探测不到 → `cli_status='missing'`，仍允许创建、标「本地不支持」。
- **后台刷新**：`provider-cli-monitor` 改为遍历 DB `type=cli` 条目探测 + 落库 + emit。
- `cli-status.ts` 的 `CLI_SPEC` 从按 name 改按 subtype（claude/codex/gemini→binary）；`detectAllProviders` 硬名单删。
- 「本地不支持」是**持续状态**，走面板顶部 banner / 就地标注，**不进 append-only 通知流**（否则每次启动刷噪音）。

## 8. 产品形态（pm）

- **provider 条目 = {标识 name, 类型 cli|api, 类型专属字段}**。CLI 填「选哪个 CLI」（凭证 CLI 自管，页面只显示 login 提示）；API 填 base_url + 密钥 + 默认模型 + API 形状。
- **模板 = 预填的起点，非特殊种类**：claude-api/openai-api/gemini-api + deepseek/kimi/minimax，一键生成预填条目，用户补密钥；落地后与手搓条目同构。
- **种子必须能直接跑**（装了 CLI 零操作即用），**绝不预置未配置的 API 空壳**。dev 默认工作流引用种子 name（或留空走 DEFAULT_AGENT），新用户不碰 provider 页。
- **两种不可用态严格区分文案**：「本地不支持」=装一下就行（环境，条目还在，编辑器下拉灰态不可选）；「无法使用」=这玩意没了（配置，条目已删，编辑器下拉红色失效态，复用 PhaseAgentEditor 既有「列表外 name」兜底渲染点改成醒目失效态）。
- **删除确认弹窗**回答三问：谁在用它（工作流+phase 清单）/ 正在跑的会怎样（有 in-flight 才显示）/ 能不能恢复（重建同名）。
- **失败可见性**：任务因 provider 不可用失败 → `status_reason` 写清原因 + 区分两种态 + 一键跳转到 provider 编辑 / 工作流编辑。
- **通知**：删除即通知不需要（弹窗已告知）；最后一个 in-flight 终结、工作流正式不可用时记一条收敛通知；「本地不支持」走 banner 不进通知流。

## 9. 分期

### P1 — 条目化骨架（独立可交付 + dogfood）
数据模型 + 迁移种子/导入；解析链 name 枚举 → (type, subtype)；条目 CRUD RPC + CLI/Web 增删；CLI 添加时探测 + monitor 落库；模板一键添加；提供商页重构（单类型条目列表）；工作流编辑器下拉读新列表 + 本地不支持灰态；CLI `autopilot provider list/add/remove`；失败可见性区分两态。**删除 = 硬删 + 「有引用拒删」简单守卫**（复杂降级留 P2）。

P1 影响文件（architect 清单）：`migrations/047`、`core/db.ts`、`core/providers.ts`(新)、`core/provider-defaults.ts`、`core/config.ts`(deprecated 标记)、`core/agent-defaults.ts`、`agents/registry.ts`、`agents/providers/api/compat.ts`、`agents/cli-status.ts`、`agents/types.ts`、`daemon/provider-cli-monitor.ts`、`daemon/rpc-methods.ts`、`cli/config-fix.ts`、`cli/index.ts`、`web/src/hooks/useApi.ts`、`web 提供商页`、`tests/providers-entries.test.ts`(新)。

P1 回归风险：解析链是热路径（每 phase 起 agent 都过）→ 必须有「种子条目命中=老行为」回归测试；迁移导入错=老用户配置丢→覆盖 mode:api/自定义 compat/有 key 无 config 三场景；listExtended 的 Web shape 变了→提供商页同 PR 改。

### P2 — 删除降级接 run 状态机
硬删→软删（state）；三道闸门（scheduler/agentForPhase/fix-runner）；`providers.usage` 反查 + Web/CLI「无法使用」标记 + 删除前确认弹窗；最后一轮终结的收敛通知；重建同名恢复提示；自定义 CLI binary 作执行 provider；TUI 观察镜像。

P2 回归风险：误把「跑完最后一轮」拦成立即中断（闸门只在起新 run 处生效，不碰 running run 的 Agent 缓存）；DEFAULT_AGENT 隐式引用导致删 anthropic 全线崩（usage 反查算上无 provider 的 phase + 种子强保护）。

### 不做（YAGNI）
provider 健康实时轮询扩展；provider 分组/标签/排序（平铺即可，种子在前）。

## 10. 待实现时复核
- 迁移号取当时最大 +1（防撞号，本文档暂记 047）
- single-writer-invariant 测试：providers 表写 SQL 只在 db.ts 白名单
- dev workflow 副本：种子 name 保旧名 → 理论零 sync，但 P1 落地后跑一遍确认老副本引用不断
