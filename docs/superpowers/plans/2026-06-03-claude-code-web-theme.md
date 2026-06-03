# Claude Code Web 主题换风 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 autopilot Web UI 从「蓝图工程图纸」强风格换成 claude.ai 质感（暖象牙奶油底 + 珊瑚橘 `#D97757`、圆角、柔阴影、去大写），明暗两套同等精打磨。

**Architecture:** 三层杠杆改造。L1 改 `index.css`（design token + 字体 + 去网格底纹 + 就地软化 `bp-*` 工具类，保留类名避免动 62 个引用文件）；L2 重写 17 个 `components/ui/*` 基础组件的内联蓝图样式；L3 按引用密度扫尾页面 JSX 里直接写的 `font-display`/`uppercase`/`rounded-none`/硬阴影残留。纯前端 className/CSS 改造，不动 daemon/core/协议/数据，`theme.tsx` 切换逻辑不变。

**Tech Stack:** Tailwind CSS v4（`@theme inline` + oklch token）、Radix UI、shadcn 风格（cva/clsx/tailwind-merge）、lucide-react 图标、Bun 运行时、Vite。

**Spec:** `docs/superpowers/specs/2026-06-03-claude-code-web-theme-design.md`

---

## 验证方式说明（本计划无单元测试）

这是视觉/CSS 改造，没有可断言的单测。每个 Task 的「验证」用三道关卡替代 TDD：

1. `bun run typecheck` — className 改动不引入类型错误
2. `bun run build:web` — 构建通过
3. **grep 收敛 + 人工目视** — 用 grep 证明蓝图残留归零；用户自跑 daemon 浏览器双主题走查

每个 Task 末尾 commit。commit message 用中文。

---

## 文件结构

| 文件 | 职责 | 本次动作 |
|---|---|---|
| `src/web/src/index.css` | 全局 token + 字体 + base 层 + `bp-*` 工具类 | **重写**（L1，最大杠杆） |
| `src/web/src/components/ui/button.tsx` | 按钮 cva | 重写内联样式 |
| `src/web/src/components/ui/card.tsx` | 卡片族 | 重写 |
| `src/web/src/components/ui/badge.tsx` | 徽标 cva | 重写 |
| `src/web/src/components/ui/input.tsx` | Input/Textarea | 重写 |
| `src/web/src/components/ui/tabs.tsx` | Tabs | 重写 |
| `src/web/src/components/ui/{dialog,sheet,popover,select,dropdown-menu,command,table,tooltip,switch,label,separator,sonner}.tsx` | 其余 12 基础组件 | 按规则机械替换 |
| `src/web/src/components/ui/checkbox.tsx` | Checkbox（走 `.bp-checkbox`） | 不动 tsx（L1 已软化 `.bp-checkbox`） |
| `src/web/src/lib/theme.tsx` | light/dark/system 切换 | **不动** |
| `src/web/src/pages/*` + `src/web/src/components/*`（非 ui） | 页面/业务组件 | L3 扫尾残留 |

---

## Task 1: L1 — 重写 index.css（token + 字体 + 去网格 + 软化 bp-*）

**Files:**
- Modify: `src/web/src/index.css`（整文件重写）

这是最大杠杆。改完后全站基调即变。

- [ ] **Step 1: 用以下内容整体替换 `src/web/src/index.css`**

