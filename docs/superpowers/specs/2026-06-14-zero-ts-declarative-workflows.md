# 零 TS 声明式工作流：结构化裁判 + 框架交付 + 安全闸门

> **⚠ 部分撤回（2026-06-15）**：用户深挖边界后定论——**PR 交付的动作是工作流的肉，不进框架**。
> 据此**退役砖1（core/deliver-pr）、砖2（builtin deliver_pr 机制）、砖6（dev_declarative 示例）**：
> deliverPr 搬回 `dev/workflow.ts` 的 run_submit_pr 内联，builtin phase 机制整体删除。
> 判据：框架给骨（沙盒 + git/gh 工具 + 追踪原语 appendSubPr/poller），工作流给肉（怎么交付）。
> **保留砖3/4/5/7**（结构化输出 / judge / 声明式安全闸门 / dev 判定升级——都是真骨）。
> 零 TS 工作流走 **artifacts** 交付轴，不开箱即用 PR 交付。详见 memory `zero-ts-declarative-workflows`。
>
> 状态：设计 spec（architect + pm 压过），待评审、分刀实现。
> 日期：2026-06-14
> 产品方向锚点：**autopilot 朝「工作流可分享/分发」走**（用户 2026-06-14 拍板）。这把"声明式安全闸门"从过度设计提升为地基。

## 北极星

让用户**完全不写 TS** 就能定义一条完整的 PR 交付工作流，且**边界由框架担保**——使声明式工作流成为**可安全分享、不可越界、流程判定由框架结构化担保**的交付管线。

**为什么现在做（pm 定调）**：自用单机下"降门槛"≈伪需求（用户会写 yaml、那 534 行 TS 框架内置发的）。真价值在**安全分层**——而它只有在"工作流作者 ≠ 运行者"（分享/分发）时成立。用户已确认朝分发走 → 安全闸门是地基，不是过度设计。

## 当前已有（本会话铺完的声明式底座）

prompt 模式（agent 调用）/ `${HANDOFF}`·`${HANDOFF_<phase>}`（读上游）/ `${REJECTION}`（驳回回注）/ `decision`（marker 模式判 pass/reject + 回退+计数+触顶）/ `tools`（逐 phase 工具授权）/ `permission_mode` + sandbox / `gate` / `reject:`+`max_rejections` / runner 自动推进。

## 还差三块砖

### 砖 1 — 声明式 PR 交付（P0，独立价值最大、风险最低）

`run_submit_pr`（dev/workflow.ts ~94 行：逐库 add/diff/commit/push/ensurePr(gh)/appendSubPr/回填 pr_url）是纯框架动作、零业务逻辑、却最脏最易错。收进框架。

- **提取**：`run_submit_pr` → `src/core/deliver-pr.ts` 的 `deliverPr(taskId, opts?)`（连 `ensurePr`/`runGit`/`taskRepos` helper 一并下沉），剥掉末尾 `transition(<phase>_complete)`（交付不该知道调用它的 phase 名）。PR body 泛化：plan.md 是 dev 专属约定，core 缺省用「上游 handoff 汇总 + diff stat」，`opts.prBodyContext` 可注入。
- **内置交付 phase**（挂点：内置 phase func，不是 runner 末尾魔法——交付要进执行视图、有超时、失败走标准路径）：phase 声明 `builtin: deliver_pr`，`bindPhaseFunc` 识别后绑 `deliverPrPhase(taskId)` = `deliverPr` + `transition(complete)`。
- **衔接全复用**：`appendSubPr`（单库也落）→ pr-poller 聚合验收 / CI 自动修复 / run-outcome `hasPr` / 多库各开 PR / 部分失败抛错停下报人——一字不改。
- **dev 兼容**：dev 的 `run_submit_pr` 改薄壳 `await deliverPr(taskId); transition(...)`（行为等价、无需 sync）。

```yaml
delivers: pr               # 顶层（预检 + UI 预告，现有）
phases:
  - name: deliver
    builtin: deliver_pr    # 框架内置交付，零 TS
    timeout: 600
```

### 砖 2 — 结构化裁判 `decision.mode: judge`（分发场景的核心）

