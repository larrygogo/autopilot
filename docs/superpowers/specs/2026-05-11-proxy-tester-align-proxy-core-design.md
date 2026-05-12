# proxy-tester 内核全面对齐 reverse-bot-rs proxy-core 设计文档

**日期**：2026-05-11  
**状态**：设计已批准，待实现  
**涉及模块**：Rust 后端 (Tauri)、Web 前端 (React)  
**设计方法**：Brainstorming skill 生成、用户确认四个设计阶段

---

## 1. 背景与目标

### 当前状态

proxy-tester 本地已是"半接入"状态：
- `src-tauri/src/commands.rs` 中 `test_proxy` / `test_scenario` / `get_test_scenarios` 已走 `proxy-core`
- **但两个 scenario 仍 fallback 到本地 `websites/`**：
  1. **imap** — proxy-core 的 websites 列表中根本不存在 imap 实现
  2. **interpark_global_queue** — proxy-core 的 `test_scenario(...)` 签名多了 `extra_params: Option<Value>` 参数，但本地调用**未透传 params**，导致需要参数（product_id）的场景跑不了

- 本地 `src-tauri/src/websites/` 下 22 个文件中，只有 `imap.rs` 被实际引用；`global_interpark.rs` 也被引用但其功能已由 proxy-core 的 `to_create_session` 提供（自动从 `extra_params["product_id"]` 提取），其余 20 个是完全的死代码（与 proxy-core 的版本重复）

- 前端与后端之间的"参数传递"存在映射缺失（`sku` ↔ `product_id`），`scenario-selector` 中写死了 `SETTING_MODES = ["interpark_global_queue"]`

### 目标

**完整对齐 proxy-core 的内核，支持任意带参数的 scenario**：

1. 升级依赖到 proxy-core master HEAD（包含 `extra_params` 扩展）
2. `test_scenario` 变成纯透传：将 `params` 直接作为 `extra_params` 传给 proxy-core
3. 删除 20 个 dead-code 文件（含 `global_interpark.rs`），保留 imap 作为单独的 Tauri 命令 `test_imap`
4. 前端 scenario-selector 动态化：根据 `get_test_scenarios()` 返回的 `extra_params_schema` 动态生成参数表单（替换硬编码的 `SETTING_MODES` 和 `interpark_global_queue` 特例）
5. rename 前端老 key `interpark_global_queue` → `to_create_session`，参数 `sku` → `product_id`（与 proxy-core 对齐）
6. 提供 localStorage 迁移路径，确保老用户数据不丢失

**最终形态**：新的 scenario（如 `cotai_ticket`、`ibon_tw`）自动出现在 UI 中，无需改代码。

---

## 2. 架构设计

### 2.1 依赖升级

**改动文件**：`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock`

升级三个 git 依赖从锁定的旧 commit (`486b276`) 到 master HEAD (`a85566`)：

```toml
func-meta       = { git = "...", branch = "master" }
test-func-macro = { git = "...", branch = "master" }
proxy-core      = { git = "...", branch = "master" }
```

执行 `cargo update -p proxy-core -p func-meta -p test-func-macro` 推进锁文件。

**升级后效果**：
- `proxy_core::test_scenario` 新增 `extra_params: Option<serde_json::Value>` 参数
- 新 scenario 自动可见：`cotai_ticket`、`ibon_tw`、`query_itp_index`、`query_itp_queue`
- `to_create_session` 通过 macro 自动从 `extra_params["product_id"]` 提取，无需本地代码处理
- `get_all_modules()` / `get_test_scenarios()` 新增这些 scenario 的元信息（含 `extra_params_schema`）

---

### 2.2 后端改造（Rust / Tauri）

#### 2.2.1 `commands.rs::test_scenario` 透传化

```rust
#[tauri::command]
pub async fn test_scenario(
    scenario: String,
    proxy: String,
    username: Option<String>,
    password: Option<String>,
    socks5: bool,
    timeout: Option<u64>,
    params: Option<Value>,  // <- 新增，作为 extra_params 直接透传
) -> TestResult {
    proxy_core_test_scenario(
        scenario, proxy, username, password, socks5,
        Some(timeout.unwrap_or(30)),
        params,  // 直接透传 extra_params
    )
    .await
}
```

**关键点**：
- 完全删除 `match scenario { ... }` 分支逻辑
- 删除 `use crate::websites::{global_interpark, imap};` 这行

#### 2.2.2 新增 `test_imap` Tauri 命令

