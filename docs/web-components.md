# autopilot Web 场景组件体系（Pro 层）与使用规范

> 给谁看：未来改 Web UI 的人和 AI coder。
> 核心思想：像 antd ProComponents 一样，在 shadcn 基础件之上沉淀一层**场景级模板**——页面只提供数据和行为，长相只此一份。
> 视觉前提：claude.ai 质感（token 在 `src/web/src/index.css`），Supabase 控制台骨架。蓝图风已废弃，勿回潮。

## 0. 落地状态

| 批次 | 内容 | 状态 |
|---|---|---|
| 第一批（2026-06-12） | barrel 入口 `components/pro/`、EmptyState、DescList、FormField + 代表点迁移 | ✅ 已落地 |
| 第二批 | PageShell、DetailHeader、FormDialog、ErrorState、SectionCard、SkeletonRows（涉及全部页面/详情页迁移，单独立项） | 📋 已登记待落地 |

## 1. 分层模型

```
L3  pages/                 页面 = 数据获取 + 路由 + 组装 L2
     │  只做：调 RPC、useState/useEffect、把数据喂给 L2 槽位
     │  禁做：手写 L2 已覆盖的模式（页头/空态/详情头/键值列表/max-w）
     ▼
L2  components/pro/        场景模板（本文档主角，antd Pro 等价层）
     │  ├─ L2a 通用模板：PageShell / PageHero / EntityGrid / DetailHeader
     │  │        EmptyState / DescList / FormDialog … 不认识任何业务实体，
     │  │        纯槽位（slots）+ 受控 props，不发请求、不 useNavigate
     │  │        ★ 纯逻辑伴生层在 lib/（status-style / requirement-card /
     │  │          pipeline-time / run-view-logic）—— 可单测、组件保持薄
     │  └─ L2b 业务复合件：RequirementRow / TaskRow / NotificationsPanel /
     │           TaskRunView / PhaseEditor … 绑定领域实体，可调 api、可导航，
     │           内部必须由 L2a + L1 组装，留在 components/ 根目录
     ▼
L1  components/ui/         shadcn 风基础件（button/dialog/card/…）
     │  无业务语义、无布局决策；样式只引用 L0 token；基本不改，改 = 全站震动
     ▼
L0  index.css + tailwind   设计 token：颜色(bg-background/accent/success/…)、
                           圆角、阴影、字体、bp-label 等 utility
                           ★ 颜色/字体只能在这层新增，上层只能引用语义名
```

**每层一句话职责**：L0 定义"长什么样的原子"，L1 定义"控件"，L2a 定义"这个产品反复出现的版式"，L2b 定义"这个实体在 UI 里的标准形态"，L3 只回答"这一页放哪些东西、数据从哪来"。

**判断一个新组件归哪层**：要 props 里出现 `Requirement`/`Task` 类型 → L2b；只出现 `title/items/actions` 这类中性槽位 → L2a；连槽位都没有、只是个控件 → 不该自己写，去 L1 找。

### 归位策略：barrel re-export，不搬文件

`src/web/src/components/pro/index.ts` 是 L2a 的**唯一规范导入面**：

- **存量散件不搬家**，barrel 里 re-export（PageHero、EntityCards 套件、PipelineList 的通用半边、ConfirmDialog、PageLoader、StatusBadge、StepBar、useToast）。git blame / 现有 import 全不受扰。
- **新增 L2a 物理文件直接放 `pro/` 目录**，并在 barrel 导出。
- **新代码一律 `import { … } from "@/components/pro"`**；存量旧路径 import 走 touch-and-fix（下次改到顺手换），不专项大迁移。
- barrel 必须保持无副作用（只有 re-export 语句）。
- PipelineList.tsx 里 L2a（TimeGroupedList/RowCard）与 L2b（RequirementRow/TaskRow）同居一文件——暂不拆，barrel 只导出通用半边；将来该文件大改时顺势拆。

为什么不搬文件：项目演进快，import 路径稳定性比目录洁癖值钱。barrel 给逻辑归位，物理归位靠新陈代谢。

## 2. L2 组件清单

### 2.1 已有 → 保留 / 归位

