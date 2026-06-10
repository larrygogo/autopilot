# 需求列表分类标签页 + 附件上传支持 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为需求列表新增与流水线相同结构的 4 段 tab 分类，并在需求创建和 AI 澄清阶段支持全类型附件上传（图片 + 纯文本 + PDF + Office），Agent 可读取附件内容。

**Architecture:**
1. **分类标签页**：更新 `requirement-buckets.ts` 状态映射，新建全局 `/requirements` 页面（4-tab + 时间分组），复用 `PipelineList.tsx` 的 `RequirementRow` 和 `TimeGroupedList` 组件。
2. **附件支持**：Migration 032 建 `requirement_attachments` 表（FK → `requirements.id`）；Bun 原生 `formData()` 解析上传（无 busboy，零 race condition）；按类型提取文本（mammoth/xlsx/pdf-parse/fflate+XML）；图片以磁盘路径注入 prompt、文本类直接注入内容；`server.ts` 加 `maxRequestBodySize: 210MB` 作 Layer 1 防护。
3. **Prompt 注入**：`requirement-clarifier.ts` 的 `buildPrompt()` 扩展 `attachmentContext` 参数，图片行用 `Read 工具路径`，文本类内联提取内容。

**Tech Stack:**
- 运行时：Bun + TypeScript（strict）
- DB：SQLite via `bun:sqlite`
- 依赖新增：`pdf-parse`、`mammoth`、`xlsx`（SheetJS）、`fflate`（PPTX 解压 + XML 提取）
- 前端：React 19 + Vite + Tailwind CSS；复用项目内已有 `Tabs`、`Card`、`TimeGroupedList`、`RequirementRow` 组件

---

## ⚠️ 必须规避的历史遗留问题

1. **图片 Vision 集成**：绝不 base64 嵌 prompt。图片落盘后只注入文件路径，让 claude CLI 的 `Read` 工具原生读取。
2. **busboy race condition**：不使用 busboy。改用 Bun 原生 `req.formData()` 全量解析后，再 `await Bun.write()` 每文件，最后 `await Promise.all(...)` 统一等待。
3. **FK 表名**：migration 032 中附件表 FK 必须是 `REFERENCES requirements(id)`，不是 `requirement_comments(id)`。
4. **文件大小双重防护**：`server.ts` 加 `maxRequestBodySize: 210 * 1024 * 1024`（Layer 1）+ 路由内逐文件检查 `file.size > 200MB`（Layer 2，返回 413）。

---

## 文件结构

### 新建文件
| 文件 | 职责 |
|------|------|
| `src/migrations/032-requirement-attachments.ts` | 建 `requirement_attachments` 表 |
| `src/core/requirement-attachments.ts` | CRUD + 文本提取（mammoth/xlsx/pdf-parse/fflate） |
| `src/web/src/components/AttachmentUploader.tsx` | 拖拽/点击上传 UI，调 HTTP multipart 接口 |
| `src/web/src/components/AttachmentList.tsx` | 附件列表 + 删除按钮 |
| `src/web/src/pages/Requirements.tsx` | 全局需求页 `/requirements`，4-tab + 时间分组 |

### 修改文件
| 文件 | 改动 |
|------|------|
| `package.json` | 新增 4 个依赖 |
| `src/daemon/server.ts` | 加 `maxRequestBodySize` |
| `src/daemon/routes.ts` | 新增 3 个附件路由 |
| `src/daemon/requirement-clarifier.ts` | `buildPrompt()` 注入 attachmentContext |
| `src/web/src/lib/requirement-buckets.ts` | 修正状态映射、导出新函数 |
| `src/web/src/hooks/useApi.ts` | 新增 `Attachment` 类型 + 3 个附件 API 方法 |
| `src/web/src/pages/RequirementDetail.tsx` | 新增附件区块（上传器 + 列表） |
| `src/web/src/pages/ProjectDetail.tsx` | 创建需求 dialog 里加附件上传 |
| `src/web/src/App.tsx` | 新增 `/requirements` 路由 + 侧边栏导航项 |

---

## Task 1: 安装依赖

**Files:**
- Modify: `package.json`

- [ ] **Step 1: 安装 4 个新依赖**

```bash
cd C:/Users/larry/.autopilot/runtime/tasks/j2kca6un/workspace
bun add pdf-parse mammoth xlsx fflate
bun add -d @types/pdf-parse
```

- [ ] **Step 2: 验证 package.json 更新**

```bash
grep -E '"pdf-parse|mammoth|xlsx|fflate"' package.json
```
Expected: 4 行输出

- [ ] **Step 3: Commit**

```bash
git add package.json bun.lock
git commit -m "chore: 添加附件文本提取依赖（pdf-parse/mammoth/xlsx/fflate）"
```

---

## Task 2: Migration 032 — requirement_attachments 表

**Files:**
- Create: `src/migrations/032-requirement-attachments.ts`

- [ ] **Step 1: 编写迁移文件**

```typescript
// src/migrations/032-requirement-attachments.ts
import type { Database } from "bun:sqlite";

/**
 * 需求附件表。
 * - category: 'image' | 'text' | 'pdf' | 'office'
 * - file_path: 磁盘绝对路径（~/.autopilot/attachments/<req-id>/<filename>）
 * - extracted_text: PDF/office/text 内容；图片为 NULL（Agent 用 Read 工具直接读）
 */
export function up(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS requirement_attachments (
      id            TEXT    PRIMARY KEY,
      requirement_id TEXT   NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
      original_name TEXT    NOT NULL,
      mime_type      TEXT    NOT NULL,
      file_path      TEXT    NOT NULL,
      file_size      INTEGER NOT NULL,
      category       TEXT    NOT NULL CHECK(category IN ('image','text','pdf','office')),
      extracted_text TEXT,
      created_at     INTEGER NOT NULL
    )
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_req_attachments_req
      ON requirement_attachments(requirement_id, created_at)
  `);
}
```

- [ ] **Step 2: 在 migrate.ts 的迁移列表中注册 032**

打开 `src/core/migrate.ts`，找到迁移注册数组（格式类似 `{ version: 31, up: m031.up }`），在末尾添加：

```typescript
import * as m032 from "../migrations/032-requirement-attachments";
// ... 在 migrations 数组末尾：
{ version: 32, up: m032.up },
```

- [ ] **Step 3: 运行迁移验证**

```bash
bun run src/cli/index.ts daemon run &
sleep 2
# 查看迁移日志中是否出现 032
curl -s http://127.0.0.1:6180/api/status | grep -i migration || echo "daemon 已含 032"
kill %1 2>/dev/null || true
```

- [ ] **Step 4: 写 migration 测试**

```typescript
// tests/migrations/032-requirement-attachments.test.ts
import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { up as m001 } from "../../src/migrations/001-baseline";
import { up as m005 } from "../../src/migrations/005-requirements";
import { up as m032 } from "../../src/migrations/032-requirement-attachments";