```rust
#[tauri::command]
pub async fn test_imap(
    proxy: String,
    username: Option<String>,
    password: Option<String>,
    socks5: bool,
    domain: String,
    port: u16,
    timeout: Option<u64>,
) -> TestResult {
    imap::test_imap_with_domain(
        proxy, username, password, socks5,
        domain, port, timeout.unwrap_or(30),
    ).await
}
```

**目的**：将 IMAP（非 scenario 模式）作为独立命令暴露，前端直接调 `invoke("test_imap", ...)` 而不是滥用 `invoke("test_scenario", ...)` 的 match 分支。

#### 2.2.3 `main.rs` 更新

```rust
.invoke_handler(tauri::generate_handler![
    test_proxy,
    test_scenario,
    test_imap,              // <- 新增
    test_proxy_geolocation,
    test_proxy_dynamic_residential,
    cancel_dynamic_residential,
    get_test_scenarios,
    // ... 其它保持不变
])
```

**测试代码修复**：
```rust
#[cfg(test)]
mod test {
    #[tokio::test]
    async fn test_run_test_nike() {
        let res = test_scenario(
            "nike_web".to_string(),
            "192.168.0.111:7000".to_string(),
            Some("...".into()),
            Some("...".into()),
            false,
            None,
            None,  // <- 新增 params 参数
        ).await;
    }
}
```

#### 2.2.4 清理 dead-code

**删除文件**（`src-tauri/src/websites/` 下）：
```
all_ticket.rs, axs.rs, book_my_show.rs, cashier_waffo.rs, city_line.rs,
galaxy_ticketing.rs, global_interpark.rs, global_melon.rs, hkticketing.rs,
kktix.rs, melon_kr.rs, nike.rs, thai_ticket_major.rs, ticket_au.rs,
ticket_link.rs, ticket_master.rs, ticket_master_au.rs, ticket_master_sg.rs,
ticket_master_uk.rs, ticket_yes24.rs, tixcraft.rs
```

**保留文件**：
- `imap.rs` — 底层 IMAP 实现
- `mod.rs` — 仅包含 `pub mod imap;`

---

### 2.3 前端改造（React）

#### 2.3.1 `lib/invoke.ts` 清扫与新增

**删除行**：第 76–228 行所有 per-scenario 的独立 invoke 函数（如 `testNikeWebInvoke`、`testMelonGlobalIndexInvoke` 等）。这些都已被 `testScenarioInvoke` 取代，是历史死代码。

**新增**：
```ts
export function testImapInvoke(
  args: TestInvokeArgs<{ domain: string; port: number }>,
): Promise<TestResult> {
  return invoke("test_imap", args)
}
```

#### 2.3.2 `types/proxyTaskTypes.ts` — TaskMode 类型泛化

```ts
export type TaskMode = string

export const SPECIAL_MODES = {
  DYNAMIC_RESIDENTIAL: "dynamic_residential",
  GEOLOCATION: "geolocation",
  IMAP_PREFIX: "imap_",  // 前缀识别，下同
} as const

export type TestScenario = {
  name: string
  en_name: string
  key: string
  extra_params_schema: string  // 新增：JSON Schema 描述参数
}
```

**为什么删除硬编码的 TaskMode 联合类型**：
- proxy-core 动态注册 scenario，前端硬编码会漏掉新增的（如 `cotai_ticket`）
- 硬编码失效的代价高于泛化的学习成本

#### 2.3.3 `lib/jotai.ts` — 参数存储与迁移

```ts
export const modeSettingsAtom = atomWithStorage<{
  [key: string]: Record<string, unknown>
}>("task.modeSettings", {})

// 迁移代码（在 ProxyTaskContext 或 App.tsx 挂载时执行）
useEffect(() => {
  const raw = localStorage.getItem("task.modeSettings")
  if (!raw) return
  try {
    const obj = JSON.parse(raw)
    const old = obj.test_interpark_global_queue
    if (old && old.sku && !obj.to_create_session) {
      obj.to_create_session = { product_id: old.sku }
      delete obj.test_interpark_global_queue
      localStorage.setItem("task.modeSettings", JSON.stringify(obj))
    }
  } catch (e) {
    // 迁移失败，保留原值，不阻塞应用
    console.error("modeSettings migration failed:", e)
  }
}, [])
```

#### 2.3.4 `context/ProxyTaskContext.tsx` — IMAP 调用重定向

删除第 188–196 行的 `if (mode.startsWith("imap_")) { payload.params = { ... } }` 构造段。