```css
@import "tailwindcss";
@import "tw-animate-css";

@import url("https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&family=Manrope:wght@400;500;600;700;800&family=Noto+Sans+SC:wght@400;500;700&family=Source+Serif+4:ital,opsz,wght@0,8..60,400;0,8..60,500;0,8..60,600&display=swap");

@custom-variant dark (&:where(.dark, .dark *));

@theme inline {
  --font-sans: "Manrope", "Noto Sans SC", system-ui, sans-serif;
  --font-mono: "JetBrains Mono", "Noto Sans SC", "Cascadia Code", ui-monospace, monospace;
  --font-display: "Source Serif 4", "Noto Sans SC", Georgia, serif;

  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-card: var(--card);
  --color-card-foreground: var(--card-foreground);
  --color-popover: var(--popover);
  --color-popover-foreground: var(--popover-foreground);
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
  --color-secondary: var(--secondary);
  --color-secondary-foreground: var(--secondary-foreground);
  --color-muted: var(--muted);
  --color-muted-foreground: var(--muted-foreground);
  --color-accent: var(--accent);
  --color-accent-foreground: var(--accent-foreground);
  --color-destructive: var(--destructive);
  --color-destructive-foreground: var(--destructive-foreground);
  --color-success: var(--success);
  --color-success-foreground: var(--success-foreground);
  --color-warning: var(--warning);
  --color-warning-foreground: var(--warning-foreground);
  --color-info: var(--info);
  --color-info-foreground: var(--info-foreground);
  --color-border: var(--border);
  --color-input: var(--input);
  --color-ring: var(--ring);

  --color-sidebar: var(--sidebar);
  --color-sidebar-foreground: var(--sidebar-foreground);
  --color-sidebar-primary: var(--sidebar-primary);
  --color-sidebar-primary-foreground: var(--sidebar-primary-foreground);
  --color-sidebar-accent: var(--sidebar-accent);
  --color-sidebar-accent-foreground: var(--sidebar-accent-foreground);
  --color-sidebar-border: var(--sidebar-border);
  --color-sidebar-ring: var(--sidebar-ring);

  /* Claude 风：柔和圆角 */
  --radius-sm: 0.375rem;
  --radius-md: 0.5rem;
  --radius-lg: 0.75rem;
  --radius-xl: 1rem;
}

:root {
  --radius: 0.5rem;

  /* Light = 暖象牙奶油底 + 珊瑚橘墨 */
  --background: oklch(0.97 0.008 90);
  --foreground: oklch(0.27 0.006 60);
  --card: oklch(0.99 0.005 90);
  --card-foreground: oklch(0.27 0.006 60);
  --popover: oklch(0.99 0.005 90);
  --popover-foreground: oklch(0.27 0.006 60);
  --primary: oklch(0.64 0.13 42);
  --primary-foreground: oklch(0.99 0.005 90);
  --secondary: oklch(0.94 0.008 85);
  --secondary-foreground: oklch(0.27 0.006 60);
  --muted: oklch(0.94 0.008 85);
  --muted-foreground: oklch(0.27 0.006 60 / 0.55);
  --accent: oklch(0.64 0.13 42);
  --accent-foreground: oklch(0.99 0.005 90);
  --destructive: oklch(0.55 0.18 27);
  --destructive-foreground: oklch(0.99 0.005 90);
  --success: oklch(0.55 0.10 150);
  --success-foreground: oklch(0.99 0.005 90);
  --warning: oklch(0.70 0.13 70);
  --warning-foreground: oklch(0.27 0.006 60);
  --info: oklch(0.60 0.10 240);
  --info-foreground: oklch(0.99 0.005 90);
  --border: oklch(0.27 0.006 60 / 0.12);
  --input: oklch(0.27 0.006 60 / 0.18);
  --ring: oklch(0.64 0.13 42 / 0.4);

  --sidebar: oklch(0.955 0.008 88);
  --sidebar-foreground: oklch(0.27 0.006 60);
  --sidebar-primary: oklch(0.64 0.13 42);
  --sidebar-primary-foreground: oklch(0.99 0.005 90);
  --sidebar-accent: oklch(0.94 0.008 85);
  --sidebar-accent-foreground: oklch(0.27 0.006 60);
  --sidebar-border: oklch(0.27 0.006 60 / 0.10);
  --sidebar-ring: oklch(0.64 0.13 42 / 0.4);
}

.dark {
  /* Dark = 暖炭灰底 + 珊瑚橘（非纯黑） */
  --background: oklch(0.20 0.004 60);
  --foreground: oklch(0.93 0.005 80);
  --card: oklch(0.24 0.004 60);
  --card-foreground: oklch(0.93 0.005 80);
  --popover: oklch(0.24 0.004 60);
  --popover-foreground: oklch(0.93 0.005 80);
  --primary: oklch(0.70 0.13 42);
  --primary-foreground: oklch(0.20 0.004 60);
  --secondary: oklch(0.28 0.004 60);
  --secondary-foreground: oklch(0.93 0.005 80);
  --muted: oklch(0.28 0.004 60);
  --muted-foreground: oklch(0.93 0.005 80 / 0.55);
  --accent: oklch(0.70 0.13 42);
  --accent-foreground: oklch(0.20 0.004 60);
  --destructive: oklch(0.65 0.17 25);
  --destructive-foreground: oklch(0.20 0.004 60);
  --success: oklch(0.70 0.13 150);
  --success-foreground: oklch(0.20 0.004 60);
  --warning: oklch(0.78 0.13 75);
  --warning-foreground: oklch(0.20 0.004 60);
  --info: oklch(0.70 0.10 240);
  --info-foreground: oklch(0.20 0.004 60);
  --border: oklch(0.93 0.005 80 / 0.12);
  --input: oklch(0.93 0.005 80 / 0.18);
  --ring: oklch(0.70 0.13 42 / 0.45);

  --sidebar: oklch(0.18 0.004 60);
  --sidebar-foreground: oklch(0.93 0.005 80);
  --sidebar-primary: oklch(0.70 0.13 42);
  --sidebar-primary-foreground: oklch(0.20 0.004 60);
  --sidebar-accent: oklch(0.28 0.004 60);
  --sidebar-accent-foreground: oklch(0.93 0.005 80);
  --sidebar-border: oklch(0.93 0.005 80 / 0.10);
  --sidebar-ring: oklch(0.70 0.13 42 / 0.45);
}

@layer base {
  * {
    @apply border-border;
    -webkit-font-smoothing: antialiased;
  }
  html {
    -webkit-text-size-adjust: 100%;
    text-size-adjust: 100%;
  }
  body {
    @apply bg-background text-foreground font-sans;
    font-feature-settings: "rlig" 1, "calt" 1;
    /* mobile 兜底：长 URL / 文件路径 / 任务 ID 等无空格串不撑爆父容器 */
    overflow-wrap: anywhere;
    /* Claude 风：纯净底色，去网格 + 去噪点 */
  }
  *:focus-visible {
    @apply outline-ring outline-2 outline-offset-2;
  }
  ::selection {
    background-color: var(--accent);
    color: var(--accent-foreground);
  }

  /* 标题：正常大小写 sans，靠字重/字号分层；不再强制 display 字体 + 大写 */
  h1, h2, h3, h4, h5, h6 {
    font-weight: 700;
    letter-spacing: -0.01em;
  }
  code, kbd, pre, samp {
    font-family: var(--font-mono);
  }
}

/* ──────────── 全局滚动条样式（柔和） ──────────── */
* {
  scrollbar-width: thin;
  scrollbar-color: var(--border) transparent;
}
*::-webkit-scrollbar {
  width: 10px;
  height: 10px;
}
*::-webkit-scrollbar-track {
  background: transparent;
}
*::-webkit-scrollbar-thumb {
  background: var(--border);
  border-radius: 6px;
  border: 2px solid transparent;
  background-clip: padding-box;
  transition: background-color 0.15s;
}
*::-webkit-scrollbar-thumb:hover {
  background: var(--muted-foreground);
  background-clip: padding-box;
}
*::-webkit-scrollbar-thumb:active {
  background: var(--accent);
  background-clip: padding-box;
}
*::-webkit-scrollbar-corner {
  background: transparent;
}

@layer utilities {
  /* .scrollbar-thin 兼容 alias（现有多文件引用），统一柔和样式 */
  .scrollbar-thin {
    scrollbar-width: thin;
    scrollbar-color: var(--border) transparent;
  }
  .scrollbar-thin::-webkit-scrollbar {
    width: 8px;
    height: 8px;
  }
  .scrollbar-thin::-webkit-scrollbar-track {
    background: transparent;
  }
  .scrollbar-thin::-webkit-scrollbar-thumb {
    background: var(--border);
    border-radius: 6px;
  }
  .scrollbar-thin::-webkit-scrollbar-thumb:hover {
    background: var(--muted-foreground);
  }

  /* ──────────── 兼容工具类（原 bp-*，已软化为 Claude 等价物） ──────────── */
  /* 类名保留作为兼容 alias，避免改动 62 个引用文件；语义改为柔和 */

  /* 柔和投影（替代原硬阴影） */
  .bp-shadow {
    box-shadow: 0 1px 2px rgb(0 0 0 / 0.06), 0 2px 6px rgb(0 0 0 / 0.06);
  }
  .bp-shadow-sm {
    box-shadow: 0 1px 2px rgb(0 0 0 / 0.06);
  }
  /* hover 微抬升（去平移，去硬阴影） */
  .bp-lift {
    transition: transform 0.18s ease, box-shadow 0.18s ease;
  }
  .bp-lift:hover {
    transform: translateY(-1px);
    box-shadow: 0 4px 12px rgb(0 0 0 / 0.08);
  }

  /* 网格底纹：软化为 no-op（保留类名兼容） */
  .bp-grid {
    background-image: none;
  }

  /* 切角：移除 HUD 切口，改圆角 */
  .bp-clip-corner {
    border-radius: var(--radius);
  }

  /* 分割线：点划线 → 实线低对比 */
  .bp-divider {
    border-top: 1px solid var(--border);
  }

  /* 小标签（eyebrow）：mono 小字灰，去大写、降字距（Claude 风小写灰标签） */
  .bp-label {
    font-family: var(--font-mono);
    font-size: 11px;
    letter-spacing: 0.04em;
    color: var(--muted-foreground);
  }
  .bp-label-accent {
    color: var(--accent);
  }

  /* 严格 mono（数据、ID、文件名） */
  .font-mono-strict {
    font-family: var(--font-mono);
    font-variant-ligatures: none;
  }

  /* 编号块：实色方块 → 圆角柔和徽标 */
  .bp-num-block {
    font-family: var(--font-display);
    font-weight: 600;
    background: var(--primary);
    color: var(--primary-foreground);
    border-radius: var(--radius-sm);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    line-height: 1;
  }

  /* MarkdownView 容器：长串断行兜底 */
  .prose-bp {
    overflow-wrap: anywhere;
    word-break: break-word;
  }
  .prose-bp pre {
    overflow-wrap: normal;
    word-break: normal;
  }

  /* Checkbox：圆角 + 淡描边，选中态橘 */
  .bp-checkbox {
    -webkit-appearance: none;
    appearance: none;
    height: 1rem;
    width: 1rem;
    flex-shrink: 0;
    cursor: pointer;
    border: 1.5px solid color-mix(in oklch, var(--foreground) 25%, transparent);
    background-color: transparent;
    border-radius: 0.25rem;
    transition: background-color 0.15s ease, border-color 0.15s ease;
  }
  .bp-checkbox:hover:not(:disabled) {
    border-color: var(--accent);
  }
  .bp-checkbox:checked {
    background-color: var(--accent);
    border-color: var(--accent);
    background-image: url("data:image/svg+xml;utf8,<svg viewBox='0 0 16 16' xmlns='http://www.w3.org/2000/svg'><path fill='none' stroke='%23fff' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round' d='M3 8.5 L6.5 12 L13 5'/></svg>");
    background-repeat: no-repeat;
    background-position: center;
    background-size: 88%;
  }
  .bp-checkbox:indeterminate {
    background-color: var(--accent);
    border-color: var(--accent);
    background-image: url("data:image/svg+xml;utf8,<svg viewBox='0 0 16 16' xmlns='http://www.w3.org/2000/svg'><path stroke='%23fff' stroke-width='2.5' stroke-linecap='round' d='M3.5 8 L12.5 8'/></svg>");
    background-repeat: no-repeat;
    background-position: center;
    background-size: 88%;
  }
  .bp-checkbox:focus-visible {
    outline: 2px solid var(--ring);
    outline-offset: 1px;
  }
  .bp-checkbox:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }
}
```