| 组件 | 现路径 | 处置 | 备注 |
|---|---|---|---|
| `PageHero` | components/PageHero.tsx | 保留，barrel 收编 | 唯一合法 `<h1>` 来源之一；后续被 PageShell 组合 |
| `EntityGrid/EntityList/ViewToggle/useViewMode` | EntityCards.tsx | 保留，barrel 收编 | 实体目录标准件；待补 `empty`/`skeleton` 槽（见 §4） |
| `TimeGroupedList/RowCard/TONE` | PipelineList.tsx | 保留，barrel 只导出通用半边 | `taskMeta/reqMeta` 属状态→视觉映射，与 lib/status-style.ts 职责重叠，待收口一处 |
| `RequirementRow/TaskRow/ReqCardExtras` | PipelineList.tsx | 保留为 L2b | 不进 barrel |
| `ConfirmDialog` | Modal.tsx | 保留，barrel 收编 | 确认类交互唯一入口（含 busy + confirmWord 高危确认） |
| `Toast(useToast)` / `PageLoader` / `StatusBadge` / `StepBar` | 各自文件 | 保留，barrel 收编 | PageLoader 仅作路由级 fallback，区块级加载将改用骨架 |
| `MarkdownView/CodeViewer/LogTimeline/StageRail/Term` | 各自文件 | 保留为领域展示件（L2b） | 不进 barrel |
| `PAGE_W/PAGE_W_FORM/PAGE_W_FOCUS` | lib/layout.ts | 保留 | 被 PageShell 吸收为 `width` 档位后，页面不再直接引用 |
| ~~`Badge.tsx`（components 根）~~ | — | **已删除**（2026-06-12） | 全仓零引用的蓝图期死文件，与 ui/badge.tsx 重名易误导 |

### 2.2 缺口 → 补（按重复度定优先级）

P0 = 现在就有 3+ 处手写重复；P1 = 重复达标但收益次之；P2 = **明令暂不抽**。

| 优先级 | 组件 | 职责（一句话） | 关键槽位 | 状态 |
|---|---|---|---|---|
| **P0** | `EmptyState` | 空态卡 = 图标 + 一句话 + 引导动作（空态必须告诉用户"下一步做什么"） | `icon?`；`title`；`hint?`；`action?`；`size: "page"\|"section"\|"inline"` | ✅ 第一批 |
| **P0** | `DescList` | 键值描述列表（详情页 meta 的唯一形态） | `items: Array<{label, value, mono?}>`；`columns?: 1\|2\|3\|4`；`dense?` | ✅ 第一批 |
| **P0** | `FormField` | 表单行排版件 = Label + 控件 + hint + 错误（纯排版，不做受控/校验框架） | `label`；`required?`；`hint?`；`error?`；`htmlFor?`；`children` | ✅ 第一批 |
| **P0** | `PageShell` | 页面容器 = 宽度档位 + 可选 PageHero + 页级状态闸门（error > loading > children） | `width: "content"\|"form"\|"focus"`；`hero?`；`loading?`；`error?: {message, onRetry?}` | 📋 第二批 |
| **P0** | `DetailHeader` | 实体详情页头 = 返回链接 + 标题 + mono 标识符 + 状态徽章 + 操作区（`identifier` 槽是「业务标签叠加内核名」的结构化落点） | `back: {to, label}`；`title`；`identifier?`；`status?`；`actions?` | 📋 第二批 |
| **P1** | `FormDialog` | 表单对话框骨架 = 标题 + 字段区 + 内联错误条 + busy footer（⚠ 只抽骨架，不做 schema 驱动 ProForm——本项目表单少而浅，schema 层是负资产） | `open/onOpenChange`；`title`；`busy?`；`error?`；`onSubmit`；`danger?` | 📋 第二批 |
| **P1** | `ErrorState` | 错误态卡 = 为什么（业务话）+ 内核错误原文（mono 折叠）+ 重试出口 | `title`；`detail?`；`onRetry?`；`size` | 📋 第二批 |
| **P1** | `SectionCard` | 详情页节卡片 = Card + 节标题行 + 右侧操作 + 可选折叠 | `title`；`actions?`；`collapsible?` | 📋 第二批 |
| **P1** | `SkeletonRows` | 区块级加载骨架，替代区块内裸 spinner | `count?`；`variant: "row"\|"card"` | 📋 第二批 |
| **P2 暂不抽** | ProTable 等价物 | 项目几乎无真表格场景 | — | — |
| **P2 暂不抽** | schema 驱动表单 / StatGroup / 通用 Drawer 模板 | 重复 < 3 处；谁想抽，先按 §3 流程交三处重复证据 | — | — |

## 3. 使用规范（条文）

**必须（MUST）**