修改第 372 行：
```ts
if (mode.startsWith("imap_")) {
  const domain = mode.replace("imap_", "")
  const domainConfig = configForDomain(domain)  // 已有
  return testImapInvoke({
    ...config,  // proxy/username/password/socks5
    domain,
    port: domainConfig?.port || 993,
  })
}
```

#### 2.3.5 `scenario-selector.tsx` — 动态参数化

**删除**：
```ts
const SETTING_MODES = ["interpark_global_queue"]
```

**新增通用组件** `<SettingScenario scenario={scenario} />`：

```tsx
function SettingScenario({ scenario }: { scenario: TestScenario }) {
  const [modeSettings, setModeSettings] = useAtom(modeSettingsAtom)
  const fields = useMemo(
    () => parseExtraParamsSchema(scenario.extra_params_schema),
    [scenario.extra_params_schema],
  )
  const settings = modeSettings[scenario.key] ?? {}

  return (
    <div className="flex flex-col gap-4 text-sm">
      <div className="text-sm font-bold">
        <Trans i18nKey={`scenarios:${scenario.key}`} />
      </div>
      {fields.map((f) => (
        <div key={f.name}>
          <Label>
            {f.name}
            {f.required && " *"}
          </Label>
          <Input
            value={(settings[f.name] as string) ?? f.default ?? ""}
            onChange={(e) =>
              setModeSettings((prev) => ({
                ...prev,
                [scenario.key]: { ...settings, [f.name]: e.target.value },
              }))
            }
          />
        </div>
      ))}
    </div>
  )
}

function parseExtraParamsSchema(schema: string): ParamField[] {
  if (!schema || schema === "{}") return []
  const obj = JSON.parse(schema) as Record<string, {
    type: string
    required: boolean | string
    default: string
  }>
  return Object.entries(obj).map(([name, def]) => ({
    name,
    type: def.type,
    required: def.required === true || def.required === "true",
    default: def.default === "null" ? undefined : def.default,
  }))
}

type ParamField = {
  name: string
  type: string
  required: boolean
  default?: string
}
```

**改动主体逻辑**：
- 齿轮图标显示的条件从硬编码的 `SETTING_MODES.includes(scenario)` 改为 `scenario.extra_params_schema !== "{}"`
- 点击齿轮弹出的参数面板从固定的 `<SettingInterparkQueue />` 改为 `<SettingScenario scenario={selected} />`

**备注**：
- 仅渲染 `String` 类型字段做最小可行实现
- 其他 type（`u16`、`i64`）将来按需扩展
- 当前 proxy-core 中仅 `to_create_session` 用到参数，字段为 `product_id: String(required)`，完全覆盖

#### 2.3.6 i18n 文件更新

**`locales/scenarios/zh.json`**：
```json
{
  "to_create_session": "Interpark 创建排队 Session",
  "...": "..."
}
```
删除或注释掉 `"interpark_global_queue"` 行（如果存在）。

**`locales/scenarios/en.json`**：
```json
{
  "to_create_session": "Interpark Create Queue Session",
  "...": "..."
}
```

**`locales/zh.json`**、**`locales/en.json`** 中的通用文案（如 task dialog 相关）：
- 如果 `interpark-queue-task-dialog.tsx` 已被删除，相关 i18n key 也可移除
- 否则改文案为通用描述（避免特定术语）

#### 2.3.7 清理无用 UI 组件

**`interpark-queue-task-dialog.tsx`**：grep 检查后如果没有被任何地方 import，直接删除。

---

### 2.4 数据流

```
用户点击"参数设置"（齿轮）
  ↓
ProxyTaskContext 读取当前 scenario
  ↓
if (scenario.extra_params_schema !== "{}")
  → 弹出通用 <SettingScenario />，动态渲染字段
  → 用户填值，存入 jotai modeSettingsAtom（persist to localStorage）
  ↓
用户启动任务
  ↓
ProxyTaskContext.test() 读 modeSettings[scenario.key]，组装 payload
  ↓
invoke("test_scenario", {
  scenario: "to_create_session",
  ...,
  params: { product_id: "24004632" }  // <- 直接透传
})
  ↓
Tauri 后端 commands::test_scenario()
  ↓
proxy_core::test_scenario(..., params)  // <- 透传 extra_params
  ↓
proxy-core 的 macro 自动从 params["product_id"] 提取，调用对应的 handler
  ↓
TestResult 返回前端
```

---

## 3. 测试与验收

### 3.1 单元测试

