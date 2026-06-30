# Step 2+3 实施报告

## Commit SHA

- **Step 2（宿主骨架）**：`6de5024` — feat(extensions): 立扩展宿主骨架（Step 2）
- **Step 3（连接器移植）**：`2fee078` — feat(extensions): 连接器移植到扩展 API（Step 3）

## 新增/改动文件

| 文件 | 操作 |
|------|------|
| `src/daemon/extensions/context.ts` | 新增 |
| `src/daemon/extensions/registry.ts` | 新增 |
| `tests/extensions-registry.test.ts` | 新增 |
| `src/daemon/selfhosted-connector/extension.ts` | 新增 |
| `src/daemon/selfhosted-connector/mirror-pusher.ts` | 修改 |
| `src/daemon/selfhosted-connector/index.ts` | 重写（瘦身） |
| `src/daemon/index.ts` | 修改（行 263-268） |
| `tests/mirror-pusher.test.ts` | 新增 |

## ExtensionContext 最终接口

```typescript
interface ExtensionContext {
  log: Logger;
  on(type, handler): void;               // 宿主追踪，dispose 统一 offEvent

  read: {
    requirement(id): Requirement | null;
    inflightBySource(source): InflightRequirement[];
    comments(reqId): Comment[];
    subPrs(reqId): RequirementSubPr[];
    phaseEvents(reqId): PhaseEventEntry[];   // 已映射为显示格式，含 run_seq/state/ISO 时间戳
    task(taskId): Task | null;
  };

  act: {
    createRequirement(opts): string;
    setStatus(id, to, opts?): void;
    setWorkspaces(reqId, wsIds): void;
    resolveWorkspacesByUrls(projectId, urls): Promise<string[]>;
    addComment(params): void;
    resolveComment(commentId): void;
    finishClarification(id): void;
    retryClarify(id): Promise<void>;
    cancelRequirement(id): void;
  };

  config: { section(key): unknown };
  storage: { dir(): string };
}
```

## 连接器移植后还直接 import 的 core/daemon

`src/daemon/selfhosted-connector/extension.ts` 直接 import：
- `loadSelfhostedConfig`（core/config）— enabled() 检查，仅读配置
- `loadSelfhostedCredentials`（./credentials）— 插件自管凭证
- `SelfhostedBackend`（./backend）— 插件私有 HTTP 客户端
- `AssignmentPoller / CommandPoller / MirrorPusher`（./assignments-poller / commands-poller / mirror-pusher）— 插件子模块
- `recoverInflightLinks`（./index）— 留在 index.ts 供现有测试（selfhosted-connector-recovery.test.ts）复用
- `DEFAULT_PROJECT_ID`（core/projects）— 建需求时 fallback 项目 id（纯常量，无 SQL）
- `type Extension, type ExtensionContext`（../extensions/context）— 接口类型 only

理想状态：只剩类型 + 插件子模块 + 配置/凭证读取（均为插件自己的肉）。唯一残留的直接 core import 是 `DEFAULT_PROJECT_ID`（常量），可接受。

## 测试结果

- `bun run typecheck`：**0 errors**
- `bun test tests/mirror-pusher.test.ts`：**9/9 pass**
- `bun test tests/selfhosted-mirror-pusher.test.ts tests/selfhosted-connector-recovery.test.ts tests/extensions-registry.test.ts`：**16/16 pass**

## 特殊说明

1. `MirrorPusherDeps.onEvent/offEvent` 设为可选（默认回退 core 实现），保持与现有 8 个测试文件向后兼容。
2. 修复了旧 MirrorPusher.dispose() 的 `.bind()` bug（每次 .bind 生成新对象，旧 offEvent 调用实际无效）。
3. `recoverInflightLinks` 保留在 `selfhosted-connector/index.ts` 不动（现有测试依赖该导出路径）。