1. 新页面容器必须用 `PageShell`（落地前过渡期：必须用 `lib/layout.ts` 三档常量）。
2. 页面级标题必须 `PageHero`；实体详情页头必须 `DetailHeader`（落地后）。
3. 列表/区块为空必须 `EmptyState`，且 `action` 槽非装饰——能给下一步动作的必须给。
4. 键值元数据展示必须 `DescList`；表单行必须 `FormField`；业务表单弹窗必须 `FormDialog` 骨架（落地后）。
5. 一切确认必须 `ConfirmDialog`；不可逆操作 `danger`；不可逆且高代价必须 `confirmWord`。
6. L2a 新组件物理文件放 `components/pro/`，经 barrel 导出；新代码只从 `@/components/pro` 导入 L2a。

**禁止（MUST NOT）**

1. 页面内手写 `max-w-*xl` 容器（唯一合法定义点 = lib/layout.ts）。
2. 页面内手写 `<h1>` 或自拼"ArrowLeft + 返回"页头。
3. 手写空态 div / 手写 Label+Input 裸拼 / 手写 DialogFooter busy 逻辑。
4. 新增彩色左边条、新增颜色/字体、蓝图风元素（rounded-none / 大写压缩标题 / font-display 标题）回潮。
5. L2a 组件内发请求、`useNavigate`、import 业务类型——业务绑定下放 L2b 或 L3。
6. 跳过 L2 直接拿 L1 拼"已有模板覆盖的场景"——发现即重构回模板。

**新增 L2 组件流程（防过度抽象）**

1. 提交三处重复证据（文件:行号，grep 可复现），证明结构同构而非碰巧相似；
2. 在本文档 §2.2 登记一行（职责一句话 + 槽位）；
3. 实现进 `components/pro/` + barrel；三个原手写点同 PR 内迁移（不留"新组件无人用"的尸体）。

**退役**：组件使用方降到 1 时，降级内联回该页面并从 barrel 移除，本文档划掉。

## 4. 状态完整性合格线（L2 内建状态槽）

| 组件类 | 必须内建 | 说明 |
|---|---|---|
| `PageShell` | error > loading > children 三态闸门 | error 渲染 ErrorState（含 detail + onRetry）；不允许页面自己 if/else 三连 |
| 列表模板（EntityGrid/EntityList/TimeGroupedList） | `empty?` + `skeleton?` 槽 | 数据 `undefined`（加载中→骨架）与 `[]`（确实为空→empty 槽）必须区分 |
| `FormDialog` | busy（禁双提交）、内联 error 条、成功 = 关闭 + toast | 表单错误必须内联展示，toast 只作成功回执 |
| 一切 async 按钮 | busy 态 | 无 busy 态的 async onClick 不合格 |
| 实时类（行卡/详情） | 数据过时降级 | WS 断连有 DaemonOfflineBanner 兜底，但不得把断连渲染成"空" |

**四态自检口诀**（review 任何 L2/L3 PR 时过一遍）：空有引导、载有骨架、错有原因和出口、成有反馈和下一步。

## 5. 防漂移 grep 清单（review 时跑）

```bash
# 1. 页面手写宽度 —— 应 0 命中
rg "max-w-(2|4|5|6|7)xl" src/web/src/pages

# 2. 手写 h1 —— 只允许 PageHero / pro/
rg "<h1" src/web/src --glob '!**/PageHero.tsx' --glob '!**/pro/**'

# 3. 手写返回头 —— DetailHeader 落地后 pages 内应 0
rg "ArrowLeft" src/web/src/pages

# 4. 手写空态样式特征 —— 应 0（统一走 EmptyState）
rg "py-10 text-center" src/web/src/pages

# 5. 业务 dialog 手写 footer —— FormDialog 落地后业务文件应 0
rg "DialogFooter" src/web/src --glob '!**/ui/**' --glob '!**/pro/**' --glob '!**/Modal.tsx'

# 6. 彩色左条红线（CLAUDE.md 既有禁令）—— 必须 0
rg "border-l-(accent|warning|destructive|success|info)" src/web/src

# 7. 蓝图风回潮 —— 必须 0（utility 类名 bp-label 是历史命名、样式已新风格化，不算违规）
rg "rounded-none|font-display" src/web/src/pages

# 8. L2a 旧路径直连 —— 新代码应 0（存量豁免走 touch-and-fix）
rg "from \"@/components/(PageHero|EntityCards)\"" src/web/src
```

命中即漂移；豁免需在命中行加注释 `// pro-exempt: <理由>` 并在 review 里说明。