**Rust**：
- `main.rs` 的 `#[cfg(test)] mod test` 中既有的 `test_run_proxy_test` / `test_run_test_nike` 等修补签名（补 `None` 透传 extra_params）后保留
- 新增 `test_to_create_session_with_params`：验证 extra_params 透传链路
- 新增 `test_imap_command`：验证拆分后命令可用（标 `#[ignore]`，需真实代理）

**TypeScript**：
- `lib/invoke.ts` 的导出函数做类型检查（`pnpm tsc --noEmit`）
- localStorage 迁移逻辑包裹在 try/catch 中（可单独测试或在 storybook 中验证）

### 3.2 手动验收清单

1. 启动 app，打开 Scenario Selector，列表包含 `to_create_session`、`cotai_ticket`、`ibon_tw` 等新增项
2. 在 `to_create_session` 行点齿轮，弹出参数面板，显示 `product_id` 输入框，能正常编辑并 persist
3. 跑一次 `to_create_session` 任务（输入合法 product_id），结果正常返回（OK/BAN/TIMEOUT 等已知态之一）
4. IMAP 任务：选 IMAP mode → 任务跑 → 结果与改造前一致
5. **老用户 localStorage 迁移**：手工注入 `{"task.modeSettings": {"test_interpark_global_queue": {"sku": "24004632"}}}`，重启应用后自动迁移为 `{"to_create_session": {"product_id": "24004632"}}`，齿轮面板显示迁移后的值
6. 无回归：test_proxy、test_geolocation、dynamic_residential、db 操作等全部可用

### 3.3 验收门槛（Done 定义）

- `cargo build` ✓
- `cargo clippy --all-targets -- -D warnings` ✓
- `cargo test` 全绿（除 `#[ignore]` 的真实代理测试）
- `pnpm tsc --noEmit` ✓
- `pnpm lint` ✓
- 手动清单 1–6 全通

---

## 4. 不在本次范围内（明确边界）

- `dynamic_residential.rs` 的内核重构（仍用 reqwest 自建调用）
- `error_logger.rs` 的逻辑
- proxy-core 端任何代码改动
- IMAP 在 reverse-bot-rs 上游的实现（保留本地专有）
- 新建"批量任务"或"数据分析"的 scenario UI（仅覆盖 scenario-selector 内动态表单）

---

## 5. 提交策略

建议拆 3 个 commit：

1. **`chore(deps): 升级 proxy-core/func-meta/test-func-macro 到 master HEAD`**
   - 改 Cargo.toml 与 Cargo.lock
   - 运行 `cargo build` 验证兼容

2. **`refactor(tauri): test_scenario 透传 extra_params；imap 拆出 test_imap；删除 dead-code`**
   - 修改 commands.rs / main.rs
   - 删除 21 个 websites/*.rs 文件
   - 更新 websites/mod.rs

3. **`refactor(web): scenario-selector 动态参数化；rename interpark_global_queue；清理 dead code；localStorage 迁移`**
   - lib/invoke.ts / types/proxyTaskTypes.ts / lib/jotai.ts / scenario-selector.tsx / i18n 文件 / ProxyTaskContext.tsx 修改
   - 删除 interpark-queue-task-dialog.tsx（如果无引用）

**PR 标题**：`refactor: proxy-tester 内核全面对齐 reverse-bot-rs proxy-core`

---

## 6. 附录：接口签名对照

### proxy_core 升级前后

| 函数 | 升级前（旧） | 升级后（新） |
|------|-------------|----------|
| `test_scenario` | `test_scenario(scenario, proxy, username, password, socks5, timeout)` | `test_scenario(..., timeout, extra_params)` |
| `get_test_scenarios` | 返回不含 `extra_params_schema` | 返回含 `extra_params_schema` |

### Scenario Key 映射

| 老 key | 新 key | 参数变化 |
|--------|--------|---------|
| `interpark_global_queue` | `to_create_session` | `sku` → `product_id` |
| `imap` | （改为独立 `test_imap` 命令） | — |

### localStorage 迁移

```javascript
// 迁移前（旧用户）
{
  "task.modeSettings": {
    "test_interpark_global_queue": { "sku": "24004632" }
  }
}

// 迁移后（自动）
{
  "task.modeSettings": {
    "to_create_session": { "product_id": "24004632" }
  }
}
```

---

**版本历史**

| 版本 | 日期 | 变更 |
|------|------|------|
| 1.0 | 2026-05-11 | 初稿，待审批 |