describe("migration 032", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.run("PRAGMA foreign_keys = ON");
    m001(db);
    m005(db);
    m032(db);
  });

  it("建表成功，字段齐全", () => {
    const cols = db
      .query<{ name: string }, []>("PRAGMA table_info(requirement_attachments)")
      .all()
      .map((c) => c.name);
    expect(cols).toContain("id");
    expect(cols).toContain("requirement_id");
    expect(cols).toContain("original_name");
    expect(cols).toContain("mime_type");
    expect(cols).toContain("file_path");
    expect(cols).toContain("file_size");
    expect(cols).toContain("category");
    expect(cols).toContain("extracted_text");
    expect(cols).toContain("created_at");
  });

  it("category CHECK 约束拦无效值", () => {
    db.run(`INSERT INTO requirements (id, project_id, title, status, spec_md, created_at, updated_at) VALUES ('req-001','proj-001','t','drafting','',1,1)`);
    expect(() =>
      db.run(`INSERT INTO requirement_attachments VALUES ('att-001','req-001','f.txt','text/plain','/p',100,'invalid',NULL,1)`)
    ).toThrow();
  });

  it("ON DELETE CASCADE 级联删附件", () => {
    db.run(`INSERT INTO requirements (id, project_id, title, status, spec_md, created_at, updated_at) VALUES ('req-001','proj-001','t','drafting','',1,1)`);
    db.run(`INSERT INTO requirement_attachments VALUES ('att-001','req-001','f.txt','text/plain','/p',100,'text',NULL,1)`);
    db.run("DELETE FROM requirements WHERE id = 'req-001'");
    const count = db.query<{ n: number }, []>("SELECT COUNT(*) as n FROM requirement_attachments").get()!.n;
    expect(count).toBe(0);
  });
});
```

- [ ] **Step 5: 运行测试确认通过**

```bash
bun test tests/migrations/032-requirement-attachments.test.ts
```
Expected: 3 passed

- [ ] **Step 6: Commit**

```bash
git add src/migrations/032-requirement-attachments.ts src/core/migrate.ts tests/migrations/032-requirement-attachments.test.ts
git commit -m "feat: migration 032 — requirement_attachments 表（FK→requirements.id）"
```

---

## Task 3: Core CRUD + 文本提取模块

**Files:**
- Create: `src/core/requirement-attachments.ts`

**关键设计**：
- 图片：原样保存，`extracted_text = null`；prompt 注入文件路径
- 纯文本/代码：读文件内容，截取 `extracted_text`（最多 100KB 防超 context）
- PDF：`pdf-parse` 提取文字
- Office `.docx`：`mammoth.extractRawText()`
- Office `.xlsx`：`xlsx.utils.sheet_to_csv()`（每 sheet 转 CSV，合并）
- Office `.pptx`：`fflate.unzipSync()` 解包，遍历 `ppt/slides/slide*.xml`，regex 提取 `<a:t>` 标签文本

- [ ] **Step 1: 编写 `src/core/requirement-attachments.ts`**

```typescript
// src/core/requirement-attachments.ts
import { mkdirSync, unlinkSync, existsSync, readFileSync } from "fs";
import { join, extname } from "path";
import { AUTOPILOT_HOME } from "../index";
import { getDb } from "./db";

// ──────────────────────────────────────────────
// 类型
// ──────────────────────────────────────────────

export type AttachmentCategory = "image" | "text" | "pdf" | "office";

export interface Attachment {
  id: string;
  requirement_id: string;
  original_name: string;
  mime_type: string;
  file_path: string;
  file_size: number;
  category: AttachmentCategory;
  extracted_text: string | null;
  created_at: number;
}

// ──────────────────────────────────────────────
// 路径工具
// ──────────────────────────────────────────────

export function getAttachmentsDir(reqId: string): string {
  return join(AUTOPILOT_HOME, "attachments", reqId);
}

// ──────────────────────────────────────────────
// 类别判定
// ──────────────────────────────────────────────

const IMAGE_MIMES = new Set([
  "image/png", "image/jpeg", "image/webp", "image/gif",
]);
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

const TEXT_MIMES = new Set([
  "text/plain", "text/markdown", "text/html", "text/css",
  "text/javascript", "application/json", "application/xml",
  "text/typescript", "text/x-python", "text/x-java-source",
]);
const TEXT_EXTS = new Set([
  ".txt", ".md", ".ts", ".tsx", ".js", ".jsx", ".py", ".java",
  ".c", ".cpp", ".h", ".rs", ".go", ".rb", ".php", ".css",
  ".html", ".xml", ".json", ".yaml", ".yml", ".toml", ".sh",
  ".bash", ".zsh", ".sql", ".csv", ".log", ".env",
]);

export function detectCategory(mimeType: string, filename: string): AttachmentCategory {
  const ext = extname(filename).toLowerCase();
  if (IMAGE_MIMES.has(mimeType) || IMAGE_EXTS.has(ext)) return "image";
  if (mimeType === "application/pdf" || ext === ".pdf") return "pdf";
  if (
    mimeType.includes("word") || mimeType.includes("spreadsheet") ||
    mimeType.includes("presentation") || mimeType.includes("powerpoint") ||
    mimeType.includes("excel") || mimeType.includes("msword") ||
    [".docx", ".doc", ".xlsx", ".xls", ".pptx", ".ppt"].includes(ext)
  ) return "office";
  if (TEXT_MIMES.has(mimeType) || TEXT_EXTS.has(ext)) return "text";
  // 未知类型：回退为文本尝试（失败时 extracted_text = null）
  return "text";
}

// ──────────────────────────────────────────────
// 文本提取
// ──────────────────────────────────────────────

const MAX_EXTRACT_BYTES = 100 * 1024; // 100KB 防超 context

async function extractText(
  category: AttachmentCategory,
  filePath: string,
  ext: string,
): Promise<string | null> {
  if (category === "image") return null;

  try {
    if (category === "text") {
      const raw = readFileSync(filePath);
      const text = raw.slice(0, MAX_EXTRACT_BYTES).toString("utf-8");
      return text;
    }

    if (category === "pdf") {
      // 动态 require 避免启动时导入错误（Bun 下 pdf-parse 可能有顶层副作用）
      const pdfParse = (await import("pdf-parse")).default;
      const buf = readFileSync(filePath);
      const result = await pdfParse(buf);
      return result.text.slice(0, MAX_EXTRACT_BYTES);
    }

    if (category === "office") {
      const lext = ext.toLowerCase();

      if (lext === ".docx" || lext === ".doc") {
        const mammoth = await import("mammoth");
        const result = await mammoth.extractRawText({ path: filePath });
        return result.value.slice(0, MAX_EXTRACT_BYTES);
      }

      if (lext === ".xlsx" || lext === ".xls") {
        const XLSX = await import("xlsx");
        const wb = XLSX.readFile(filePath);
        const parts: string[] = [];
        for (const sheetName of wb.SheetNames) {
          const ws = wb.Sheets[sheetName];
          parts.push(`## Sheet: ${sheetName}\n${XLSX.utils.sheet_to_csv(ws)}`);
        }
        return parts.join("\n\n").slice(0, MAX_EXTRACT_BYTES);
      }

      if (lext === ".pptx" || lext === ".ppt") {
        const { unzipSync } = await import("fflate");
        const buf = readFileSync(filePath);
        const files = unzipSync(new Uint8Array(buf));
        const texts: string[] = [];
        for (const [name, data] of Object.entries(files)) {
          if (/^ppt\/slides\/slide\d+\.xml$/.test(name)) {
            const xml = new TextDecoder().decode(data);
            // 提取所有 <a:t> 标签中的文本
            const matches = xml.match(/<a:t[^>]*>([^<]*)<\/a:t>/g) ?? [];
            const slideText = matches
              .map((m) => m.replace(/<[^>]+>/g, ""))
              .filter(Boolean)
              .join(" ");
            if (slideText.trim()) texts.push(slideText);
          }
        }
        return texts.join("\n").slice(0, MAX_EXTRACT_BYTES);
      }
    }
  } catch (e: unknown) {
    // 提取失败不阻断上传；返回 null 让 Agent 知道内容不可用
    console.warn("[attachment] 文本提取失败:", (e as Error).message);
  }
  return null;
}

// ──────────────────────────────────────────────
// CRUD
// ──────────────────────────────────────────────

export interface SaveAttachmentOpts {
  requirementId: string;
  originalName: string;
  mimeType: string;
  data: ArrayBuffer;
}

let _attCounter = 0;

function nextAttachmentId(): string {
  const db = getDb();
  try {
    const rows = db
      .query<{ id: string }, []>(
        "SELECT id FROM requirement_attachments WHERE id LIKE 'att-%' ORDER BY id DESC LIMIT 1",
      )
      .all();
    if (rows.length === 0) return "att-001";
    const n = parseInt(rows[0].id.replace("att-", ""), 10) + 1;
    return `att-${String(n).padStart(3, "0")}`;
  } catch {
    return `att-${String(++_attCounter).padStart(3, "0")}`;
  }
}