- [ ] **Step 2: typecheck + 构建**

Run: `bun run typecheck && bun run build:web`
Expected: 两者均通过，无报错。

- [ ] **Step 3: 目视 sanity（可选，用户自跑 daemon）**

期望：底色变暖象牙白（深色变暖炭灰），无网格底纹，主强调色变珊瑚橘，整体圆角。此时基础组件可能仍有方角残留（L2 未改），正常。

- [ ] **Step 4: Commit**

```bash
git add src/web/src/index.css
git commit -m "feat(web): L1 主题换风 — Claude 配色 token + 字体 + 去网格 + 软化 bp-* 工具类"
```

---

## Task 2: L2 — 重写 button.tsx

**Files:**
- Modify: `src/web/src/components/ui/button.tsx`

- [ ] **Step 1: 用以下内容替换 `buttonVariants` 的 cva 定义（保留文件其余结构）**

把顶部注释与 `cva(...)` 第一参数及 `variants` 改为：

```tsx
/**
 * Claude 风按钮：
 * - 圆角（rounded-md）
 * - 1px 边框 / 实色填充
 * - hover 微深底色，无平移、无硬阴影
 * - 正常大小写 sans 字体
 *
 * size 规范（关键）：所有 size 同高（h-9 = 36px），lg 例外（h-11）
 */
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md border font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground border-transparent hover:bg-primary/90",
        destructive:
          "bg-destructive text-destructive-foreground border-transparent hover:bg-destructive/90",
        outline:
          "border-border bg-transparent text-foreground hover:bg-muted",
        secondary:
          "bg-secondary text-secondary-foreground border-transparent hover:bg-secondary/70",
        ghost:
          "border-transparent text-foreground hover:bg-muted",
        link:
          "border-transparent text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 text-sm",
        sm: "h-9 px-3 text-[13px]",
        lg: "h-11 px-6 text-base",
        icon: "h-9 w-9 [&_svg]:size-4",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);
```

