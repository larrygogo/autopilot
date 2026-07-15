import { describe, it, expect } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { detectCategory, buildAttachmentContext } from "../src/core/requirements/attachments";
import type { Attachment } from "../src/core/requirements/attachments";

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

  it("提取失败的附件显示提示", () => {
    const atts: Attachment[] = [
      {
        id: "att-003", requirement_id: "req-001",
        original_name: "broken.pdf", mime_type: "application/pdf",
        file_path: "/tmp/broken.pdf",
        file_size: 1024, category: "pdf", extracted_text: null, created_at: 3,
      },
    ];
    const ctx = buildAttachmentContext(atts);
    expect(ctx).toContain("文本提取失败");
  });
});

describe("saveAttachment 并发安全", () => {
  it("并发上传预留不同 ID，文件内容不会互相覆盖", async () => {
    const home = join(tmpdir(), `autopilot-attachment-race-${crypto.randomUUID()}`);
    try {
      const proc = Bun.spawn([
        process.execPath,
        join(import.meta.dir, "fixtures", "attachment-race-probe.ts"),
      ], {
        cwd: join(import.meta.dir, ".."),
        env: { ...process.env, AUTOPILOT_HOME: home },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      expect(exitCode, stderr).toBe(0);
      const result = JSON.parse(stdout.trim()) as {
        statuses: string[];
        rows: Array<{ id: string; original_name: string; extracted_text: string }>;
      };
      expect(result.statuses).toEqual(["fulfilled", "fulfilled"]);
      expect(result.rows).toEqual([
        { id: "att-001", original_name: "first.txt", extracted_text: "FIRST" },
        { id: "att-002", original_name: "second.txt", extracted_text: "SECOND" },
      ]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