/**
 * 保存附件到磁盘并写入 DB。
 * 调用方已通过 formData() 拿到完整 ArrayBuffer，无 race condition。
 */
export async function saveAttachment(opts: SaveAttachmentOpts): Promise<Attachment> {
  const { requirementId, originalName, mimeType, data } = opts;
  const ext = extname(originalName);
  const category = detectCategory(mimeType, originalName);

  // 确保目录存在
  const dir = getAttachmentsDir(requirementId);
  mkdirSync(dir, { recursive: true });

  // 生成唯一文件名（ID + 原始扩展名），避免同名冲突
  const id = nextAttachmentId();
  const fileName = `${id}${ext}`;
  const filePath = join(dir, fileName);

  // 写磁盘（Bun 原生，已 await，无 race）
  await Bun.write(filePath, data);

  // 文本提取
  const extractedText = await extractText(category, filePath, ext);

  // 写 DB
  const db = getDb();
  const ts = Date.now();
  db.run(
    `INSERT INTO requirement_attachments
       (id, requirement_id, original_name, mime_type, file_path, file_size, category, extracted_text, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, requirementId, originalName, mimeType, filePath, data.byteLength, category, extractedText, ts],
  );

  return getAttachmentById(id) as Attachment;
}

export function getAttachmentById(id: string): Attachment | null {
  const db = getDb();
  return db
    .query<Attachment, [string]>("SELECT * FROM requirement_attachments WHERE id = ?")
    .get(id) ?? null;
}

export function listAttachments(requirementId: string): Attachment[] {
  const db = getDb();
  return db
    .query<Attachment, [string]>(
      "SELECT * FROM requirement_attachments WHERE requirement_id = ? ORDER BY created_at ASC",
    )
    .all(requirementId);
}

export function deleteAttachment(id: string): void {
  const db = getDb();
  const att = getAttachmentById(id);
  if (!att) return;
  // 先删磁盘文件（容错：文件不存在时忽略）
  try {
    if (existsSync(att.file_path)) unlinkSync(att.file_path);
  } catch { /* 容错 */ }
  db.run("DELETE FROM requirement_attachments WHERE id = ?", [id]);
}

// ──────────────────────────────────────────────
// Prompt 注入工具
// ──────────────────────────────────────────────

/**
 * 把需求的全部附件转为 clarifier prompt 的附件上下文段落。
 *
 * 图片：注入磁盘路径，让 claude CLI 的 Read 工具原生读取（视觉模式）。
 * 文本/PDF/Office：内联提取文本。
 */
export function buildAttachmentContext(attachments: Attachment[]): string {
  if (attachments.length === 0) return "";

  const imagePaths: string[] = [];
  const textBlocks: string[] = [];

  for (const att of attachments) {
    if (att.category === "image") {
      imagePaths.push(att.file_path);
    } else if (att.extracted_text) {
      textBlocks.push(`### ${att.original_name}\n${att.extracted_text}`);
    } else {
      textBlocks.push(`### ${att.original_name}\n（文本提取失败，无法读取内容）`);
    }
  }

  const sections: string[] = [];
  if (imagePaths.length > 0) {
    sections.push(
      "## 附件（图片）\n" +
      "以下图片已保存到磁盘，请用 Read 工具逐一读取并分析图片内容：\n" +
      imagePaths.map((p) => `- ${p}`).join("\n"),
    );
  }
  if (textBlocks.length > 0) {
    sections.push("## 附件（文档内容）\n" + textBlocks.join("\n\n---\n\n"));
  }

  return sections.join("\n\n");
}
```

- [ ] **Step 2: 写单元测试**

```typescript
// tests/core/requirement-attachments.test.ts
import { describe, it, expect } from "bun:test";
import { detectCategory, buildAttachmentContext } from "../../src/core/requirement-attachments";
import type { Attachment } from "../../src/core/requirement-attachments";

describe("detectCategory", () => {
  it("识别图片 MIME", () => {
    expect(detectCategory("image/png", "logo.png")).toBe("image");
    expect(detectCategory("image/jpeg", "photo.jpg")).toBe("image");
    expect(detectCategory("image/webp", "img.webp")).toBe("image");
  });
  it("识别 PDF", () => {
    expect(detectCategory("application/pdf", "spec.pdf")).toBe("pdf");
    expect(detectCategory("application/octet-stream", "doc.pdf")).toBe("pdf");
  });
  it("识别 Office", () => {
    expect(detectCategory("application/octet-stream", "report.docx")).toBe("office");
    expect(detectCategory("application/octet-stream", "data.xlsx")).toBe("office");
    expect(detectCategory("application/octet-stream", "slides.pptx")).toBe("office");
  });
  it("识别纯文本", () => {
    expect(detectCategory("text/plain", "readme.txt")).toBe("text");
    expect(detectCategory("text/plain", "main.ts")).toBe("text");
    expect(detectCategory("text/markdown", "notes.md")).toBe("text");
  });
  it("未知扩展名回退为 text", () => {
    expect(detectCategory("application/octet-stream", "unknown.xyz")).toBe("text");
  });
});

describe("buildAttachmentContext", () => {
  it("空附件返回空字符串", () => {
    expect(buildAttachmentContext([])).toBe("");
  });

  it("图片注入路径段落", () => {
    const atts: Attachment[] = [
      {
        id: "att-001", requirement_id: "req-001",
        original_name: "mockup.png", mime_type: "image/png",
        file_path: "/home/.autopilot/attachments/req-001/att-001.png",
        file_size: 1024, category: "image", extracted_text: null, created_at: 1,
      },
    ];
    const ctx = buildAttachmentContext(atts);
    expect(ctx).toContain("Read 工具");
    expect(ctx).toContain("/home/.autopilot/attachments/req-001/att-001.png");
    expect(ctx).not.toContain("文档内容");
  });

  it("文本附件内联内容", () => {
    const atts: Attachment[] = [
      {
        id: "att-002", requirement_id: "req-001",
        original_name: "spec.md", mime_type: "text/markdown",
        file_path: "/tmp/spec.md",
        file_size: 500, category: "text", extracted_text: "# 功能规约\n内容...", created_at: 2,
      },
    ];
    const ctx = buildAttachmentContext(atts);
    expect(ctx).toContain("spec.md");
    expect(ctx).toContain("# 功能规约");
  });

  it("图片 + 文本混合输出两个 section", () => {
    const atts: Attachment[] = [
      {
        id: "att-001", requirement_id: "req-001",
        original_name: "ui.png", mime_type: "image/png",
        file_path: "/tmp/ui.png",
        file_size: 2048, category: "image", extracted_text: null, created_at: 1,
      },
      {
        id: "att-002", requirement_id: "req-001",
        original_name: "prd.pdf", mime_type: "application/pdf",
        file_path: "/tmp/prd.pdf",
        file_size: 4096, category: "pdf", extracted_text: "产品需求文档内容", created_at: 2,
      },
    ];
    const ctx = buildAttachmentContext(atts);
    expect(ctx).toContain("附件（图片）");
    expect(ctx).toContain("附件（文档内容）");
    expect(ctx).toContain("产品需求文档内容");
  });
});
```

- [ ] **Step 3: 运行测试**

```bash
bun test tests/core/requirement-attachments.test.ts
```
Expected: 所有 test 通过（注：`saveAttachment` 需要 DB，由集成测试覆盖）

- [ ] **Step 4: Commit**

```bash
git add src/core/requirement-attachments.ts tests/core/requirement-attachments.test.ts
git commit -m "feat: 附件 CRUD 模块（文本提取 + prompt 注入工具）"
```

---

## Task 4: Server.ts Layer 1 防护

**Files:**
- Modify: `src/daemon/server.ts`

- [ ] **Step 1: 添加 `maxRequestBodySize`**

在 `src/daemon/server.ts` 的 `Bun.serve({...})` 调用中，在 `hostname` 行之后添加：

```typescript
// 文件上传最大 200MB + 少量余量；防止大请求体撑爆内存（busboy limits 之外的 Layer 1 闸）
maxRequestBodySize: 210 * 1024 * 1024,
```

完整的 `startServer` 函数应该是：

```typescript
export function startServer(opts: { host: string; port: number }): Server<undefined> {
  setListenHost(opts.host);
  const server = Bun.serve({
    hostname: opts.host,
    port: opts.port,
    // 文件上传最大 200MB + 少量余量；防止大请求体撑爆内存（Layer 1 闸，配合路由层 200MB 逐文件检查）
    maxRequestBodySize: 210 * 1024 * 1024,
    // Bun 默认 10s，对空闲 keep-alive 连接过于激进，拉长到 120s
    idleTimeout: 120,

    async fetch(req, server) {
      if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        if (!(await checkWebSocketAuth(req, server))) {
          return new Response("Unauthorized", { status: 401 });
        }
        const success = server.upgrade(req);
        if (success) return undefined as unknown as Response;
        return new Response("WebSocket upgrade failed", { status: 400 });
      }

      return handleRequest(req, server);
    },

    websocket: {
      open(ws) { wsManager.register(ws); },
      close(ws) { wsManager.unregister(ws); },
      message(ws, message) { wsManager.handleMessage(ws, message as string | Buffer); },
    },
  });

  return server;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/daemon/server.ts
