# Vision 输入设计（需求附件图像 → clarifier + 执行 agent 看懂）

- 日期：2026-06-16
- 状态：设计待评审（brainstorming → 待 writing-plans）
- 范围：让用户给需求附的图像/截图/mockup 被 **clarifier** 和 **执行 agent** 看懂，覆盖 **所有 provider**（CLI: claude/codex/gemini + API 直连: anthropic/openai/google/compat）

## 1. 背景与动机

本设计源自一次「调研 TanStack/ai 是否有可借鉴处」的讨论。结论是两者定位正交（TanStack = chat/多模态 SDK，autopilot = 任务编排引擎），但其中一个真实可借鉴的方向是「**统一封装不同供应商的能力**」。autopilot 其实已有两套 provider 抽象（CLI `BaseProvider` + API `ProviderAdapter`），用户进一步提出「要兼容更多类型」。

拆解「更多类型」后，落到三个候选能力：**Vision 输入**、**Embedding/RAG**、**生成输出**。经讨论：

- **Embedding/RAG 被降级到 backlog**：autopilot 是「本地 runner，每人各自装、各自一个 SQLite 库、无共享语料」，相似需求检索的价值强依赖「库规模 × 时间 × 协作人数」，而协作人数恒为 1、库通常小，价值后置。设计已想清（见本仓 git 历史讨论），留待「库变大 / 将来云端共享语料」时再做。
- **Vision 输入被选为第一刀**：它 **day-one 单人就有用、零语料积累依赖**——附一张 mockup，第一条需求就受益，恰好绕开本地单人短板。

> 澄清：Vision（模态轴）与 RAG（应用模式，依赖 embedding 活动）是**两条独立的轴**，不是一回事。本设计只做 Vision，不含 embedding。

## 2. 目标 / 非目标

### 目标
- 用户给需求上传图像附件（已有上传能力）后，**clarifier 能看懂图**（理解需求、提精准问题）。
- **执行 agent 能看到原图**（按 mockup 像素级还原，而非只拿蒸馏后的文字 spec）——这是「附 mockup → 照着实现」的核心价值缺口。
- 覆盖**所有 provider 路径**：CLI（claude/codex/gemini）+ API 直连（anthropic/openai/google/compat）。

### 非目标
- ❌ Embedding / 语义检索 / RAG（已降级 backlog）。
- ❌ 生成类输出（image/audio/video 产出，backlog）。
- ❌ 多模态 RAG（embed 图像做按图检索，进阶，backlog）。
- ❌ 通用 `activity × adapter` 注册表的提前抽象——Vision 走「模态轴」（扩 `ContentBlock`），不需要新建活动注册表；等第 N 个能力到了再抽。

## 3. 现状（四面映射结论）

来源：本仓 2026-06-16 的现状映射（附件 / clarifier 附件流 / API adapter 多模态面 / CLI 传图）。

### 3.1 附件子系统（已存在）
- `src/core/requirements/attachments.ts`：`saveAttachment` 落盘到 `AUTOPILOT_HOME/attachments/<reqId>/<att-NNN><ext>`，元数据进表 `requirement_attachments`（迁移 032）。
- 表列：`id`(att-NNN) / `requirement_id`(FK CASCADE) / `original_name` / `mime_type` / `file_path`(绝对路径) / `file_size` / `category`('image'|'text'|'pdf'|'office') / `extracted_text`(图像=NULL) / `created_at`。
- 图像白名单 `IMAGE_MIMES` = png/jpeg/webp/gif（无 svg/bmp/heic/tiff）。非图像在上传时 `extractText` 抽成文本存 `extracted_text`（≤100KB）。
- HTTP 上传/列出/删除：`routes.ts:880-948`。Web：`AttachmentUploader.tsx` / `AttachmentList.tsx`。**CLI 无附件命令**。

### 3.2 clarifier 现状（重要修正）
- clarifier 默认 `provider=anthropic`，而 autopilot 的 **Anthropic provider = spawn `claude` CLI**（不是 API 直连）。
- `buildAttachmentContext`（attachments.ts:253）对图像 = 把**磁盘路径 + 「请用 Read 工具读取分析」**注入 prompt；文本类内联 `extracted_text`。
- 因此「clarifier 看懂图」**今天在默认 claude CLI 路径下基本已工作**（Claude Code CLI 的 Read 工具原生支持读图）。**唯一待验证**：`bypassPermissions` 下 claude Read 能否读到 clone 根之外的附件绝对路径（大概率能）。

### 3.3 执行链现状（核心缺口）
- 附件**唯一消费方是 clarifier**。执行链（`requirement-scheduler.ts` 组装 `requirement` 文本 → `prompt-runner.ts:132` 的 `REQUIREMENT` 变量）**完全不引用附件**。
- 结果：**写代码的 agent 永远看不到原图**，且附件文件不在 task 沙盒内。

