// 需求附件 CRUD + 文本提取模块。
// 图片：原样保存，extracted_text = null；prompt 注入文件路径。
// 纯文本/代码：读文件内容，截取 extracted_text（最多 100KB 防超 context）。
// PDF：pdf-parse 提取文字。
// Office .docx：mammoth.extractRawText()。
// Office .xlsx：xlsx.utils.sheet_to_csv()（每 sheet 转 CSV，合并）。
// Office .pptx：fflate.unzipSync() 解包，遍历 ppt/slides/slide*.xml，regex 提取 <a:t> 标签文本。

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
      // pdf-parse v2：new PDFParse({ data }) → getText()
      const { PDFParse } = await import("pdf-parse");
      const buf = readFileSync(filePath);
      const parser = new PDFParse({ data: new Uint8Array(buf) });
      const result = await parser.getText();
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
            const xml = new TextDecoder().decode(data as Uint8Array);
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
    return "att-001";
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