> variant/size 键名完全不变（default/destructive/outline/secondary/ghost/link；default/sm/lg/icon），调用方零改动。

- [ ] **Step 2: typecheck**

Run: `bun run typecheck`
Expected: PASS。

- [ ] **Step 3: Commit**

```bash
git add src/web/src/components/ui/button.tsx
git commit -m "feat(web): L2 button 换 Claude 风（圆角/实色填充/去大写 mono）"
```

---

## Task 3: L2 — 重写 card.tsx

**Files:**
- Modify: `src/web/src/components/ui/card.tsx`

- [ ] **Step 1: 替换 Card / CardHeader / CardTitle / CardFooter 的 className**

- `Card`：`"rounded-none border-[1.5px] border-foreground/30 bg-card text-card-foreground"` → `"rounded-lg border border-border bg-card text-card-foreground shadow-[0_1px_2px_rgb(0_0_0/0.05),0_2px_6px_rgb(0_0_0/0.05)]"`
- `CardHeader`：`"...border-b border-dashed border-foreground/25"` → `"flex flex-col space-y-1.5 p-5 border-b border-border"`
- `CardTitle`：`"font-display font-bold uppercase tracking-wide text-lg leading-none"` → `"font-semibold text-lg leading-none tracking-tight"`
- `CardFooter`：`"...border-t border-dashed border-foreground/25"` → `"flex items-center p-5 pt-0 border-t border-border"`
- 顶部注释「蓝图风卡片」改为「Claude 风卡片：圆角 + 1px 淡边 + 柔投影」