marker 模式（grep agent 散文里的 `PASS`/`REJECT`）不严谨：① 模型格式不守 ② 散文干扰预判。分发时跑**别人写的**评审，更不能信任它守格式 → 判定必须走框架担保的结构化通道。

- **机制**：review agent **自由写散文评审**（不需 marker）；框架**另起一次单次调用**（`src/agents/structured.ts` 的 `completeStructured`，**不复用 ApiAgentLoop**——裁判不碰文件、不多轮）：传 review 散文 + `criteria`，**强制 `tool_choice` 让模型必须调 `submit_verdict({verdict:"pass"|"reject", reason})`**，从 `toolCalls[0].input` 读结构化结果，**绝不 grep 散文**。
- **裁判 provider 固定**：默认 **anthropic**（已知最可靠的 tool_choice），与 review agent 是谁解耦；`decision.judge_provider` 可覆盖。缺 key / 结构化拿不到 → 重试一次 → 仍空抛错 → `ambiguous`（停下报人），**不退回 grep**（退回就破功）。
- **provider 强制结构化适配**：`AdapterOptions` 加 `tool_choice?`；anthropic `tool_choice:{type:tool}` / openai `tool_choice:{type:function}` / google `functionCallingConfig.mode:ANY`。compat 不进默认裁判池。
- **接现有链**：judge 出 `{verdict,reason}` → 喂 `phase-decision` 拆出的 `planDecisionActionFromVerdict`（把 `planDecisionAction` 的 evaluate 后半段抽成纯函数，marker/judge 共用）→ 计数/触顶/回退全复用、零状态机新增。async 调用放 prompt-runner（phase-decision 保持纯同步）。
- **字段**：`decision: { mode: "marker"|"judge"（缺省 marker）, judge_provider?, judge_model?, criteria? }`。

> 默认 marker / 还是默认 judge？**分发的声明式工作流倾向 judge**（不能信任格式）；自用/可信工作流 marker 够用更省。建议：`declarative: true` 工作流的 decision **默认 judge**，普通工作流默认 marker。（评审决策点）

### 砖 3 — `declarative: true` 安全闸门（分发的信任边界，地基）

工作流顶层 `declarative: true` → 加载时（`loadYamlWorkflow`/`bindPhaseFunc`）**硬拒任何 `run_*` TS 函数**（有则加载失败报错，非 warn）。声明式工作流的 phase 只能来自框架内置原语：`prompt`（prompt-runner）/ `builtin: deliver_pr` / `gate` / `parallel`。

意义：保证该工作流**没有任意用户代码** → 能力上界由框架钉死（tools 授权 + sandbox + 无 spawn）→ 可标记「沙盒安全」，安全地运行别人写的工作流。形成信任分层：

- **声明式工作流** = 沙盒安全、可分享/跨人运行（给"定制 PR 交付管线"的 95%）
- **TS 工作流** = 信任代码、满权限（自己写自己跑的逃生舱；分发场景需显式审核/签名）

正交于 `requires:`（输入）/`delivers:`（输出）。语义归口 `src/daemon/workflow-declarations.ts`，registry 只透传 + 加载期检测。

## 分刀落地顺序（每刀独立 PR，bun test + typecheck 绿）

> 进度（2026-06-14）：砖 1-6 已落地，全绿。砖 7/8 待人工活体 dogfood + 独立产品决策。

