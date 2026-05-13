import { getDb } from "../core/db";
import { runClarifierRound } from "./requirement-clarifier";
import { createLogger } from "../core/logger";

const log = createLogger("clarifier-watchdog");

/**
 * 找出"卡住"的 clarifying 需求并重新触发 clarifier。
 * 卡住的判定：status=clarifying + active_question_id 非空 + 该 question.status='resolved'
 * （即 user 答完了但 clarifier 没接上下一轮）。
 * 也兜底：status=clarifying + active_question_id IS NULL + 已经过了一段时间（120s）但 clarifier 没跑。
 *
 * 不取消 / 不删除已 running 的 round —— clarifier 内部有 race protection（status 重 check），
 * 我们重新 trigger 一次即可。
 */
export async function runClarifierWatchdog(): Promise<void> {
  const db = getDb();
  // case 1: active 指向 resolved question 的不一致状态
  const stuck = db.query<{ id: string }, []>(`
    SELECT r.id FROM requirements r
    INNER JOIN requirement_questions q ON q.id = r.active_question_id
    WHERE r.status = 'clarifying' AND q.status = 'resolved'
  `).all();

  // case 2: clarifying + active=NULL + 已经 120 秒没动静（avoid 触发刚创建/正在跑的）
  const cutoff = Date.now() - 120_000;
  const orphan = db.query<{ id: string }, [number]>(`
    SELECT id FROM requirements
    WHERE status = 'clarifying'
      AND active_question_id IS NULL
      AND clarifier_error IS NULL
      AND updated_at < ?
  `).all(cutoff);

  const ids = new Set<string>([...stuck.map(r => r.id), ...orphan.map(r => r.id)]);
  if (ids.size === 0) return;

  log.info("clarifier-watchdog: 检测到 %d 个卡住的需求，重新触发 clarifier", ids.size);
  for (const id of ids) {
    log.info("clarifier-watchdog: 触发 req=%s", id);
    // 不等待：每个独立跑，错误内部 emit clarifier-error
    runClarifierRound(id).catch((e: unknown) => {
      log.error("clarifier-watchdog: req=%s 触发失败: %s", id, (e as Error).message);
    });
  }
}
