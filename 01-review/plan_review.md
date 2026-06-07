<!-- generated:2026-06-07T05:48:36.868Z -->
## 技术方案评审报告（第二轮）

### 针对驳回点的逐条核查

#### [Critical] FolderPicker → daemon 服务端目录 RPC ✅

方案改为通过 `api.browseFs()` 调用 daemon 侧接口，绕开浏览器 File API 的安全限制，并声称 `ProjectDetail.tsx` 已有先例。这是正确的技术路径。

**一个前提风险**：方案断言 `browseFs()` 已存在，但未在任务列表中列出「新增 browseFs RPC」。如果这个接口实际上不存在，Task 8（Web UI）会在实现时才发现缺口，导致返工。建议在执行 Task 8 前先确认该接口确实已落地。

#### [Important] 成功输出格式 ✅

方案现在定义了精确文案，CLI 输出实际生效的 alias（含后缀追加结果），Web toast 同步展示。问题已解决。

#### [Important] resolveUniqueAlias 去重范围 ✅

明确「全局跨所有 project_id」，Task 2 SQL 无 `project_id` 过滤条件。问题已解决。

#### [Important] Core 单元测试 ✅

Task 1 新增 16 个测试（TDD 红灯先行），使用 `_setDbForTest` + 内存 DB，不依赖 daemon。覆盖纯函数、DB 写入、集成场景。问题已解决。

---

### 本轮新发现的问题

#### [Minor] 事务回滚场景是否在 4 个 DB 测试中？

摘要未明确说明 4 个 DB 测试的具体内容。「createWorkspace 在事务中失败 → project 回滚」是最关键的原子性验证，应确保 16 个测试里有这一条。

#### [Minor] `<path>` 省略时的报错文案

旧命令 `autopilot project create <name>`（不带 path）变为非法。Commander.js 会抛出默认的参数错误，但默认提示不够友好。建议补一行自定义错误文案，引导用户补充 `<path>`。

#### [Minor] Web UI 路径输入的 inline 错误提示

用户通过 browseFs 选好路径后提交，若 daemon 在写库时发现路径校验失败（例如并发删除），错误应以 inline 形式展示在路径字段旁，而非只有全局 toast。方案中未涉及此细节，留给实现阶段决策即可，但要确保不被遗漏。

---

### 综合评估

| 维度 | 结论 |
|------|------|
| **完整性** | ✅ 四条驳回均已设计覆盖；browseFs 前提需实现前验证 |
| **可行性** | ✅ daemon RPC + 内存 DB 测试方案均可行 |
| **风险点** | 仅剩 `browseFs()` 是否真实存在这一个待确认项，其余风险已收敛 |
| **测试覆盖** | ✅ 16 个单元测试 + 现有 CLI 集成测试更新；建议确认事务回滚场景已包含 |

---

REVIEW_RESULT: PASS