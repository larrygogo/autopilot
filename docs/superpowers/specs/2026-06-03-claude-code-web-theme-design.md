# Web 主题换风：蓝图风 → Claude Code（claude.ai 质感）设计

> 日期：2026-06-03
> 范围：`src/web/`（Web UI），不动 daemon / core / TUI / CLI
> 状态：设计待评审

## 1. 目标与动机

把 Web UI 当前的「蓝图工程图纸」强风格，彻底换成 **claude.ai 网页质感**：暖象牙奶油底 + 珊瑚橘（Claude 橘 `#D97757`）强调色、圆角、柔和投影、克制留白、去大写。明暗两套同等精打磨。

这不是改几个颜色变量——蓝图 DNA（全直角、硬阴影、大写压缩体标题、网格底纹、HUD 切角）深植在三层里，必须分层拆解，否则出来是「Claude 配色的蓝图」，方向拧巴。

**符合产品定位**：Web 是「决策时刻」的一等公民可视化决策台。换成更柔和、低视觉噪音的 claude 质感，降低盯屏疲劳，但不触碰内核命名与语义（纯客户端层视觉改造，零协议/数据变更）。

## 2. 非目标（YAGNI）

- ❌ 不重建组件库 API（保持 shadcn + cva 结构，只改 className）
- ❌ 不动 daemon / core / agents / WS 协议 / 数据模型
- ❌ 不改 TUI（ink 终端 UI 独立，不在本次范围）
- ❌ 不新增「多主题切换器」（仍是 light/dark/system 三态，只换这一套皮）
- ❌ 不做响应式 / 布局重构（只换视觉皮肤，结构不动）

## 3. 视觉规范（Design Tokens）

### 3.1 配色（oklch，沿用项目现有格式）

**浅色（象牙奶油 + 珊瑚橘，主力之一）**

| Token | 值 | 说明 |
|---|---|---|
| `--background` | `oklch(0.97 0.008 90)` | 暖象牙白 ≈ `#FAF9F5` |
| `--foreground` | `oklch(0.27 0.006 60)` | 暖近黑 ≈ `#3D3D3A`（非纯黑） |
| `--card` | `oklch(0.99 0.005 90)` | 比底色略亮的纯奶油 |
| `--card-foreground` | `oklch(0.27 0.006 60)` | 同 foreground |
| `--popover` | `oklch(0.99 0.005 90)` | 同 card |
| `--popover-foreground` | `oklch(0.27 0.006 60)` | |
| `--primary` | `oklch(0.64 0.13 42)` | **Claude 珊瑚橘 ≈ `#D97757`** |
| `--primary-foreground` | `oklch(0.99 0.005 90)` | 橘底上的奶油白字 |
| `--secondary` | `oklch(0.94 0.008 85)` | 暖浅米灰（次级按钮/标签底） |
| `--secondary-foreground` | `oklch(0.27 0.006 60)` | |
| `--muted` | `oklch(0.94 0.008 85)` | 同 secondary（弱化区底） |
| `--muted-foreground` | `oklch(0.27 0.006 60 / 0.55)` | 次要文字 |
| `--accent` | `oklch(0.64 0.13 42)` | 与 primary 同橘（强调一致） |
| `--accent-foreground` | `oklch(0.99 0.005 90)` | |
| `--destructive` | `oklch(0.55 0.18 27)` | 暖红（错误/删除） |
| `--destructive-foreground` | `oklch(0.99 0.005 90)` | |
| `--success` | `oklch(0.55 0.10 150)` | 柔和绿 |
| `--success-foreground` | `oklch(0.99 0.005 90)` | |
| `--warning` | `oklch(0.70 0.13 70)` | 琥珀 |
| `--warning-foreground` | `oklch(0.27 0.006 60)` | |
| `--info` | `oklch(0.60 0.10 240)` | 柔和蓝 |
| `--info-foreground` | `oklch(0.99 0.005 90)` | |
| `--border` | `oklch(0.27 0.006 60 / 0.12)` | 极淡暖灰描边（低对比） |
| `--input` | `oklch(0.27 0.006 60 / 0.18)` | 输入框描边略重于 border |
| `--ring` | `oklch(0.64 0.13 42 / 0.4)` | 聚焦环=橘 |
| `--sidebar` | `oklch(0.955 0.008 88)` | 侧栏比主底略沉一档 |
| `--sidebar-foreground` | `oklch(0.27 0.006 60)` | |
| `--sidebar-primary` | `oklch(0.64 0.13 42)` | |
| `--sidebar-primary-foreground` | `oklch(0.99 0.005 90)` | |
| `--sidebar-accent` | `oklch(0.94 0.008 85)` | |
| `--sidebar-accent-foreground` | `oklch(0.27 0.006 60)` | |
| `--sidebar-border` | `oklch(0.27 0.006 60 / 0.10)` | |
| `--sidebar-ring` | `oklch(0.64 0.13 42 / 0.4)` | |

