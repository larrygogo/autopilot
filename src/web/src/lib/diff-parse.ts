// unified diff 解析为行级结构（GitHub 风渲染用：双列行号 + 整行红绿背景 + hunk 头）。
// 输入是单文件的 patch 块（git diff 输出，含 diff --git/index/---/+++ 头）。

export type DiffLineKind = "hunk" | "add" | "del" | "ctx";

export interface DiffLine {
  kind: DiffLineKind;
  /** 旧文件行号（add 行无） */
  oldNo?: number;
  /** 新文件行号（del 行无） */
  newNo?: number;
  /** 行内容（不含 +/- 前缀；hunk 行是完整 @@ 头） */
  text: string;
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * 解析单文件 unified diff。文件头（diff --git / index / --- / +++ / new file 等）
 * 不输出——GitHub 风格里文件名在卡片头单独显示，正文从首个 hunk 开始。
 */
export function parseUnifiedDiff(patch: string): DiffLine[] {
  const out: DiffLine[] = [];
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  for (const raw of patch.split("\n")) {
    const hunk = raw.match(HUNK_RE);
    if (hunk) {
      oldNo = parseInt(hunk[1]!, 10);
      newNo = parseInt(hunk[2]!, 10);
      inHunk = true;
      out.push({ kind: "hunk", text: raw });
      continue;
    }
    if (!inHunk) continue; // 跳过文件头与截断提示前导
    if (raw.startsWith("+")) {
      out.push({ kind: "add", newNo: newNo++, text: raw.slice(1) });
    } else if (raw.startsWith("-")) {
      out.push({ kind: "del", oldNo: oldNo++, text: raw.slice(1) });
    } else if (raw.startsWith(" ") || raw === "") {
      out.push({ kind: "ctx", oldNo: oldNo++, newNo: newNo++, text: raw.slice(1) });
    } else if (raw.startsWith("\\")) {
      // "\ No newline at end of file" —— 按上下文行展示但不计行号
      out.push({ kind: "ctx", text: raw });
    } else {
      // 截断提示等非 diff 行，原样保留
      out.push({ kind: "ctx", text: raw });
    }
  }
  return out;
}