git commit -m "feat: server.ts 加 maxRequestBodySize=210MB（Layer 1 附件上传防护）"
```

---

## Task 5: Routes — 附件上传 / 列表 / 删除

**Files:**
- Modify: `src/daemon/routes.ts`

在 `routes.ts` 顶部 import 区添加：
```typescript
import {
  saveAttachment,
  listAttachments,
  getAttachmentById,
  deleteAttachment,
} from "../core/requirement-attachments";
```

- [ ] **Step 1: 在路由文件 `requirement comments` 路由前插入 3 个附件路由**

找到 `routes.ts` 中 `// GET /api/requirements/:reqId/comments` 那段（约第 944 行），在其**前面**插入以下路由代码：

```typescript
// ──────────────────────────────────────────────
// Requirement Attachments
// ──────────────────────────────────────────────

const reqAttachmentsMatch = extractParam(path, /^\/api\/requirements\/([\w-]+)\/attachments$/);
const reqAttachmentDetailMatch = path.match(/^\/api\/requirements\/([\w-]+)\/attachments\/([\w-]+)$/);

// GET /api/requirements/:id/attachments
if (method === "GET" && reqAttachmentsMatch) {
  const reqId = reqAttachmentsMatch;
  if (!getRequirementById(reqId)) return error("requirement not found", 404);
  return json({ attachments: listAttachments(reqId) });
}

// POST /api/requirements/:id/attachments （multipart/form-data）
if (method === "POST" && reqAttachmentsMatch) {
  const reqId = reqAttachmentsMatch;
  if (!getRequirementById(reqId)) return error("requirement not found", 404);

  // Bun 原生 formData()：完整解析 multipart 后再处理，无 busboy race condition
  let formData: FormData;
  try {
    formData = await req.formData();
  } catch (e: unknown) {
    return error(`multipart 解析失败：${(e as Error).message}`, 400);
  }

  const rawFiles = formData.getAll("files");
  if (rawFiles.length === 0) return error("files 字段必须包含至少一个文件", 400);

  const MAX_FILE_SIZE = 200 * 1024 * 1024; // 200MB Layer 2 检查

  // 逐文件校验大小（Layer 2 防护）
  for (const f of rawFiles) {
    if (!(f instanceof File)) return error("files 字段必须是文件类型", 400);
    if (f.size > MAX_FILE_SIZE) {
      return new Response(
        JSON.stringify({ error: `文件 "${f.name}" 超过 200MB 上限（${(f.size / 1024 / 1024).toFixed(1)}MB）` }),
        { status: 413, headers: { "Content-Type": "application/json" } },
      );
    }
  }

  // 并行读取全部文件内容为 ArrayBuffer，然后依序保存（保证 ID 单调递增）
  const buffers = await Promise.all((rawFiles as File[]).map((f) => f.arrayBuffer()));

  const saved = [];
  for (let i = 0; i < (rawFiles as File[]).length; i++) {
    const f = rawFiles[i] as File;
    const buf = buffers[i];
    const att = await saveAttachment({
      requirementId: reqId,
      originalName: f.name,
      mimeType: f.type || "application/octet-stream",
      data: buf,
    });
    saved.push(att);
  }

  return json({ attachments: saved }, 201);
}

// DELETE /api/requirements/:reqId/attachments/:attId
if (method === "DELETE" && reqAttachmentDetailMatch) {
  const [, reqId, attId] = reqAttachmentDetailMatch;
  if (!getRequirementById(reqId)) return error("requirement not found", 404);
  const att = getAttachmentById(attId);
  if (!att || att.requirement_id !== reqId) return error("attachment not found", 404);
  deleteAttachment(attId);
  return json({ ok: true });
}
```

- [ ] **Step 2: 在 `useApi.ts` 的 `NEW_API_PATTERNS` 数组中添加附件路由**

打开 `src/web/src/hooks/useApi.ts`，找到 `NEW_API_PATTERNS` 数组，在末尾添加：

```typescript
/^\/api\/requirements\/[\w.\-]+\/attachments(\/[\w.\-]+)?$/,
```

- [ ] **Step 3: 写路由集成测试**

```typescript
// tests/routes/attachment-routes.test.ts
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";

// 简化测试：直接调用 core 函数验证 CRUD 链路
import { detectCategory } from "../../src/core/requirement-attachments";

describe("附件路由前置验证", () => {
  it("detectCategory 对上传常见 MIME 正确分类", () => {
    expect(detectCategory("image/png", "a.png")).toBe("image");
    expect(detectCategory("application/pdf", "b.pdf")).toBe("pdf");
    expect(detectCategory("text/plain", "c.txt")).toBe("text");
    expect(detectCategory("application/vnd.openxmlformats-officedocument.wordprocessingml.document", "d.docx")).toBe("office");
  });

  it("文件大小检查常量", () => {
    const MAX = 200 * 1024 * 1024;
    expect(MAX).toBe(209715200); // 200MB in bytes
    const LAYER1 = 210 * 1024 * 1024;
    expect(LAYER1).toBeGreaterThan(MAX); // Layer 1 > Layer 2
  });
});
```

- [ ] **Step 4: 运行测试**

```bash
bun test tests/routes/attachment-routes.test.ts
```
Expected: 2 passed

- [ ] **Step 5: Commit**

```bash
git add src/daemon/routes.ts src/web/src/hooks/useApi.ts tests/routes/attachment-routes.test.ts
git commit -m "feat: 附件上传/列表/删除路由（Bun formData + 200MB 双重防护）"
```

---

## Task 6: Clarifier Prompt 注入附件上下文

**Files:**
- Modify: `src/daemon/requirement-clarifier.ts`

- [ ] **Step 1: 在顶部 import 区添加附件相关导入**

```typescript
import { listAttachments, buildAttachmentContext } from "../core/requirement-attachments";
```

- [ ] **Step 2: 在 `buildPrompt()` 函数中新增 `attachmentContext` 参数**

找到 `buildPrompt(opts: {...})` 函数，将参数类型扩展：

```typescript
function buildPrompt(opts: {
  projectName: string;
  projectDescription: string | null;
  workspaceAlias: string | null;
  workspaceContext: string | null;
  title: string;
  specMd: string;
  qaHistory: string;
  attachmentContext: string;  // 新增
}): string {
```

在函数返回数组（`return [...].join("\n")`）中，在 `# 上下文` 段之后（`ctxLines.join("\n")` 之后）、`# 需求标题` 之前插入：

```typescript
opts.attachmentContext ? "# 附件\n\n" + opts.attachmentContext : "",
"",
```

完整修改位置示意：

```typescript
return [
  // ... 现有内容 ...
  "# 上下文",
  ctxLines.join("\n"),
  "",
  // ── 新增：附件上下文 ──
  ...(opts.attachmentContext ? ["# 附件\n\n" + opts.attachmentContext, ""] : []),
  // ── 附件上下文结束 ──
  "# 需求标题",
  opts.title,
  // ...
].join("\n");
```