### 3.4 API 直连路径现状
- `api/types.ts` 的 `ContentBlock.type` 仅 `"text"|"tool_use"`，**无 image**；`loop.ts:204` 用 `content: prompt`（纯字符串）。
- 三家 adapter `convertMessages` 把 user 内容当字符串透传（openai.ts:209 / google.ts:182 硬编码 `as string`；anthropic.ts:204 数组透传）。
- `read_file`（tools.ts）对图像返回乱码文本；`assertInSandbox` 拒读沙盒外路径（附件在沙盒外）。
- `estimateTokens`（loop.ts:51）不计图像块。
- **结论**：API 路径零视觉能力，需补完整多模态管道。

### 3.5 能力门控现状
- `model-list.ts` 的 CATALOG 只是 string[]；`tool-capabilities.ts` 是工具授权词汇表——**都没有「图像输入」这种模型能力概念**。用户可填任意 model 串；compat 端点（Kimi 等）不一定支持视觉，发图会 400。

## 4. 关键决策（锁定）

| 决策 | 选定 | 理由 |
|---|---|---|
| 图走多远 | clarifier + **执行 agent** + 全 provider | 兑现「mockup → 照着实现」核心价值 |
| 沙盒可达性 | **附件 copy 物化进沙盒** | CLI/API 都能按 in-sandbox 路径稳定访问；不破 `assertInSandbox` 边界、不依赖隔离 home 放行 |
| image block 形状 | **中性** `{type:"image", media_type, data?, url?}` | 避免某家 API 命名反渗内核类型；adapter 负责翻译 |
| 降级策略 | **A 停下报人（默认）+ C AI 描述兜底（opt-in 配置）** | 含图需求落到非视觉 provider 时不盲做（符合「撞墙不失忆」）；C 给想要全 provider 可用的用户 |
| 上传预处理 | 大图**压缩/缩放**送模型，原图留下载 | 控 token / 防 413 |
| 实现节奏 | **分两阶段**（Phase 1 CLI + 地基先发；Phase 2 API 多模态） | 高价值低风险先落地，避免大爆炸 |

## 5. 架构设计

### 5.1 地基（共享 plumbing）
- **中性 image block**：`src/agents/providers/api/types.ts` 的 `ContentBlock` 加 `"image"` 变体：
  ```ts
  // type: "text" | "tool_use" | "image"
  image?: { media_type: string; data?: string /*base64*/; url?: string };
  ```
  `MessageParam.content` 联合类型无需改（`ContentBlock[]` 已能容纳）。
- **附件物化**：新 helper（建议落 `src/core/requirements/attachments.ts` 或 `src/core/sandbox/`）：
  - `materializeAttachments(reqId, sandboxRoot): MaterializedAttachment[]` —— 把该需求图像附件 copy 进 `<sandboxRoot>/.autopilot/attachments/`，返回 in-sandbox 相对/绝对路径 + 元数据。
  - `loadImageAsBase64(path): { media_type, data }` —— 供 API 路径读盘转 base64。
- **入参**：`RunOptions`/`ChatOptions`（`src/agents/types.ts`）加可选 `images?: ImageRef[]`（path 或 base64），或由上层直接构造 `ContentBlock[]` 传入 loop。

### 5.2 能力门控 + 降级
- `modelSupportsVision(provider, model, base_url): boolean` —— 前缀白名单 + **端点级**判定（compat 按 base_url 细分，Kimi 等默认保守 false）。放哪、用什么机制由实现阶段定（白名单/显式配置；避免与 `tool-capabilities.ts` 语义混淆——这是「模型能力」非「工具授权」）。
- **降级**：含图需求 + 选定 provider/model 不支持视觉时：
  - **默认 A**：调度/执行前检出 → 停下报人（转 failed + `status_reason`「provider 不支持视觉，换 provider 或移除图像」），不盲做。
  - **opt-in C**：配置开启后，用一个视觉 provider 把图转 AI 描述文本，注入给非视觉 provider（丢像素精度、多一次视觉调用、需配视觉 provider）。
- clarifier 默认 claude（视觉可用），通常不触发降级。

### 5.3 CLI 路径（claude/codex/gemini）
- 复用 `buildAttachmentContext` 的 path+Read 模式，但**指向物化后的 in-sandbox 路径**（不再是 `AUTOPILOT_HOME/attachments/`）。
- **执行接入（两种落点，取舍见 §9 风险4 / §10）**：task 启动时调 `materializeAttachments`，再二选一注入物化路径 + Read 指令——
  - ① **scheduler 组装 `requirement` 文本时自动追加附件段（默认推荐）**：老 workflow 副本零感知、不需 sync。
  - ② `prompt-runner.ts` 新增 `${ATTACHMENTS}` 内建变量：分层更干净（内核透传形状、工作流消费），但老副本模板无此变量需 `workflow sync dev`。
  - 默认走 ①，避免老副本失效；②留作工作流想显式控制附件位置时的可选项。
- **clarifier**：已工作（claude）；改指物化路径；**实测验证** claude Read 读 in-sandbox 路径。
- **codex/gemini 读图能力未证实** → 实测；不支持则走 §5.2 门控（默认停下报人）。

