import { readFileSync, existsSync } from "fs";
import { join } from "path";

export interface SubmoduleEntry {
  name: string;
  path: string;
  url: string;
  branch: string | null;
}

/**
 * 读取并解析 <repoPath>/.gitmodules。文件不存在或解析失败返回空数组。
 */
export function parseGitmodulesFile(repoPath: string): SubmoduleEntry[] {
  const filePath = join(repoPath, ".gitmodules");
  if (!existsSync(filePath)) return [];
  try {
    const content = readFileSync(filePath, "utf-8");
    return parseGitmodulesContent(content);
  } catch (e: unknown) {
    return [];
  }
}

/**
 * 纯函数解析 .gitmodules 内容。INI 风格 [submodule "name"] 段。
 *
 * 安全约束：
 * - 拒绝 path 含 `..` 或以 `/` 开头（路径穿越）
 * - 缺 path 或 url 的段被丢弃
 * - 注释行（# 或 ; 开头）忽略
 */
export function parseGitmodulesContent(content: string): SubmoduleEntry[] {
  const entries: SubmoduleEntry[] = [];
  const lines = content.split(/\r?\n/);

  let currentName: string | null = null;
  let currentPath: string | null = null;
  let currentUrl: string | null = null;
  let currentBranch: string | null = null;

  function flush() {
    if (
      currentName !== null &&
      currentPath !== null &&
      currentUrl !== null &&
      !currentPath.includes("..") &&
      !currentPath.startsWith("/")
    ) {
      entries.push({
        name: currentName,
        path: currentPath,
        url: currentUrl,
        branch: currentBranch,
      });
    }
    currentName = null;
    currentPath = null;
    currentUrl = null;
    currentBranch = null;
  }

  for (const raw of lines) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;

    const sectionMatch = line.match(/^\[submodule\s+"([^"]+)"\]$/);
    if (sectionMatch) {
      flush();
      currentName = sectionMatch[1];
      continue;
    }

    if (currentName === null) continue;

    const kvMatch = line.match(/^(\w+)\s*=\s*(.+?)\s*$/);
    if (!kvMatch) continue;
    const key = kvMatch[1].toLowerCase();
    const value = kvMatch[2];

    if (key === "path") currentPath = value;
    else if (key === "url") currentUrl = value;
    else if (key === "branch") currentBranch = value;
  }

  flush();
  return entries;
}