- [ ] **Step 2: typecheck**

Run: `bun run typecheck`
Expected: PASS。

- [ ] **Step 3: Commit**

```bash
git add src/web/src/components/ui/card.tsx
git commit -m "feat(web): L2 card 换 Claude 风（圆角/淡边/柔投影/标题去大写）"
```

---

## Task 4: L2 — 重写 badge.tsx

**Files:**
- Modify: `src/web/src/components/ui/badge.tsx`

- [ ] **Step 1: 替换 `badgeVariants` 基础串与顶部注释**

基础串 `"inline-flex items-center rounded-none border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.15em] font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1"`
→ `"inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1"`

variants 保持键名不变，底色用更淡 tint：
```tsx
      variant: {
        default: "border-transparent bg-primary text-primary-foreground",
        secondary: "border-transparent bg-secondary text-secondary-foreground",
        outline: "border-border bg-transparent text-foreground",
        success: "border-transparent bg-success/12 text-success",
        warning: "border-transparent bg-warning/15 text-warning",
        info: "border-transparent bg-info/12 text-info",
        accent: "border-transparent bg-accent/12 text-accent",
        destructive: "border-transparent bg-destructive/12 text-destructive",
        muted: "border-transparent bg-muted text-muted-foreground",
      },
```
顶部注释「蓝图风 Badge」→「Claude 风 Badge：圆角 + 淡 tint + 正常大小写」。