**深色（暖炭灰 + 珊瑚橘，主力之一，非纯黑）**

| Token | 值 | 说明 |
|---|---|---|
| `--background` | `oklch(0.20 0.004 60)` | 暖炭灰 ≈ `#262624` |
| `--foreground` | `oklch(0.93 0.005 80)` | 暖白 |
| `--card` | `oklch(0.24 0.004 60)` | 略亮表面 ≈ `#30302E` |
| `--card-foreground` | `oklch(0.93 0.005 80)` | |
| `--popover` | `oklch(0.24 0.004 60)` | |
| `--popover-foreground` | `oklch(0.93 0.005 80)` | |
| `--primary` | `oklch(0.70 0.13 42)` | 珊瑚橘（深色下略提亮保对比） |
| `--primary-foreground` | `oklch(0.20 0.004 60)` | |
| `--secondary` | `oklch(0.28 0.004 60)` | 暖深灰（次级底） |
| `--secondary-foreground` | `oklch(0.93 0.005 80)` | |
| `--muted` | `oklch(0.28 0.004 60)` | |
| `--muted-foreground` | `oklch(0.93 0.005 80 / 0.55)` | |
| `--accent` | `oklch(0.70 0.13 42)` | |
| `--accent-foreground` | `oklch(0.20 0.004 60)` | |
| `--destructive` | `oklch(0.65 0.17 25)` | |
| `--destructive-foreground` | `oklch(0.20 0.004 60)` | |
| `--success` | `oklch(0.70 0.13 150)` | |
| `--success-foreground` | `oklch(0.20 0.004 60)` | |
| `--warning` | `oklch(0.78 0.13 75)` | |
| `--warning-foreground` | `oklch(0.20 0.004 60)` | |
| `--info` | `oklch(0.70 0.10 240)` | |
| `--info-foreground` | `oklch(0.20 0.004 60)` | |
| `--border` | `oklch(0.93 0.005 80 / 0.12)` | 极淡暖描边 |
| `--input` | `oklch(0.93 0.005 80 / 0.18)` | |
| `--ring` | `oklch(0.70 0.13 42 / 0.45)` | |
| `--sidebar` | `oklch(0.18 0.004 60)` | 侧栏比主底更沉 |
| `--sidebar-foreground` | `oklch(0.93 0.005 80)` | |
| `--sidebar-primary` | `oklch(0.70 0.13 42)` | |
| `--sidebar-primary-foreground` | `oklch(0.20 0.004 60)` | |
| `--sidebar-accent` | `oklch(0.28 0.004 60)` | |
| `--sidebar-accent-foreground` | `oklch(0.93 0.005 80)` | |
| `--sidebar-border` | `oklch(0.93 0.005 80 / 0.10)` | |
| `--sidebar-ring` | `oklch(0.70 0.13 42 / 0.45)` | |

> 注：oklch 数值为设计意图基线，实现时在浏览器实地微调对比度（WCAG AA：正文 ≥ 4.5:1，大字/UI ≥ 3:1）。

### 3.2 字体

| 角色 | 字体 | 变更 |
|---|---|---|
| body sans | **Manrope**（保留） | 不变，省 churn |
| mono | **JetBrains Mono**（保留） | 代码 / ID / 文件名 |
| display | **Source Serif 4**（新增，替换 Big Shoulders Display） | 仅 PageHero / 大标题用，呼应 claude.ai 编辑感的暖衬线；**不再大写、不再压缩体** |

- `index.css` 顶部 Google Fonts `@import` 改：去掉 `Big+Shoulders+Display`，加 `Source+Serif+4:ital,opsz,wght@0,8..60,400..600`。
- `--font-display` 从 Big Shoulders 改为 `"Source Serif 4", "Noto Sans SC", serif`。
- **删掉全局 `h1~h6` 的 `text-transform: uppercase` + `font-family: var(--font-display)` 强制规则**。标题默认走 sans + 字重分层；只有显式用 `font-display` 的大标题（PageHero）走衬线。