1. ✅ **deliverPr 提取**（内部重构、零行为变化）：`run_submit_pr` → `core/deliver-pr.ts`，dev 改薄壳。commit e1f0ce7。
2. ✅ **`builtin: deliver_pr` phase + bindPhaseFunc 识别**：内置交付 phase（`deliverPrPhase`，不 transition 靠 runner 自动推进）。commit c67af63。
3. ✅ **`completeStructured` + `AdapterOptions.tool_choice`（anthropic/openai/google）**：结构化输出底座（`src/agents/structured.ts` + `resolveApiAdapter`）。commit 03058fb。
4. ✅ **judge.ts + phase-decision/prompt-runner 接入**：judge 模式（拆 `planDecisionActionFromVerdict`，judge 失败→ambiguous 停下报人不退回 grep）。commit a85f898。
5. ✅ **declarative 闸门**：加载期硬拒 run_（`declarative: true` → workflow.ts 含函数导出即抛错；phase 只能 prompt/builtin/gate/parallel）。commit 55f6edd。
6. ✅ **dev_declarative 示例 + 静态验收**：`examples/workflows/dev_declarative/`（全声明式 design→develop→code_review(judge)→deliver(builtin)）。load-test 钉死组合。**活体 dogfood（真 agent+真 PR）留人工跑**。commit 6c7fa89。
7. ✅ **dev 判定升级（保留 TS）**：用户选「判定升级」而非整体切 declarative——dev 的 run_review/run_code_review 把 `text.includes(REVIEW_RESULT)` 标记匹配换成 `judgeVerdict`，**保留全部 diff 编排健壮性**（截断护栏/rejection 历史/逐库 stat），计数键不变。commit 8bdc6e6。配套 commit 8205de0：实测 kimi-code（用户唯一的 key）思考端点拒绝强制 tool_choice（400），加 `disable_thinking`（kimi host → `thinking:{type:disabled}`）解冲突。**⚠ shipping 待定**：judge 走 API 模式需 key，给所有 dev 用户加 API-key 依赖（claude-CLI 订阅用户也没 anthropic key）——合主前需定 shipping 默认 provider / 是否 opt-in。当前 JUDGE_PROVIDER=kimi-code 仅本机 dogfood 值。**活体 dogfood 仍待人工跑**。
8. **（更后，独立产品面）分发/分享 surface**：工作流打包/导入/跨人运行/签名——建在 1-7 的安全原语之上，单独 spec。**未做**。

## 关键回归风险（architect 清单摘要）

- deliverPr 的 PR body 来源泛化 → dev 薄壳传 plan.md 作 `prBodyContext` 保行为等价。
- judge 固定 anthropic 但用户没配 key → 抛清晰错 → ambiguous 停下报人，不静默降级。
- tool_choice 在某 compat 端点被忽略 → 重试 → 仍空抛错 → ambiguous（不 grep 兜底，保 judge 承诺）。
- declarative 闸门只对 `declarative:true` 生效；dev（不声明）不受影响。
- judge async 不破坏纯函数测试：拆 `planDecisionActionFromVerdict` 同步纯函数。
- run-outcome `hasPr` 时序：deliver_pr 是真实 phase，跑完才推进终态，hasPr 自然成立（与现 submit_pr 同时序）。

## 评审决策点

1. **judge 默认开还是 opt-in**：建议 `declarative:true` 工作流默认 judge、普通工作流默认 marker。（pm 倾向全局 opt-in；分发承诺后我倾向声明式默认 judge）
2. **declarative 闸门本期就做还是等分发 surface**：分发已承诺 → 建议本期做（它是安全原语前置，且独立可测），但分发 surface 本身缓做。
3. **dev 是否本期切 declarative**：否，先 dev_declarative 示例并存，dogfood 后迁（决策点 7）。
4. PR body 泛化的缺省内容（handoff 汇总 + diff stat）是否够用，还是需要一个内置「写 PR 描述」的轻 agent 步骤。

## 关键文件影响（architect）

```
src/agents/providers/api/types.ts        [改 AdapterOptions.tool_choice]
src/agents/providers/api/{anthropic,openai,google}.ts  [改 body 透传 tool_choice]
src/agents/structured.ts                  [新 completeStructured]
src/agents/registry.ts                    [抽 createProviderAdapter/resolveApiKey 复用]
src/core/judge.ts                         [新 judgeVerdict]
src/core/phase-decision.ts                [PhaseDecision 加 mode/judge_*；拆 planDecisionActionFromVerdict]
src/core/prompt-runner.ts                 [decision 块按 mode 分流，judge 走 await]
src/core/deliver-pr.ts                    [新 deliverPr + deliverPrPhase（搬 run_submit_pr）]
src/core/registry.ts                      [bindPhaseFunc 识别 builtin:deliver_pr + declarative 闸门]
examples/workflows/dev/workflow.ts        [run_submit_pr → 薄壳]
examples/workflows/dev_declarative/       [新示例]
```
