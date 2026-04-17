import { writeFileSync, renameSync, unlinkSync, mkdirSync } from "fs";
import { dirname } from "path";

/**
 * 原子写：先写临时文件，再 rename 到目标路径。同一 FS 下的 rename 是原子操作，
 * 能避免读者看到半写状态。失败时清理临时文件。
 *
 * 参考 gsd 的 writeManifest：`${path}.tmp-${pid}-${rand}`
 */
export function atomicWriteSync(filePath: string, content: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  try {
    writeFileSync(tmpPath, content, "utf-8");
    renameSync(tmpPath, filePath);
  } catch (e) {
    try { unlinkSync(tmpPath); } catch { /* ignore */ }
    throw e;
  }
}