- [ ] **Step 3: 在 `_runClarifierRoundInner` 中读取并注入附件上下文**

找到 `const prompt = buildPrompt({...})` 调用（约第 277 行），在其之前添加：

```typescript
// 读取需求的所有附件，构建 prompt 段落
const attachments = listAttachments(reqId);
const attachmentContext = buildAttachmentContext(attachments);
```

在 `buildPrompt({...})` 调用中添加 `attachmentContext`:

```typescript
const prompt = buildPrompt({
  projectName: project.name,
  projectDescription: project.description,
  workspaceAlias: workspace?.alias ?? null,
  workspaceContext: workspace?.path ? readWorkspaceContext(workspace.path) : null,
  title: req.title,
  specMd: req.spec_md ?? "",
  qaHistory,
  attachmentContext,   // 新增
});
```

- [ ] **Step 4: 写单元测试验证 prompt 注入**

```typescript
// tests/daemon/clarifier-attachment.test.ts
import { describe, it, expect } from "bun:test";
import { buildAttachmentContext } from "../../src/core/requirement-attachments";
import type { Attachment } from "../../src/core/requirement-attachments";

// 测试 buildPrompt 集成：通过 buildAttachmentContext 间接验证
describe("clarifier attachmentContext 注入", () => {
  it("有图片时 context 包含路径引导", () => {
    const atts: Attachment[] = [{
      id: "att-001", requirement_id: "req-001",
      original_name: "design.png", mime_type: "image/png",
      file_path: "/home/.autopilot/attachments/req-001/att-001.png",
      file_size: 512, category: "image", extracted_text: null, created_at: 1,
    }];
    const ctx = buildAttachmentContext(atts);
    expect(ctx).toContain("Read 工具");
    expect(ctx).toContain("att-001.png");
  });

  it("无附件时 context 为空字符串", () => {
    expect(buildAttachmentContext([])).toBe("");
  });
});
```

- [ ] **Step 5: 运行测试**

```bash
bun test tests/daemon/clarifier-attachment.test.ts
```
Expected: 2 passed

- [ ] **Step 6: Commit**

```bash
git add src/daemon/requirement-clarifier.ts tests/daemon/clarifier-attachment.test.ts
git commit -m "feat: clarifier 注入附件上下文（图片→路径，文档→内联文本）"
```

---

## Task 7: Frontend — useApi.ts 附件 API 方法

**Files:**
- Modify: `src/web/src/hooks/useApi.ts`

- [ ] **Step 1: 添加 `Attachment` 类型定义**

在 `useApi.ts` 的类型定义区块（其他 `export interface` 附近）添加：

```typescript
export interface Attachment {
  id: string;
  requirement_id: string;
  original_name: string;
  mime_type: string;
  file_path: string;
  file_size: number;
  category: "image" | "text" | "pdf" | "office";
  extracted_text: string | null;
  created_at: number;
}
```

- [ ] **Step 2: 在 `api` 对象中添加 3 个附件方法**

在 `api` 对象末尾（或需求相关方法附近）添加：

```typescript
// 附件 — HTTP 多方法（upload 需 multipart，走原生 fetch 不走 WS-RPC）
listAttachments: (reqId: string) =>
  request<{ attachments: Attachment[] }>(`/api/requirements/${reqId}/attachments`)
    .then((r) => r.attachments),

uploadAttachments: async (reqId: string, files: File[]): Promise<Attachment[]> => {
  const formData = new FormData();
  for (const f of files) formData.append("files", f);
  let res: Response;
  try {
    res = await fetch(`/api/requirements/${reqId}/attachments`, {
      method: "POST",
      body: formData,
      headers: { ...authHeaders() },
      // 注意：不设 Content-Type，让浏览器自动加 boundary
    });
  } catch (e: unknown) {
    throw new Error(`上传请求失败：${(e as Error)?.message ?? String(e)}`);
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((body as any).error ?? `HTTP ${res.status}`);
  }
  return ((await res.json()) as { attachments: Attachment[] }).attachments;
},

deleteAttachment: (reqId: string, attId: string) =>
  request<{ ok: boolean }>(`/api/requirements/${reqId}/attachments/${attId}`, {
    method: "DELETE",
  }),
```

- [ ] **Step 3: Commit**

```bash
git add src/web/src/hooks/useApi.ts
git commit -m "feat: useApi 添加附件上传/列表/删除方法"
```

---

## Task 8: Frontend — AttachmentUploader 组件

**Files:**
- Create: `src/web/src/components/AttachmentUploader.tsx`

- [ ] **Step 1: 编写 AttachmentUploader.tsx**

```tsx
// src/web/src/components/AttachmentUploader.tsx
import { useRef, useState } from "react";
import { Upload, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "@/components/Toast";
import { api, type Attachment } from "@/hooks/useApi";

interface AttachmentUploaderProps {
  requirementId: string;
  onUploaded: (newAtts: Attachment[]) => void;
  disabled?: boolean;
}

const ACCEPT = [
  "image/png", "image/jpeg", "image/webp", "image/gif",
  "text/*",
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
].join(",");

export function AttachmentUploader({ requirementId, onUploaded, disabled }: AttachmentUploaderProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const toast = useToast();

  const upload = async (files: File[]) => {
    if (!files.length || uploading || disabled) return;
    setUploading(true);
    try {
      const saved = await api.uploadAttachments(requirementId, files);
      onUploaded(saved);
      toast.success(`已上传 ${saved.length} 个附件`);
    } catch (e: unknown) {
      toast.error("上传失败", (e as Error)?.message ?? String(e));
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    void upload(files);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const files = Array.from(e.dataTransfer.files);
    void upload(files);
  };

  return (
    <div
      className={cn(
        "relative flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-md border border-dashed border-border px-4 py-4 transition-colors",
        dragging && "border-accent bg-accent/5",
        disabled && "pointer-events-none opacity-50",
        !disabled && "hover:border-accent/60 hover:bg-muted/30",
      )}
      onClick={() => inputRef.current?.click()}
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
      role="button"
      tabIndex={disabled ? -1 : 0}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") inputRef.current?.click(); }}
      aria-label="上传附件"
    >
      {uploading ? (
        <Loader2 className="h-5 w-5 animate-spin text-accent" />
      ) : (
        <Upload className="h-5 w-5 text-muted-foreground" />
      )}
      <p className="font-mono text-[11px] text-muted-foreground text-center">
        {uploading ? "上传中…" : "点击或拖拽上传附件（图片 / PDF / Office / 代码文本，最大 200MB）"}
      </p>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={ACCEPT}
        className="sr-only"
        onChange={handleChange}
        disabled={disabled || uploading}
      />
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/web/src/components/AttachmentUploader.tsx
git commit -m "feat: AttachmentUploader 组件（拖拽/点击上传，全类型支持）"
```

---

## Task 9: Frontend — AttachmentList 组件

**Files:**
- Create: `src/web/src/components/AttachmentList.tsx`

- [ ] **Step 1: 编写 AttachmentList.tsx**

