import type { Database } from "bun:sqlite";
import { spawnSync } from "child_process";

/**
 * 迁移 033：Workspace 彻底去本地路径
 *
 * 变更：
 * 1. workspaces 加 remote_url TEXT（可空）
 * 2. path 保留历史值但后续不再写入（应用层不再强制 path 非空）
 * 3. 存量 workspace 尝试从本地 git remote get-url origin 回填 remote_url
 *    → 探测失败 = 软失效（remote_url 保持 NULL，任务启动时报错提示补填）
 */
export function up(db: Database): void {
  // 1. 添加 remote_url 列（幂等：列已存在则跳过）
  const cols = db
    .query<{ name: string }, []>("PRAGMA table_info(workspaces)")
    .all()
    .map((c) => c.name);

  if (!cols.includes("remote_url")) {
    db.run("ALTER TABLE workspaces ADD COLUMN remote_url TEXT");
  }

  // 2. path 列保留历史值。SQLite 不支持 DROP NOT NULL；应用层不再强制 path 非空即可。
  //    此处不做表重建，避免破坏外键和唯一索引。

  // 3. 存量回填：遍历 remote_url 为 NULL 且 path 不为空的 workspace
  const rows = db
    .query<{ id: string; path: string }, []>(
      "SELECT id, path FROM workspaces WHERE remote_url IS NULL AND path IS NOT NULL AND path != ''",
    )
    .all();

  for (const row of rows) {
    let remoteUrl: string | null = null;
    try {
      const proc = spawnSync("git", ["-C", row.path, "remote", "get-url", "origin"], {
        encoding: "utf8",
        timeout: 5000,
      });
      if (proc.status === 0 && proc.stdout) {
        const url = proc.stdout.trim();
        if (url) remoteUrl = url;
      }
    } catch {
      // 目录不存在 / git 不可用 → 软失效，remote_url 保持 NULL
    }

    if (remoteUrl) {
      db.run("UPDATE workspaces SET remote_url = ? WHERE id = ?", [remoteUrl, row.id]);
    }
    // remote_url 为 NULL → 软失效，创建任务时会报错提示用户补填
  }
}
