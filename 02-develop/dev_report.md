<!-- generated:2026-06-07T06:01:11.189Z -->
✅ **979 个测试全部通过，0 失败，无回归。**

---

## 开发完成总结

所有 10 个 Task 已实现，变更清单如下：

| Task | 文件 | 操作 | 内容 |
|------|------|------|------|
| 1 | `tests/core-create-project-with-workspace.test.ts` | 新建 | 16 个单元测试（deriveAlias 5 + resolveUniqueAlias 4 + createProjectWithWorkspace 7） |
| 2 | `src/core/workspaces.ts` | 修改 | 新增 `deriveAlias()` + `resolveUniqueAlias()` 两个导出函数 |
| 3 | `src/core/projects.ts` | 修改 | 新增 `CreateProjectWithWorkspaceOpts` 接口 + `createProjectWithWorkspace()` 原子事务函数 |
| 4 | `src/daemon/rpc-methods.ts` | 修改 | 注册 `projects.createWithWorkspace` RPC 方法（含路径校验 + git 探测） |
| 5 | `src/client/http.ts` + `src/client/index.ts` | 修改 | 客户端新增 `createProjectWithWorkspace()` 方法 |
| 6 | `src/cli/project.ts` | 修改 | `project create` 签名改为 `<name> <path>`，新增 `--alias`、客户端路径预校验 |
| 7 | `src/web/src/hooks/useApi.ts` | 修改 | api 对象新增 `createProjectWithWorkspace` RPC 包装 |
| 8 | `src/web/src/pages/Library.tsx` | 修改 | 新建项目对话框添加路径 + alias 字段，集成 FolderPicker |
| 9 | `tests/cli-project.test.ts` | 修改 | 更新两个受签名变化影响的测试 |
| 10 | `tests/cli-project-with-workspace.test.ts` | 新建 | 5 个 CLI 集成测试（帮助文本、路径校验、name 校验等） |

**验证结果：**
- ✅ `bun run typecheck` — 0 错误
- ✅ `bun run build:web` — 构建成功
- ✅ `bun test` — 979 个测试全部通过，0 失败