- [ ] **Step 2: typecheck**

Run: `bun run typecheck`
Expected: PASS。

- [ ] **Step 3: Commit**

```bash
git add src/web/src/components/ui/badge.tsx
git commit -m "feat(web): L2 badge 换 Claude 风（圆角/淡 tint/去大写 mono）"
```

---

## Task 5: L2 — 重写 input.tsx

**Files:**
- Modify: `src/web/src/components/ui/input.tsx`

- [ ] **Step 1: 替换 Input 与 Textarea 的 className 及顶部注释**

Input className（把 `rounded-none border-[1.5px] border-foreground/35` 与 `placeholder:font-mono placeholder:text-xs placeholder:tracking-wider` 与 `focus-visible:border-accent` 改掉）：
```
"flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm transition-colors placeholder:text-muted-foreground file:border-0 file:bg-transparent file:text-sm file:font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-50"
```

Textarea className：
```
"flex min-h-20 w-full rounded-md border border-input bg-background px-3 py-2 text-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-50"
```

顶部注释改「Claude 风输入框：圆角 + 1px 淡边 + 聚焦橘环」。

- [ ] **Step 2: typecheck**

Run: `bun run typecheck`
Expected: PASS。

- [ ] **Step 3: Commit**

```bash
git add src/web/src/components/ui/input.tsx
git commit -m "feat(web): L2 input/textarea 换 Claude 风（圆角/淡边/聚焦橘环）"
```

---

## Task 6: L2 — 重写 tabs.tsx

**Files:**
- Modify: `src/web/src/components/ui/tabs.tsx`

下边线触发的结构保留（Claude 也用 underline tab），只去 mono/大写/重字距。

- [ ] **Step 1: 替换 TabsList 与 TabsTrigger 的 className**

- `TabsList`：`"...border-b border-foreground/25..."` → `"inline-flex h-10 items-end gap-1 border-b border-border text-muted-foreground"`
- `TabsTrigger`：把 `rounded-none ... font-mono text-[11px] uppercase tracking-[0.18em] font-medium ... data-[state=active]:border-accent` 改为：
```
"inline-flex items-center justify-center whitespace-nowrap rounded-t-md px-4 pt-2 pb-2 text-sm font-medium transition-all border-b-2 border-transparent -mb-px focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 hover:text-foreground data-[state=active]:text-foreground data-[state=active]:border-primary"
```
顶部注释「蓝图风 Tabs」→「Claude 风 Tabs：下边线触发，选中底部 primary underline」。

- [ ] **Step 2: typecheck**

Run: `bun run typecheck`
Expected: PASS。

- [ ] **Step 3: Commit**

```bash
git add src/web/src/components/ui/tabs.tsx
git commit -m "feat(web): L2 tabs 换 Claude 风（去 mono/大写，underline 选中橘）"
```

---

## Task 7: L2 — 机械替换其余 12 个 ui 组件

**Files（逐个 Modify）:**
`src/web/src/components/ui/` 下：`dialog.tsx` `sheet.tsx` `popover.tsx` `select.tsx` `dropdown-menu.tsx` `command.tsx` `table.tsx` `tooltip.tsx` `switch.tsx` `label.tsx` `separator.tsx` `sonner.tsx`

