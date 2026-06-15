# 移动端需求详情页 Header 标题过长换行优化 — 设计方案

**日期**：2026-06-16  
**范围**：`src/web/src/pages/RequirementDetail.tsx`（Header/Hero 区）  
**类型**：移动端布局修复，桌面端零变化

---

## 一、背景与问题

需求详情页（`RequirementDetail.tsx`）的 Hero header 区，在移动端（<lg）当需求标题较长（如「修复 API 模式供应商澄清需求时报错」）时，标题会逐字换行成 5~6 行，把 header 撑得非常高，严重挤占首屏可用空间。

### 根因

非编辑态标题行结构（当前）：

```tsx
<div className="flex items-start justify-between gap-3">
  <div className="flex min-w-0 items-start gap-2">
    <h1 className="break-words text-2xl font-semibold leading-tight">标题</h1>
    {/* 编辑按钮 */}
  </div>
  {/* shrink-0：不缩减，挤压左侧标题列 */}
  <div className="flex shrink-0 gap-2 pt-1">
    {/* 取消需求 / 删除需求 */}
  </div>
</div>
```

右侧按钮组 `shrink-0` 不让步，移动端窄屏下标题列可用宽度极小，CJK 字符逐字换行。

---

## 二、方案决策

**确认方案：B + C（标题占满整行 + 缩小字号 + 操作按钮下移成行）**

- **标题独占整行**：移动端外层改为纵向堆叠（`flex-col`），消除按钮对标题的挤压
- **字号缩小**：移动端 `text-lg`，桌面端维持 `text-2xl`（响应式）
- **按钮下移**：移动端「取消需求 / 删除需求 / 编辑」位于标题下方一行横排
- **桌面端不变**：`lg:` 断点恢复 `flex-row justify-between`，与现状完全一致

**排除方案**：
- 省略号截断（破坏完整性，需求标题必须完整可读）
- 「更多(⋯)」折叠菜单（多一次点击，实现复杂，收益不足）

---

## 三、改动说明

文件：`src/web/src/pages/RequirementDetail.tsx`

### 改动 1：非编辑态外层容器（约 line 1592）

```tsx
// 改前
<div className="flex items-start justify-between gap-3">

// 改后
<div className="flex flex-col gap-2 lg:flex-row lg:items-start lg:justify-between lg:gap-3">
```

### 改动 2：h1 标题字号（约 line 1595）

```tsx
// 改前
<h1 className="break-words text-2xl font-semibold leading-tight tracking-tight">

// 改后
<h1 className="break-words text-lg font-semibold leading-tight tracking-tight lg:text-2xl">
```

### 改动 3：操作按钮组 pt 去响应式（约 line 1612）

```tsx
// 改前
<div className="flex shrink-0 gap-2 pt-1">

// 改后
<div className="flex shrink-0 gap-2 lg:pt-1">
```

### 改动 4：编辑态 Input 字号同步（约 line 1574）

```tsx
// 改前
className="h-auto break-words py-1.5 text-2xl font-semibold leading-tight tracking-tight"

// 改后
className="h-auto break-words py-1.5 text-lg font-semibold leading-tight tracking-tight lg:text-2xl"
```

---

## 四、影响范围

| 范围 | 状态 |
|---|---|
| `RequirementDetail.tsx` header（移动端） | 修改 |
| `RequirementDetail.tsx` header（桌面端 ≥lg） | 零变化 |
| 需求数据模型 / API / 状态机 | 无变化 |
| 标题编辑逻辑（saveTitle / editingTitle） | 无变化 |
| 取消/删除按钮触发逻辑 | 无变化 |
| 其他页面 / 组件 | 无影响 |

---

## 五、验收标准

1. 移动端（<lg）长标题不再逐字换行，header 高度显著降低，标题完整可读
2. 移动端「取消需求 / 删除需求」按钮位于标题下方，横排，均可正常点击
3. 编辑态（editingTitle）字号在移动端同步缩小为 `text-lg`
4. 桌面端（≥lg）布局、字号、按钮位置与改动前一致，无任何视觉回归
