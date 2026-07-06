# Step 6b: reqgenie 前端 A 模式组件退役报告

**执行日期**: 2026-06-29  
**分支**: `feat/requirement-form-simplify-20260611-zj`  
**commit**: `36aa41e2`

## 删除的文件（7 个）

| 文件 | 说明 |
|------|------|
| `frontend/src/components/SelfHostedDevPanel.tsx` | A 模式会话切换器 + 派发面板（内嵌 SelfHostedSession） |
| `frontend/src/components/SelfHostedAutopilotEntry.tsx` | A 模式引导卡（deeplink 跳转本机 autopilot，已被 B-interactive 取代） |
| `frontend/src/components/SelfHostedSession.tsx` | 自加载容器，桥接 useDevSessionData → SelfHostedSessionView |
| `frontend/src/components/SelfHostedSessionView.tsx` | A 模式线性时间线视图主体（照搬 autopilot TaskRunView 风格） |
| `frontend/src/hooks/useDevSessionData.ts` | 封装单 session 全套数据加载与交互逻辑的 hook |
| `frontend/src/lib/session-timeline.ts` | 纯函数：将 DevSessionEvent[] 切成阶段块（buildSessionTimeline 等） |
| `frontend/src/lib/session-timeline.test.ts` | session-timeline 单元测试 |

## 修改的文件（1 个）

**`frontend/src/pages/DevSession.tsx`**:
- 删除第 19 行 `import SelfHostedSessionView from '../components/SelfHostedSessionView'`
- 删除 `session.agent_backend === 'autopilot_selfhosted'` 分支（原 527–545 行），codex 渲染路径完整保留

## 保留验证

- `frontend/src/components/selfhosted/` — SelfHostedWorkbench 等 B-interactive 组件完好
- `frontend/src/api/selfhostedLinks.ts` — B-interactive 所需 API 完好，被 7 个 selfhosted/ 子组件引用
- `frontend/src/components/MyRunners.tsx` — runner 管理完好（被 Profile.tsx 使用）
- `frontend/src/pages/RunnerManager.tsx` — runner 管理页完好（App.tsx 路由）

## 构建结果

- `npx tsc -b --noEmit` — 无任何错误输出
- `npm run build` — 构建成功（仅有 chunk size 警告，与本次改动无关）

## 依赖链分析

删除前 grep 确认：`SelfHostedAutopilotEntry` 和 `SelfHostedDevPanel` 均无外部引用方（仅自身导出），安全删除。`SelfHostedSessionView` 只被 `DevSession.tsx`（已修改）和 `SelfHostedSession.tsx`（一并删除）引用。整条链路干净退场。