> `checkbox.tsx` 不动（它走 `.bp-checkbox`，已在 Task 1 软化）。

**统一替换规则（对每个文件逐处 grep 后改）：**

| 找到 | 改成 |
|---|---|
| `rounded-none` | `rounded-md`（菜单/弹层容器用 `rounded-lg`；小元素如 menu item 用 `rounded-sm`） |
| `border-[1.5px]` | `border`（1px） |
| `border-foreground/30`、`border-foreground/35`、`border-foreground/25` 等硬描边 | `border-border` |
| `border-dashed` | 去掉 `border-dashed`（留实线） |
| `font-mono`（非代码/数据语义处） | 去掉 |
| `uppercase` | 去掉 |
| `tracking-[0.1…0.2em]`、`tracking-wider/widest` | 去掉 |
| `shadow-[Npx_Npx_0_0_…]`（硬阴影） | `shadow-md`（弹层）或 `shadow-sm` |
| `translate-x-[-1px] translate-y-[-1px]`（hover 平移） | 去掉 |
| 选中/强调 `border-accent`/`text-accent` | 保留（accent 现=橘，语义正确） |

- [ ] **Step 1: 逐文件改。先列出每个文件的待改处**

Run（PowerShell）:
```
bun run typecheck  # 改前基线
```
然后对每个文件用 Grep 工具查 `rounded-none|border-\[1\.5px\]|uppercase|font-mono|tracking-\[|border-dashed|shadow-\[|translate-x-\[-1px\]`，按上表逐处替换。各文件顶部「蓝图风…」注释同步改为「Claude 风…」。

- [ ] **Step 2: typecheck + 构建**

Run: `bun run typecheck && bun run build:web`
Expected: 均通过。

- [ ] **Step 3: 验证 ui 目录蓝图残留归零**

Run（Grep 工具，path=`src/web/src/components/ui`，pattern 如下）:
```
rounded-none|border-\[1\.5px\]|uppercase|tracking-\[0|border-dashed|shadow-\[[0-9]
```
Expected: 0 命中（`font-mono` 在 sonner/数据语义处若刻意保留可豁免，逐个判断）。

- [ ] **Step 4: Commit**

```bash
git add src/web/src/components/ui/
git commit -m "feat(web): L2 其余 12 个 ui 组件换 Claude 风（圆角/淡边/去 mono 大写/柔投影）"
```

---

## Task 8: L3 — 页面残留扫尾（高密度页）

**Files（按引用密度，逐文件 Modify）:**
1. `src/web/src/pages/RequirementDetail.tsx`（34）
2. `src/web/src/pages/TaskDetail.tsx`（17）
3. `src/web/src/pages/Tasks.tsx`（14）
4. `src/web/src/pages/NewWorkflowWithAI.tsx`（12）
5. `src/web/src/pages/ProjectDetail.tsx`（10）
6. `src/web/src/components/TaskOutcomeCard.tsx`（10）
7. `src/web/src/components/PhasePipelineEditor.tsx`（10）

**扫尾规则（对每个文件 grep `font-display|uppercase|rounded-none|border-\[1\.5px\]|tracking-\[|shadow-\[[0-9]|bp-shadow` 后逐处判断）：**

- `font-display` 业务标题：是真大标题 → 保留（现为 Source Serif 4 衬线，符合 Claude 编辑感）；否则删，回归 sans
- `uppercase` 业务标签：去大写；若是 eyebrow 小标签可换用 `.bp-label`（已软化）
- `rounded-none` → `rounded-md`；`border-[1.5px]` → `border`
- `tracking-[…]`（大字距）→ 去掉
- `shadow-[Npx_Npx_0…]` 硬阴影 → 换 `.bp-shadow`（已软化）或 `shadow-sm`
- `bp-shadow`/`bp-lift`/`bp-clip-corner`/`bp-grid`/`bp-divider`/`bp-num-block`/`bp-label`：保留类名（Task 1 已软化），仅核对视觉是否合理

