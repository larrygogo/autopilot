/**
 * selfhosted-connector 公共辅助（保留供测试 + extension.ts 使用）
 *
 * initSelfhostedConnector() 已迁移至 ./extension.ts（reqgenieExtension）。
 * 此文件仅保留 recoverInflightLinks（测试文件 selfhosted-connector-recovery.test.ts 依赖此导出）。
 */

import { createLogger } from "../../core/logger";
import { listInflightRequirementsBySource } from "../../core/requirements";
import { getTask } from "../../core/db";
import type { MirrorPusher } from "./mirror-pusher";

const log = createLogger("selfhosted:connector");

// ── 启动恢复 ──────────────────────────────────────────────────────────────

/**
 * daemon 重启后从本机 DB 重建 mirror-pusher 内存映射，并对每条进行中需求补推全量快照。
 * best-effort：单条失败 warn 继续，不阻塞调用方。
 *
 * 导出供测试（selfhosted-connector-recovery.test.ts）和 extension.ts 使用。
 */
export async function recoverInflightLinks(mirrorPusher: MirrorPusher): Promise<void> {
  let inflight: ReturnType<typeof listInflightRequirementsBySource>;
  try {
    inflight = listInflightRequirementsBySource("reqgenie");
  } catch (e: unknown) {
    log.warn(
      "启动恢复：查询进行中需求失败（跳过）: %s",
      e instanceof Error ? e.message : String(e),
    );
    return;
  }

  if (inflight.length === 0) {
    log.info("启动恢复：无进行中的 reqgenie 需求，跳过");
    return;
  }

  log.info("启动恢复：发现 %d 条进行中的 reqgenie 需求，开始重建映射", inflight.length);
  let recovered = 0;

  for (const req of inflight) {
    try {
      // 1. 重建 reqgenie_req_id ↔ autopilot_req_id 映射
      mirrorPusher.registerLink({
        reqgenie_req_id: req.external_ref,
        autopilot_req_id: req.id,
        assignment_id: "",   // 重启恢复无原始 assignment_id，填空串（link 仅用 reqgenie_req_id 做 key）
        mirror_seq: 0,
      });

      // 2. 若有活跃 task，重建 taskId → requirementId 反查表
      if (req.task_id) {
        const task = getTask(req.task_id);
        const taskTerminal =
          !task ||
          task.status === "done" ||
          task.status === "cancelled" ||
          task.status === "failed";
        if (!taskTerminal) {
          mirrorPusher.registerTaskRequirement(req.task_id, req.id);
        }
      }

      // 3. 补推全量快照（重置 mirror_seq 基线，把当前状态/澄清/阶段/PR 同步给 reqgenie）
      await mirrorPusher.pushSnapshot(req.id);
      recovered += 1;
    } catch (e: unknown) {
      log.warn(
        "启动恢复：处理需求 %s 失败（跳过）: %s",
        req.id,
        e instanceof Error ? e.message : String(e),
      );
    }
  }

  log.info("启动恢复：完成，成功恢复 %d / %d 条", recovered, inflight.length);
}