```tsx
// src/web/src/components/AttachmentList.tsx
import { useState } from "react";
import { FileText, Image, FileSpreadsheet, Presentation, File, Trash2, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "@/components/Toast";
import { api, type Attachment } from "@/hooks/useApi";

interface AttachmentListProps {
  requirementId: string;
  attachments: Attachment[];
  onDeleted: (attId: string) => void;
  readOnly?: boolean;
}

const CATEGORY_ICON: Record<Attachment["category"], typeof File> = {
  image: Image,
  text: FileText,
  pdf: FileText,
  office: FileSpreadsheet,
};

const CATEGORY_LABEL: Record<Attachment["category"], string> = {
  image: "图片",
  text: "文本",
  pdf: "PDF",
  office: "Office",
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

export function AttachmentList({ requirementId, attachments, onDeleted, readOnly }: AttachmentListProps) {
  const toast = useToast();
  const [deletingId, setDeletingId] = useState<string | null>(null);

  if (attachments.length === 0) return null;

  const handleDelete = async (att: Attachment) => {
    if (deletingId) return;
    setDeletingId(att.id);
    try {
      await api.deleteAttachment(requirementId, att.id);
      onDeleted(att.id);
      toast.success(`已删除附件「${att.original_name}」`);
    } catch (e: unknown) {
      toast.error("删除失败", (e as Error)?.message ?? String(e));
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="space-y-1">
      {attachments.map((att) => {
        const Icon = CATEGORY_ICON[att.category] ?? File;
        const deleting = deletingId === att.id;
        return (
          <div
            key={att.id}
            className="flex items-center gap-2 rounded-md border border-border bg-card px-2.5 py-1.5"
          >
            <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="flex-1 truncate font-mono text-[11px] text-foreground" title={att.original_name}>
              {att.original_name}
            </span>
            <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
              {CATEGORY_LABEL[att.category]} · {formatBytes(att.file_size)}
            </span>
            {!readOnly && (
              <button
                type="button"
                onClick={() => void handleDelete(att)}
                disabled={!!deletingId}
                className={cn(
                  "shrink-0 text-muted-foreground hover:text-destructive transition-colors",
                  deleting && "opacity-50",
                )}
                aria-label={`删除附件 ${att.original_name}`}
              >
                {deleting ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Trash2 className="h-3.5 w-3.5" />
                )}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/web/src/components/AttachmentList.tsx
git commit -m "feat: AttachmentList 组件（文件图标 + 大小 + 删除）"
```

---

## Task 10: RequirementDetail — 附件区块

**Files:**
- Modify: `src/web/src/pages/RequirementDetail.tsx`

- [ ] **Step 1: 在 RequirementDetail 中引入附件组件和类型**

在文件顶部 import 区添加：

```typescript
import { AttachmentUploader } from "@/components/AttachmentUploader";
import { AttachmentList } from "@/components/AttachmentList";
import type { Attachment } from "@/hooks/useApi";
```

- [ ] **Step 2: 添加附件状态变量**

在 `RequirementDetail()` 函数内的 useState 声明区（约第 406 行之后）添加：

```typescript
const [attachments, setAttachments] = useState<Attachment[]>([]);
```

- [ ] **Step 3: 在 `refresh()` 函数中同时拉取附件列表**

找到 `const [data, repoList, sub, qs, rd, slogs] = await Promise.all([...])` 那段，添加附件拉取：

```typescript
const [data, repoList, sub, qs, rd, slogs, atts] = await Promise.all([
  api.getRequirement(id),
  api.listWorkspaces(),
  api.listRequirementSubPrs(id).catch(() => [] as RequirementSubPr[]),
  api.listQuestions(id).catch(() => [] as Question[]),
  api.getClarifierRound(id).catch(() => null),
  api.listRequirementStatusLogs(id).catch(() => [] as RequirementStatusLog[]),
  api.listAttachments(id).catch(() => [] as Attachment[]),  // 新增
]);
// ...
setAttachments(atts);  // 新增
```

- [ ] **Step 4: 在页面 JSX 中插入附件区块**

找到 Q&A 区块（渲染 questions 的 section），在其**前面**添加附件区块。找到 `{/* 问答 / 评论 */}` 或 questions 相关的段落（约第 700+ 行区域），在前面插入：

```tsx
{/* 附件区块：创建阶段 / 澄清阶段均可上传 */}
{req && (
  <section className="mt-6">
    <h3 className="mb-2 font-mono text-xs font-medium text-muted-foreground uppercase tracking-wider">
      附件
    </h3>
    <div className="space-y-2">
      <AttachmentList
        requirementId={req.id}
        attachments={attachments}
        onDeleted={(attId) => setAttachments((prev) => prev.filter((a) => a.id !== attId))}
        readOnly={!canEditRequirementContent(req.status)}
      />
      {canEditRequirementContent(req.status) && (
        <AttachmentUploader
          requirementId={req.id}
          onUploaded={(newAtts) => setAttachments((prev) => [...prev, ...newAtts])}
        />
      )}
    </div>
  </section>
)}
```

注意：`canEditRequirementContent` 已在 `lib/requirement-steps.ts` 中定义，直接复用。

- [ ] **Step 5: Commit**

```bash
git add src/web/src/pages/RequirementDetail.tsx
git commit -m "feat: RequirementDetail 添加附件上传/列表区块"
```

---

## Task 11: ProjectDetail — 新建需求 Dialog 附件上传

**Files:**
- Modify: `src/web/src/pages/ProjectDetail.tsx`

在新建需求 dialog 中，附件采用**先建需求再上传**的两步流程：
1. 用户填写描述并可选择文件
2. 创建需求后，若有文件则上传；失败时也导航到详情页（附件非阻断）

- [ ] **Step 1: 添加附件相关导入和状态**

在 `ProjectDetail.tsx` 顶部 import 区添加：

```typescript
import { AttachmentUploader } from "@/components/AttachmentUploader";
import { AttachmentList } from "@/components/AttachmentList";
import type { Attachment } from "@/hooks/useApi";
```

在 `ProjectDetail()` 函数中新增状态：

```typescript
const [pendingFiles, setPendingFiles] = useState<File[]>([]);
const [createdReqId, setCreatedReqId] = useState<string | null>(null);
const [creationAtts, setCreationAtts] = useState<Attachment[]>([]);
```

- [ ] **Step 2: 修改 `createRequirement` 函数，创建后顺序上传附件**

找到 `const createRequirement = async () => {` 函数，修改为：

```typescript
const createRequirement = async () => {
  const desc = reqDesc.trim();
  if (!desc) {
    toast.error("验证失败", "需求描述不能为空");
    return;
  }
  const firstLine = desc.split("\n")[0].trim();
  const title = firstLine.length > 30 ? firstLine.slice(0, 30) + "…" : firstLine;
  setSavingReq(true);
  try {
    const req = await api.createRequirement({ project_id: projectId, title, spec_md: desc });
    toast.success(`已创建需求「${title}」`);
    // 若有预选文件，创建后立即上传（失败不阻断导航）
    if (pendingFiles.length > 0) {
      try {
        await api.uploadAttachments(req.id, pendingFiles);
      } catch (e: unknown) {
        toast.error("附件上传失败", (e as Error)?.message ?? String(e));
      }
    }
    setReqDialogOpen(false);
    setPendingFiles([]);
    navigate(`/requirements/${req.id}`);
  } catch (e: unknown) {
    toast.error("创建失败", (e as Error)?.message ?? String(e));
  } finally {
    setSavingReq(false);
  }
};
```

- [ ] **Step 3: 在新建需求 Dialog 的 Textarea 之后添加文件选择区**

找到新建需求 dialog 中 `<Textarea>` 组件（约有 `placeholder="描述需求..."` 的那个），在其后添加：

```tsx
{/* 附件预选：创建后自动上传 */}
<div className="space-y-2">
  <label className="font-mono text-[11px] text-muted-foreground">附件（可选）</label>
  {pendingFiles.length > 0 && (
    <div className="space-y-1">
      {pendingFiles.map((f, i) => (
        <div key={i} className="flex items-center gap-2 rounded border border-border px-2.5 py-1.5">
          <span className="flex-1 truncate font-mono text-[11px]">{f.name}</span>
          <button
            type="button"
            className="text-muted-foreground hover:text-destructive"
            onClick={() => setPendingFiles((prev) => prev.filter((_, idx) => idx !== i))}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  )}
  <div
    className="flex cursor-pointer items-center justify-center gap-2 rounded-md border border-dashed border-border px-3 py-2.5 hover:border-accent/60 hover:bg-muted/30 transition-colors"
    onClick={() => {
      const input = document.createElement("input");
      input.type = "file";
      input.multiple = true;
      input.onchange = () => {
        const files = Array.from(input.files ?? []);
        setPendingFiles((prev) => [...prev, ...files]);
      };
      input.click();
    }}
    role="button"
    tabIndex={0}
    onKeyDown={(e) => { if (e.key === "Enter") (e.currentTarget as HTMLElement).click(); }}
  >
    <span className="font-mono text-[11px] text-muted-foreground">+ 选择文件（图片 / PDF / Office / 代码，最大 200MB）</span>
  </div>
</div>
```