- [ ] **Step 1: 逐文件扫尾替换**（用 Grep 工具定位，Edit 工具改）

- [ ] **Step 2: typecheck + 构建**

Run: `bun run typecheck && bun run build:web`
Expected: 均通过。

- [ ] **Step 3: Commit**

```bash
git add src/web/src/pages/RequirementDetail.tsx src/web/src/pages/TaskDetail.tsx src/web/src/pages/Tasks.tsx src/web/src/pages/NewWorkflowWithAI.tsx src/web/src/pages/ProjectDetail.tsx src/web/src/components/TaskOutcomeCard.tsx src/web/src/components/PhasePipelineEditor.tsx
git commit -m "feat(web): L3 高密度页扫尾换 Claude 风"
```

---

## Task 9: L3 — 页面残留扫尾（低密度页）+ PageHero 衬线确认

**Files:**
- 其余所有含残留的页面/组件（除已处理者，约 50 个，每个 1–9 处）
- `src/web/src/components/PageHero.tsx`（确认大标题显式 `font-display` → 现 Source Serif 4）

- [ ] **Step 1: 全量定位剩余残留**

Run（Grep 工具，path=`src/web/src`，排除已处理文件后逐个过）:
```
font-display|uppercase|rounded-none|border-\[1\.5px\]|tracking-\[0\.1|tracking-\[0\.2|shadow-\[[0-9]
```
按 Task 8 同规则逐处改。

- [ ] **Step 2: 确认 PageHero**

打开 `src/web/src/components/PageHero.tsx`，确保主标题用 `font-display`（现已=Source Serif 4 暖衬线），副标题/正文 sans。这是刻意保留衬线的唯一处。

- [ ] **Step 3: 残留收敛验证**

Run（Grep 工具，path=`src/web/src`）:
```
rounded-none|border-\[1\.5px\]|tracking-\[0\.[12]|shadow-\[[0-9]px_[0-9]
```
Expected: 0 命中。
再查 `uppercase`：Expected 仅剩刻意保留处（若有，逐个确认语义）。
再查 `font-display`：Expected 仅剩 PageHero 等真大标题。

- [ ] **Step 4: typecheck + 构建**

Run: `bun run typecheck && bun run build:web`
Expected: 均通过。

- [ ] **Step 5: Commit**

```bash
git add src/web/src/
git commit -m "feat(web): L3 低密度页扫尾 + PageHero 衬线确认，蓝图残留归零"
```

---

## Task 10: 双主题双模式人工走查 + 收尾

**Files:** 无（验收 + 可能的微调修补）

- [ ] **Step 1: 启动 daemon + 浏览器**

用户自跑：`autopilot daemon restart`（或开发态）后浏览器开 `http://127.0.0.1:6180`。

- [ ] **Step 2: 双模式走查清单**

浅色 / 深色各走一遍，逐项核对：
- [ ] 主路径页面：Now / Tasks / TaskDetail / RequirementDetail / Workflows / Settings / ProjectDetail
- [ ] 浮层：Dialog / Sheet / Popover / Dropdown / Select / Command / Tooltip / Toast(sonner)
- [ ] 视觉：圆角一致、无残留硬阴影/网格底纹/全大写标题、珊瑚橘强调到位
- [ ] 状态色：success/warning/info/destructive 在 badge/progress/timeline 语义清晰
- [ ] 危险操作：destructive 按钮醒目
- [ ] 可读性：正文对比 ≥ 4.5:1、UI/大字 ≥ 3:1（浏览器取色核对；不足则微调对应 oklch token 的 L 值）
- [ ] 聚焦环可见、滚动条圆角柔色、PageHero 衬线生效

- [ ] **Step 3: 修补走查发现的问题**（如对比度不足微调 token、个别残留补改），逐个 commit

```bash
git add -A
git commit -m "fix(web): Claude 主题走查微调（对比度/残留修补）"
```

- [ ] **Step 4: 完成**

全部 typecheck + build:web 通过，双主题走查清单全绿，蓝图残留 grep 归零（PageHero 衬线除外）。