### 3.3 形 & 投影

| 维度 | 蓝图旧值 | Claude 新值 |
|---|---|---|
| `--radius` | `0px` | `0.5rem`（8px） |
| `--radius-sm` | `0px` | `0.375rem`（6px） |
| `--radius-md` | `0px` | `0.5rem`（8px） |
| `--radius-lg` | `0px` | `0.75rem`（12px） |
| `--radius-xl` | `2px` | `1rem`（16px） |
| 卡片/按钮投影 | 硬阴影 `4px 4px 0 实色` | 柔和 `0 1px 2px rgb(0 0 0 / 0.06), 0 1px 3px rgb(0 0 0 / 0.08)` |
| hover 反馈 | 平移 + 硬阴影出现 | 微提亮底色 / 微抬升投影（无平移） |
| 描边 | `1.5px` 实线高对比 | `1px` 极淡暖灰 |
| 分隔线 | 点划线 dashed | 实线 `1px` 低对比 |
| body 底纹 | 满屏网格线 + 噪点 | **移除**，纯净底色（claude 留白） |
| HUD 切角 | `bp-clip-corner` 三角切口 | 移除，圆角 |

## 4. 三层改造策略

### L1 — `src/web/src/index.css`（中心层，最大杠杆）

1. Google Fonts import：换字体（见 3.2）
2. `@theme inline` 的 `--font-display` 改 Source Serif 4；`--radius-*` 全部改圆角（见 3.3）
3. `:root` / `.dark` 全部 token 替换为 §3.1 两套色板
4. `--radius` 改 `0.5rem`
5. `@layer base`：
   - 删除 body 的 `background-image`（网格 + 噪点）与 `.dark body` 网格
   - 删除 `h1~h6` 的 `font-display + uppercase + 700` 强制规则（改为不设 family、保留合理字重/字距即可，让标题默认 sans）
6. `@layer utilities` 的 `bp-*` 工具类**就地软化**（保留类名，避免动 62 个文件的引用）：
   - `.bp-shadow` / `.bp-shadow-sm`：硬阴影 → 柔和投影
   - `.bp-lift:hover`：去平移，改微抬升柔投影
   - `.bp-grid`：网格底纹 → 空规则（no-op，或极淡单层）
   - `.bp-clip-corner`：切角 clip-path → 移除（改 `border-radius: var(--radius)`）
   - `.bp-divider`：dashed → solid 低对比
   - `.bp-label`：保留 mono 小标签，但**去大写**或保留小字距（claude 的 eyebrow 标签是小写灰字）→ 降到 `letter-spacing: 0.08em`，去 `uppercase`
   - `.bp-num-block`：实色填充方块 → 圆角柔和徽标
   - `.bp-checkbox`：方角 → 圆角（`border-radius: 0.25rem`），描边变淡，选中态橘
   - 滚动条：`border-radius: 0` → 圆角，颜色走新 border token

> 原则：`bp-*` 类名保留作为兼容 alias，但语义从「蓝图装饰」变为「柔和等价物」。注释同步更新，去掉「蓝图风」字样。

### L2 — `src/web/src/components/ui/*`（17 个基础组件）

逐个把内联的蓝图样式换成 Claude 软风。统一规则：
- `rounded-none` → `rounded-md`（或对应 radius）
- `border-[1.5px]` → `border`（1px）
- `font-mono uppercase tracking-[…]` → 去 mono / 去 uppercase / 去重字距（除非该处语义确需 mono，如数据标签）
- hover 硬阴影 `shadow-[3px_3px_0…]` + `translate-x/y-[-1px]` → 柔投影 / 微底色变化
- `border-dashed` → 实线低对比

涉及文件（17）：`button` `card` `badge` `input` `tabs` `dialog` `sheet` `popover` `select` `dropdown-menu` `command` `table` `tooltip` `switch` `label` `separator` `sonner`。