### 5.4 API 路径（Phase 2）
- 三家 adapter `convertMessages` 翻译 image block：
  - anthropic（api/anthropic.ts）：`{type:"image", source:{type:"base64", media_type, data}}`
  - openai（api/openai.ts:209）：user 数组化，image→`{type:"image_url", image_url:{url:"data:<mime>;base64,<data>"}}`
  - google（api/google.ts:182）：image→`{inlineData:{mimeType, data}}`
- `loop.ts:204`：有图时 user message `content` 构造为 `ContentBlock[]`（文本块 + 图像块）；附件读盘转 base64。
- `estimateTokens`（loop.ts:51）补图像计量（每图固定估值 + 体积加权），避免裁剪失真。
- 发送前过 §5.2 门控（非视觉端点不发图）。

### 5.5 上传预处理
- 上传或物化时对大图压缩/缩放（限最大边 + 重编码 webp/jpeg）。原图留作下载，送模型用压缩版（控 token / 防 413）。

### 5.6 生命周期
- 图像随 spec 在审批后冻结（failed 例外可改，同 spec 语义）。每次 run 重新 `materializeAttachments`（沙盒重建后）。
- 沿用 `requirement_attachments` 的 FK CASCADE，删需求自动清元数据；物化副本随沙盒清理。

## 6. 数据与类型变更
- `api/types.ts`：`ContentBlock` 加 `image` 变体（中性形状）。
- `agents/types.ts`：`RunOptions`/`ChatOptions` 加可选 `images?`。
- **无新表 / 无迁移**（复用现有 `requirement_attachments`）。
- 新增能力判定模块（`modelSupportsVision`）。

## 7. 分阶段实现计划

### Phase 1 — CLI 路径 + 地基（先发，高价值低风险）
1. 中性 `ContentBlock.image` 类型（仅类型，Phase 2 才有 adapter 消费）。
2. `materializeAttachments` + 上传预处理（压缩）。
3. 执行链注入：`prompt-runner` `${ATTACHMENTS}` 变量 + task 启动物化。
4. clarifier 改指物化路径 + 实测 claude 读图。
5. 能力门控 + 默认 A 降级（含图需求落非视觉 provider → 停下报人）。
6. codex/gemini 读图实测，定降级。
- **交付**：mockup 到达 claude（及读图可用的 CLI）执行 agent。

### Phase 2 — API 多模态管道
1. 三家 API adapter `convertMessages` image 翻译。
2. `loop.ts` content 构造 + base64 + `estimateTokens` 图像计量。
3. opt-in C（AI 描述兜底）。
- **交付**：openai/google/compat + judge/结构化的 API 路径视觉。

## 8. 测试策略（bun:test，依赖注入，不碰全局 mock）
- 三家 adapter image block → 正确 provider JSON 的翻译单测（纯函数化 `convertMessages` 后好测）。
- `estimateTokens` 图像计量。
- `modelSupportsVision`：视觉模型放行 / 非视觉端点（Kimi compat）拦截。
- `materializeAttachments`：附件 copy 进沙盒、路径正确、清理。
- `buildAttachmentContext` 指向 in-sandbox 路径。
- 降级路径：含图 + 非视觉 provider → 默认转 failed + status_reason。
- 上传预处理：大图压缩后尺寸/格式正确，原图保留。

## 9. 风险与开放问题
1. **codex/gemini CLI 读图未证实**——Phase 1 必须实测；不支持的 CLI 走默认停下报人（或后续上 C）。
2. **per-model/端点 vision 白名单维护**——模型迭代需追更；保守默认 false 避免误发 400。倾向「白名单前缀 + 显式 config 覆盖」，不做运行时探测（轻量优先）。
3. **图像 token 预算**——大截图 base64 撑大请求体；预处理压缩 + `estimateTokens` 计量双保险；仍可能撞单家上限，需各 provider 上限保护。
4. **物化副本污染沙盒**——放 `.autopilot/` 子目录隔离，随沙盒清理；注意别被 workflow 的 `git add -A` 误提交（加 .gitignore 规则或放沙盒外侧）。
5. **clarifier 走 CLI vs API 的一致性**——默认 claude CLI 用 path+Read，openai/google clarifier 走 API 路径需 Phase 2 的多模态；Phase 1 期间非 claude clarifier 的含图需求走门控降级。

## 10. 上线 / 迁移安全
- 无 schema 迁移；纯加类型 + 行为。
- 没传图像附件的需求**零行为变化**。
- Phase 1 独立可上，不依赖 Phase 2。
- 老 dev workflow 副本：若执行注入靠 `${ATTACHMENTS}` 变量，老副本模板无此变量则不显示附件（向后兼容，可 `workflow sync dev` 拿新模板）；若靠 scheduler 自动追加 `requirement` 文本则老副本零感知。**实现阶段二选一时优先「scheduler 自动追加」以免老副本失效**。