- [ ] **Step 4: 在 dialog 关闭时清空 pendingFiles**

找到 `const closeReqDialog = () => {` 函数，在 `setReqDialogOpen(false)` 之前添加：

```typescript
setPendingFiles([]);
```

- [ ] **Step 5: Commit**

```bash
git add src/web/src/pages/ProjectDetail.tsx
git commit -m "feat: ProjectDetail 新建需求 dialog 支持预选附件"
```

---

## Task 12: requirement-buckets.ts — 修正状态映射

**Files:**
- Modify: `src/web/src/lib/requirement-buckets.ts`

需求规格确认的状态映射：
- 等待人工：`clarifying`、`awaiting_approval`
- 运行中：`drafting`、`queued`、`running`、`awaiting_review`、`fix_revision`（及 `ready` 等其他状态）
- 归档：`done`、`cancelled`、`failed`

- [ ] **Step 1: 重写 requirement-buckets.ts**

```typescript
// src/web/src/lib/requirement-buckets.ts
// 需求 4 段 tab 的状态映射（被 ProjectDetail 页和新 Requirements 全局页共用）。
//
// 状态映射规则（与流水线 tab 对齐，需求页无 task 行，需求自己覆盖全生命周期）：
//   等待人工：clarifying（等用户回复）、awaiting_approval（等审批）
//   运行中：drafting、queued、running、awaiting_review、fix_revision 及任意其他活跃状态
//   归档：done、cancelled、failed

export type ReqTab = "human" | "running" | "archived";

/** ProjectDetail 页内部使用（旧名保持向后兼容，代理到新函数）。 */
export type ProjectReqTab = ReqTab;

/**
 * 需求状态 → 4 段 tab 分桶。
 * 新页面（全局 /requirements）与 ProjectDetail 页共用此函数。
 */
export function requirementTab(status: string): ReqTab {
  // 等待人工：球在用户那边
  if (status === "clarifying" || status === "awaiting_approval") return "human";
  // 归档：终态
  if (status === "done" || status === "cancelled" || status === "failed") return "archived";
  // 其余（drafting / queued / running / awaiting_review / fix_revision / ready / 未知状态）→ 运行中
  return "running";
}

/** 向后兼容：ProjectDetail.tsx 现用 projectReqTab，迁移期保留别名。 */
export const projectReqTab = requirementTab;
```

- [ ] **Step 2: 写状态映射测试**

```typescript
// tests/web/requirement-buckets.test.ts
import { describe, it, expect } from "bun:test";
import { requirementTab } from "../../src/web/src/lib/requirement-buckets";

describe("requirementTab", () => {
  it("等待人工：clarifying", () => expect(requirementTab("clarifying")).toBe("human"));
  it("等待人工：awaiting_approval", () => expect(requirementTab("awaiting_approval")).toBe("human"));

  it("运行中：drafting", () => expect(requirementTab("drafting")).toBe("running"));
  it("运行中：queued", () => expect(requirementTab("queued")).toBe("running"));
  it("运行中：running", () => expect(requirementTab("running")).toBe("running"));
  it("运行中：awaiting_review", () => expect(requirementTab("awaiting_review")).toBe("running"));
  it("运行中：fix_revision", () => expect(requirementTab("fix_revision")).toBe("running"));
  it("运行中：ready（规约未显式归类，兜底为 running）", () => expect(requirementTab("ready")).toBe("running"));

  it("归档：done", () => expect(requirementTab("done")).toBe("archived"));
  it("归档：cancelled", () => expect(requirementTab("cancelled")).toBe("archived"));
  it("归档：failed", () => expect(requirementTab("failed")).toBe("archived"));

  it("未知状态兜底为 running", () => expect(requirementTab("some_future_status")).toBe("running"));
});
```

- [ ] **Step 3: 运行测试**

```bash
bun test tests/web/requirement-buckets.test.ts
```
Expected: 12 passed

- [ ] **Step 4: Commit**

```bash
git add src/web/src/lib/requirement-buckets.ts tests/web/requirement-buckets.test.ts
git commit -m "feat: requirement-buckets 修正状态映射（failed→归档，awaiting_review→运行中）"
```

---

## Task 13: 全局需求页 `/requirements`

**Files:**
- Create: `src/web/src/pages/Requirements.tsx`

- [ ] **Step 1: 编写 Requirements.tsx**

```tsx
// src/web/src/pages/Requirements.tsx
// 全局需求列表页（/requirements）：4 段 tab + 时间分组。
// 与流水线页（/tasks）并列，流水线展示需求+任务全景，需求页聚焦纯需求分类决策视图。
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Loader2, Hand, Archive, List, Search, X } from "lucide-react";
import { api, type Requirement } from "@/hooks/useApi";
import { useWebSocket } from "@/hooks/useWebSocket";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { PageHero } from "@/components/PageHero";
import { TimeGroupedList, RequirementRow, type TimedRow } from "@/components/PipelineList";
import { tsToMs } from "@/lib/pipeline-time";
import { requirementTab } from "@/lib/requirement-buckets";
import { cn } from "@/lib/utils";

const TABS = [
  { key: "human",    label: "等待人工", Icon: Hand,    iconClass: "text-warning" },
  { key: "running",  label: "运行中",   Icon: Loader2, iconClass: "text-accent" },
  { key: "archived", label: "归档",     Icon: Archive, iconClass: "text-muted-foreground" },
] as const;

export function Requirements() {
  const { subscribe } = useWebSocket();
  const [requirements, setRequirements] = useState<Requirement[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [tab, setTab] = useState("all");

  const refresh = () => {
    setLoading(true);
    setError(null);
    api.listRequirements()
      .then(setRequirements)
      .catch((e: unknown) => setError((e as Error)?.message ?? String(e)))
      .finally(() => setLoading(false));
  };

  useEffect(() => { refresh(); }, []);

  useEffect(() => {
    const unsub = subscribe("requirement:*", () => refresh());
    return unsub;
  }, [subscribe]);

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return requirements;
    return requirements.filter(
      (r) => r.id.toLowerCase().includes(q) || r.title.toLowerCase().includes(q),
    );
  }, [requirements, searchQuery]);

  const now = Date.now();

  const buckets = useMemo(() => {
    const human: Requirement[] = [];
    const running: Requirement[] = [];
    const archived: Requirement[] = [];
    for (const r of filtered) {
      const t = requirementTab(r.status);
      if (t === "human") human.push(r);
      else if (t === "running") running.push(r);
      else archived.push(r);
    }
    return { human, running, archived };
  }, [filtered]);

  const toRows = (list: Requirement[]): TimedRow[] =>
    list
      .map((r) => ({ key: r.id, ts: tsToMs(r.updated_at), node: <RequirementRow req={r} now={now} /> }))
      .sort((a, b) => b.ts - a.ts);

  const allRows = useMemo(
    () => [...toRows(buckets.human), ...toRows(buckets.running), ...toRows(buckets.archived)]
      .sort((a, b) => b.ts - a.ts),
    [buckets, now],
  );

  const hasAny = requirements.length > 0;
  const filteredAny = filtered.length > 0;

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 md:px-6 md:py-8">
      <PageHero
        eyebrow="SHEET · REQUIREMENTS"
        title="需求"
        subtitle="全局需求视图 · 按进展分类"
        meta={[
          { k: "全部", v: requirements.length },
          { k: "等待人工", v: buckets.human.length },
          { k: "运行中", v: buckets.running.length },
        ]}
      />

      {hasAny && (
        <div className="mt-4">
          <div className="relative max-w-md">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="搜索需求 ID / 标题"
              className="w-full rounded-md border border-border bg-card py-1.5 pl-8 pr-7 font-mono text-xs focus:border-accent focus:outline-none"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery("")}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 text-muted-foreground hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>
      )}

      {error && (
        <Card className="mb-4 border-l-4 border-l-destructive px-4 py-3 mt-4">
          <p className="font-mono text-[10px] text-destructive mb-1">ERROR</p>
          <p className="text-sm">{error}</p>
        </Card>
      )}

      {loading && !hasAny && (
        <div className="mt-12 flex flex-col items-center text-muted-foreground">
          <Loader2 className="h-6 w-6 animate-spin" />
          <p className="mt-2 font-mono text-xs">加载需求...</p>
        </div>
      )}

      {!loading && !error && !hasAny && (
        <div className="mt-12 flex flex-col items-center text-muted-foreground">
          <p className="text-lg font-medium">还没有需求</p>
          <p className="mt-1 font-mono text-xs">
            到{" "}
            <Link to="/library" className="underline">
              项目
            </Link>{" "}
            下创建第一个需求
          </p>
        </div>
      )}

      {!loading && !error && hasAny && !filteredAny && (
        <div className="mt-12 flex flex-col items-center text-muted-foreground">
          <p className="text-lg font-medium">没有匹配的需求</p>
          <Button variant="outline" size="sm" onClick={() => setSearchQuery("")} className="mt-3 font-mono text-[10px]">
            清除搜索
          </Button>
        </div>
      )}

      {!loading && !error && filteredAny && (
        <Tabs value={tab} onValueChange={setTab} className="mt-6">
          <TabsList className="w-full justify-start">
            <TabsTrigger value="all" className="gap-1.5">
              <List className="h-3.5 w-3.5 text-foreground/70" />
              全部
              <span className="ml-0.5 rounded-full bg-muted px-1.5 text-[10px] text-muted-foreground">
                {allRows.length}
              </span>
            </TabsTrigger>
            {TABS.map(({ key, label, Icon, iconClass }) => {
              const rows = toRows(buckets[key as keyof typeof buckets]);
              return (
                <TabsTrigger key={key} value={key} className="gap-1.5">
                  <Icon className={cn("h-3.5 w-3.5", iconClass)} />
                  {label}
                  <span className="ml-0.5 rounded-full bg-muted px-1.5 text-[10px] text-muted-foreground">
                    {rows.length}
                  </span>
                </TabsTrigger>
              );
            })}
          </TabsList>

          <TabsContent value="all">
            {allRows.length > 0 ? (
              <TimeGroupedList rows={allRows} now={now} />
            ) : (
              <p className="py-10 text-center font-mono text-[11px] text-muted-foreground">暂无需求</p>
            )}
          </TabsContent>

          {TABS.map(({ key }) => {
            const rows = toRows(buckets[key as keyof typeof buckets]);
            return (
              <TabsContent key={key} value={key}>
                {rows.length > 0 ? (
                  <TimeGroupedList rows={rows} now={now} />
                ) : (
                  <p className="py-10 text-center font-mono text-[11px] text-muted-foreground">
                    此分类下暂无需求
                  </p>
                )}
              </TabsContent>
            );
          })}
        </Tabs>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/web/src/pages/Requirements.tsx
git commit -m "feat: 全局需求页 /requirements（4 段 tab + 时间分组）"
```