逐组件要点：
- **button**：default 变 `bg-primary text-primary-foreground rounded-md`，hover 微深；outline/ghost/secondary 圆角淡边；去 `font-mono uppercase tracking`，正常 sans；link 保持。size 高度体系（h-9 同高）**保留不动**。
- **card**：`rounded-lg border bg-card` + 柔投影；CardHeader/Footer 分隔 dashed→solid 淡线；**CardTitle 去 `font-display uppercase`**，改 sans 中等字重（大标题场景由调用方显式加 `font-display`）。
- **badge**：圆角 `rounded-full` 或 `rounded-md`，去 mono/uppercase，正常小字；语义色（success/warning/info/accent）保留但底色用更淡的 tint。
- **input / select / dropdown / command / dialog / sheet / popover / tooltip / table / tabs / switch / separator / sonner**：圆角化 + 淡边 + 去 mono/uppercase 残留 + 柔投影。

### L3 — 页面内联残留扫尾

L1+L2 改完后，全站自动变样 80%+。剩余在页面 JSX 里**直接写**了 `font-display` / `uppercase` / `bp-shadow` / `tracking-[…]` 的地方逐一核对清理。按引用密度排优先级：

1. `pages/RequirementDetail.tsx`（34）
2. `pages/TaskDetail.tsx`（17）
3. `pages/Tasks.tsx`（14）
4. `pages/NewWorkflowWithAI.tsx`（12）
5. `pages/ProjectDetail.tsx`（10）、`components/TaskOutcomeCard.tsx`（10）、`components/PhasePipelineEditor.tsx`（10）
6. 其余 ~50 个文件零散 1–9 处，逐个扫

扫尾规则：
- 业务里用 `font-display` 的标题：判断是否真大标题——是→保留（现在是衬线）；否→删，回归 sans
- `uppercase` 业务标签：去大写（claude 不大写），或保留为小字距 eyebrow
- `bp-shadow` 业务卡片：保留（已软化）或按场景换 card 默认柔投影
- 直接 `border-[1.5px]` / `rounded-none`：换 `border` / `rounded-md`

### L4 — PageHero 衬线

`components/PageHero.tsx` 大标题显式用 `font-display`（现 = Source Serif 4），正文/副标题 sans。这是唯一刻意保留衬线的地方，呼应 claude.ai 编辑感。

## 5. 数据流 / 接口影响

无。纯 CSS / className 改造，不动任何组件 props、API、状态、协议。`theme.tsx`（light/dark/system 切换逻辑）**完全不动**——只换它驱动的 `.dark` 下的 token 值。

## 6. 测试与验收

1. `bun run typecheck`：className 改动不应引入类型错误（cva variant 名不变）。
2. `bun run build:web`：构建通过，产物生成。
3. **人工目视双主题双模式走查**（用户自跑的 daemon + 浏览器）：
   - 浅色 / 深色各走一遍主路径：Now / Tasks / TaskDetail / RequirementDetail / Workflows / Settings / 各 Dialog/Sheet/Dropdown/Tooltip/Toast
   - 检查项：圆角一致、无残留硬阴影/网格底纹/全大写标题、橘色强调到位、对比度可读、聚焦环可见、滚动条样式
4. 回归点：状态色（success/warning/info/destructive）在 badge / progress / timeline 上语义仍清晰；危险操作确认按钮（destructive）仍醒目。
5. 无障碍：正文对比 ≥ 4.5:1，UI/大字 ≥ 3:1（实地用浏览器取色核对，oklch 基线可微调）。

## 7. 风险与回滚

- **风险**：L3 扫尾遗漏导致个别页面残留蓝图样式（半拧巴）。缓解：grep `font-display|uppercase|rounded-none|border-\[1.5px\]|shadow-\[.*0_0` 收敛到零（PageHero 的 font-display 除外）。
- **风险**：`bp-*` 软化后某些业务卡片视觉权重变化（原来硬阴影很重）。缓解：走查时重点看 NowCard / TaskOutcomeCard / TaskProgressCard 等核心卡片。
- **回滚**：改动集中在 `index.css` + `ui/*` + 页面 className，纯前端，`git revert` 即可整体回退，无数据/迁移副作用。

## 8. 落地顺序（供实现计划参考）

1. L1 `index.css`（token + 字体 + 去网格 + bp-* 软化）→ 构建看整体基调
2. L2 `ui/*` 17 组件 → 基础控件成型
3. L3 页面扫尾（按密度排序）→ grep 收敛到零
4. L4 PageHero 衬线确认
5. typecheck + build:web + 双主题走查