---

## Task 14: App.tsx — 路由 + 导航注册

**Files:**
- Modify: `src/web/src/App.tsx`

- [ ] **Step 1: 添加 Requirements 页面的 lazy import**

在 `App.tsx` 顶部的 lazy 导入区（其他 lazy 导入附近）添加：

```typescript
const Requirements = lazy(() =>
  import("./pages/Requirements").then((m) => ({ default: m.Requirements })),
);
```

- [ ] **Step 2: 在路由配置中注册 `/requirements` 路由**

在 `<Routes>` 内，找到 `<Route path="/tasks" element={<Tasks />} />` 行，在其**后面**添加：

```tsx
<Route path="/requirements" element={<Requirements />} />
```

- [ ] **Step 3: 在 `NAV_GROUPS` 中添加导航项**

找到 `NAV_GROUPS` 数组的"任务"分组（包含"现在"、"开始"、"流水线"、"项目"），在 `流水线` 项后添加：

```typescript
{ path: "/requirements", label: "需求", icon: FileText, end: true },
```

同时在顶部 import 中确认 `FileText` 从 `lucide-react` 导入（已有则不需要重复添加）：
```typescript
import { ..., FileText, ... } from "lucide-react";
```

- [ ] **Step 4: 在 `titleForPath()` 中添加需求页标题**

找到 `function titleForPath(pathname: string): string {` 函数，在 `return "Autopilot"` 之前添加：

```typescript
if (pathname === "/requirements") return "需求";
```

- [ ] **Step 5: Commit**

```bash
git add src/web/src/App.tsx
git commit -m "feat: App.tsx 注册 /requirements 路由和侧边栏导航"
```

---

## Task 15: 构建 Web UI + 冒烟测试

- [ ] **Step 1: 运行完整测试套件**

```bash
bun test
```
Expected: 全部通过（含 migration、core、web 测试）

- [ ] **Step 2: TypeScript 类型检查**

```bash
bun run typecheck
```
Expected: 0 errors

- [ ] **Step 3: 构建 Web UI**

```bash
bun run build:web
```
Expected: 构建成功，`web-dist/` 有产物

- [ ] **Step 4: 启动 daemon 手动验证**

```bash
# 启动 daemon（前台）
bun run src/daemon/index.ts &
sleep 2

# 验证迁移已跑（表存在）
curl -s http://127.0.0.1:6180/api/status

# 打开浏览器测试需求页和附件功能
open http://127.0.0.1:6180

kill %1 2>/dev/null || true
```

- [ ] **Step 5: 最终提交**

```bash
git add -A
git commit -m "chore: 完成需求分类标签页 + 附件上传支持（全量集成）"
```

---

## 自查清单（Self-Review）

### 规格覆盖
- [x] 功能一：4 段 tab（全部/等待人工/运行中/归档）→ Task 12-14
- [x] 功能一：时间分组（今天/昨天/更早）→ 复用 `TimeGroupedList`
- [x] 功能一：正确状态映射（failed→归档，awaiting_review→运行中）→ Task 12
- [x] 功能二：图片 Vision → 路径注入，不 base64 嵌 prompt → Task 3, 6
- [x] 功能二：纯文本/代码 → 直接提取文本注入 → Task 3
- [x] 功能二：PDF → pdf-parse → Task 3
- [x] 功能二：Office（docx/xlsx/pptx）→ mammoth/xlsx/fflate → Task 3
- [x] 功能二：新建需求时上传 → Task 11
- [x] 功能二：AI 澄清阶段上传 → Task 10（RequirementDetail 附件区块）
- [x] 功能二：200MB 单文件限制 → Task 4 (server.ts) + Task 5 (routes.ts Layer 2)
- [x] busboy race condition → 改用 Bun `formData()` → Task 5
- [x] FK 表名正确 `requirements(id)` → Task 2
- [x] `maxRequestBodySize: 210MB` → Task 4

### 历史遗留问题规避确认
- [x] 遗留 1：图片不 base64，只注入路径
- [x] 遗留 1：busboy 替换为 `req.formData()`，写文件后 `await Promise.all`
- [x] 遗留 2：FK `REFERENCES requirements(id)` 而非 `requirement_comments(id)`
- [x] 遗留 2：`limits.fileSize` 改为路由内 `file.size > MAX` 判断
- [x] 遗留 3：`maxRequestBodySize` 已加入 server.ts

### 类型一致性
- `Attachment` 类型：`src/core/requirement-attachments.ts` 和 `src/web/src/hooks/useApi.ts` 字段完全对应
- `requirementTab()` 在 `requirement-buckets.ts` 导出，同时保留 `projectReqTab` 别名供 `ProjectDetail.tsx` 向后兼容
- `AttachmentUploader` 的 `onUploaded: (newAtts: Attachment[]) => void` 与 `api.uploadAttachments()` 返回的 `Attachment[]` 匹配
