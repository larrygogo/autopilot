import { getDb, insertWithFreshId } from "../db";
import { emit } from "../event-bus";
import { log } from "../logger";
import { resolveComment } from "./comments";
import { listWorkspaces, type Workspace } from "../sandbox/workspaces";
import { deleteRequirementRuntimeDir } from "./clone";
import { deleteDeliveriesForRequirement } from "./deliveries";

// ──────────────────────────────────────────────
// 类型定义
// ──────────────────────────────────────────────

/**
 * requirements 字段适配 project + workspace 模型。
 *  - project_id：必填，requirement 归属的 project
 *  - workspace_id：可选（spec §5.1：高层需求可以不绑定具体 workspace）
 *
 * 创建时如果带了 workspace_id，会自动写一条 requirement_workspaces 关联。
 */
export interface Requirement {
  id: string;
  project_id: string;
  /**
   * 冗余缓存 = 代码库集合第一个（2026-06-12 主库语义降级，迁移 043）。
   * 勿做「主库」语义消费；真相在 requirement_workspaces 集合表。
   */
  workspace_id: string | null;
  title: string;
  status: string;
  spec_md: string;
  chat_session_id: string | null;
  task_id: string | null;
  pr_url: string | null;
  pr_number: number | null;
  last_reviewed_event_id: string | null;
  active_question_id: string | null;
  clarifier_error: string | null;
  clarifier_provider: string | null;
  clarifier_model: string | null;
  /** 调度器起 task 失败（回滚 ready）时记录的原因；成功起 task 时清空。 */
  schedule_error: string | null;
  /** 进入 cancelled / failed 终态时的人话短摘要（task_logs.note 或用户输入）；failed 重试时清空。 */
  status_reason: string | null;
  /** status_reason 的来源：user（用户手动）/ task（任务级联）/ system（调度等系统路径）。 */
  status_reason_source: StatusReasonSource | null;
  /** 转入终态时的 from 状态（步骤条据此把 ✗ 画在死亡步）；failed 重试时清空。 */
  status_before_terminal: string | null;
  /** 执行用的工作流名；NULL = 未显式选择，调度时回退默认 "dev"。审批后随内容冻结。 */
  workflow: string | null;
  /**
   * 输入形态确认状态（迁移 045，交付物抽象 P0）：
   * NULL=未确认（drafting 默认）/ 'git'=基于代码库 / 'none'=确认无库。
   * setRequirementWorkspaces 按集合空/非空写 'none'/'git'；闸门按所选工作流的 requires.git 校验。
   */
  input_mode: string | null;
  /** 需求来源标识（如 'reqgenie'），B 模式深链触发时写入；原生建需求为 NULL。 */
  source: string | null;
  /** 外部系统需求 id（如 reqgenie requirement uuid），用于回链与去重。 */
  external_ref: string | null;
  /** 状态变化回传 webhook URL（仅 source 有值时使用）；失败不阻塞主流程。 */
  callback_url: string | null;
  /** 回传 webhook HMAC secret；与 callback_url 配对校验。 */
  callback_secret: string | null;
  created_at: number;
  updated_at: number;
}

export type StatusReasonSource = "user" | "task" | "system";

export interface CreateRequirementOpts {
  /** 省略则内部原子生成（nextRequirementId + 撞号重试）；显式传入用于测试 / 迁移夹具。 */
  id?: string;
  project_id: string;
  workspace_id?: string | null;
  title: string;
  spec_md?: string;
  chat_session_id?: string | null;
  source?: string | null;
  external_ref?: string | null;
  callback_url?: string | null;
  callback_secret?: string | null;
}

export interface UpdateRequirementOpts {
  title?: string;
  spec_md?: string;
  workspace_id?: string | null;
  chat_session_id?: string | null;
  task_id?: string | null;
  pr_url?: string | null;
  pr_number?: number | null;
  last_reviewed_event_id?: string | null;
  clarifier_error?: string | null;
  clarifier_provider?: string | null;
  clarifier_model?: string | null;
  schedule_error?: string | null;
  workflow?: string | null;
  input_mode?: string | null;
}

// ──────────────────────────────────────────────
// 状态机
// ──────────────────────────────────────────────

/**
 * 状态转换表（spec §3.2 + P1 Task 14 临时兼容）。
 *
 * 注：
 *   - queued → ready 也是合法的（P2 enqueue 失败时回滚需要）。
 *   - 新流程引入 awaiting_approval（spec §5.3）；P4 才完全重写状态机，
 *     T14 阶段先把 drafting/clarifying/ready/queued/failed → awaiting_approval 这条临时通路打开。
 */
const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  drafting: ["clarifying", "ready", "awaiting_approval", "cancelled"],
  clarifying: ["drafting", "ready", "awaiting_approval", "cancelled"],
  ready: ["queued", "awaiting_approval", "drafting", "cancelled"],
  queued: ["running", "awaiting_approval", "ready", "cancelled"],
  // awaiting_approval → clarifying：审批驳回 spec 时回到澄清重做（带反馈）
  awaiting_approval: ["queued", "running", "drafting", "clarifying", "cancelled"],
  running: ["awaiting_review", "done", "failed", "cancelled"],
  // awaiting_review → failed：task 在 await_review 期失败时 bridge 要能同步需求到 failed，
  // 否则需求永卡 awaiting_review、pr-poller 持续轮询死 task（SC-4）。
  awaiting_review: ["fix_revision", "done", "failed", "cancelled"],
  fix_revision: ["awaiting_review", "failed", "cancelled"],
  done: [],
  cancelled: [],
  // failed → cancelled：失败后用户决定放弃（取消=只留需求本身）；queued/awaiting_approval 是重试出口
  failed: ["queued", "awaiting_approval", "cancelled"],
};

export function canTransitionStatus(from: string, to: string): boolean {
  return (ALLOWED_TRANSITIONS[from] ?? []).includes(to);
}

/** 从某状态出发可以合法转去的全部状态。给错误信息当 hint 用。 */
export function legalTransitionsFrom(from: string): string[] {
  return [...(ALLOWED_TRANSITIONS[from] ?? [])];
}

// ──────────────────────────────────────────────
// 内部工具
// ──────────────────────────────────────────────

function nowMs(): number {
  return Date.now();
}

// ──────────────────────────────────────────────
// CRUD
// ──────────────────────────────────────────────

export function createRequirement(opts: CreateRequirementOpts): Requirement {
  // 自动派生默认预选库：若未指定 workspace_id 且 project 下只有 1 个 workspace，自动选它
  let resolvedWorkspaceId: string | null = opts.workspace_id ?? null;
  if (resolvedWorkspaceId === null && opts.project_id) {
    const wss = listWorkspaces({ projectId: opts.project_id, includeSubmodules: false });
    if (wss.length === 1) {
      resolvedWorkspaceId = wss[0].id;
    }
  }

  const db = getDb();
  const ts = nowMs();
  // 原子 ID：未显式传 id 时内部生成 + INSERT 撞 PK 自动换号重试（消并发撞号窗口，H3）。
  // 显式 id（测试 / 迁移夹具）按原样插入、不重试。
  const insertReq = (id: string): string => {
    db.run(
      "INSERT INTO requirements (id, project_id, workspace_id, title, status, spec_md, chat_session_id, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, 'drafting', ?, ?, ?, ?)",
      [id, opts.project_id, resolvedWorkspaceId, opts.title, opts.spec_md ?? "", opts.chat_session_id ?? null, ts, ts],
    );
    return id;
  };
  const newId = opts.id ? insertReq(opts.id) : insertWithFreshId(nextRequirementId, insertReq);
  // 写入 source 追踪列（migration 050 加，生产 DB 一定有；测试 DB 若没跑该迁移则忽略）
  const hasSourceFields =
    opts.source != null || opts.external_ref != null || opts.callback_url != null || opts.callback_secret != null;
  if (hasSourceFields) {
    try {
      db.run(
        "UPDATE requirements SET source = ?, external_ref = ?, callback_url = ?, callback_secret = ? WHERE id = ?",
        [opts.source ?? null, opts.external_ref ?? null, opts.callback_url ?? null, opts.callback_secret ?? null, newId],
      );
    } catch {
      // DB 未跑 migration 050（如旧测试手动选迁移）时列不存在，忽略；生产环境不会走到这里
    }
  }
  // 有 workspace_id 时自动写多对多关联（spec §5.1）
  if (resolvedWorkspaceId) {
    db.run(
      "INSERT OR IGNORE INTO requirement_workspaces (requirement_id, workspace_id) VALUES (?, ?)",
      [newId, resolvedWorkspaceId],
    );
  }
  return getRequirementById(newId) as Requirement;
}

export function getRequirementById(id: string): Requirement | null {
  const db = getDb();
  return db
    .query<Requirement, [string]>("SELECT * FROM requirements WHERE id = ?")
    .get(id) ?? null;
}

export function listRequirements(
  filters: { workspace_id?: string; project_id?: string; status?: string } = {},
): Requirement[] {
  const db = getDb();
  const where: string[] = [];
  const vals: (string | number)[] = [];
  if (filters.workspace_id) {
    // 按代码库过滤走集合表（任一关联库命中）——workspace_id 列只是缓存，多库需求按缓存列过滤会漏
    where.push(
      "EXISTS (SELECT 1 FROM requirement_workspaces rw WHERE rw.requirement_id = requirements.id AND rw.workspace_id = ?)",
    );
    vals.push(filters.workspace_id);
  }
  if (filters.project_id) {
    where.push("project_id = ?");
    vals.push(filters.project_id);
  }
  if (filters.status) {
    where.push("status = ?");
    vals.push(filters.status);
  }
  const sql =
    "SELECT * FROM requirements" +
    (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
    " ORDER BY created_at ASC";
  return db.query<Requirement, typeof vals>(sql).all(...vals);
}

/**
 * 列出某 project 下所有 requirement（spec §5.1 一个 project 多 workspace 共享需求池）。
 */
export function listRequirementsByProject(projectId: string): Requirement[] {
  const db = getDb();
  return db
    .query<Requirement, [string]>(
      "SELECT * FROM requirements WHERE project_id = ? ORDER BY created_at ASC",
    )
    .all(projectId);
}

export function updateRequirement(id: string, opts: UpdateRequirementOpts): Requirement | null {
  const db = getDb();
  const fields: string[] = [];
  const vals: (string | number | null)[] = [];
  const updatable = [
    "title",
    "spec_md",
    "workspace_id",
    "chat_session_id",
    "task_id",
    "pr_url",
    "pr_number",
    "last_reviewed_event_id",
    "clarifier_error",
    "clarifier_provider",
    "clarifier_model",
    "schedule_error",
    "workflow",
    "input_mode",
  ] as const;
  for (const k of updatable) {
    if (opts[k] !== undefined) {
      fields.push(`${k} = ?`);
      vals.push(opts[k] as string | number | null);
    }
  }
  if (fields.length === 0) return getRequirementById(id);
  fields.push("updated_at = ?");
  vals.push(nowMs());
  vals.push(id);
  db.run(`UPDATE requirements SET ${fields.join(", ")} WHERE id = ?`, vals);
  // 改 workspace_id 缓存列时同步关联表（INSERT OR IGNORE，不清旧行——已选的库不能丢）。
  // 历史一致性洞：create 写关联表而 update 不写，1:N 后该表是集合真相，必须双向同步。
  if (typeof opts.workspace_id === "string" && opts.workspace_id) {
    db.run(
      "INSERT OR IGNORE INTO requirement_workspaces (requirement_id, workspace_id) VALUES (?, ?)",
      [id, opts.workspace_id],
    );
  }
  return getRequirementById(id);
}

/** 需求关联的代码库集合，按创建时间升序（集合自然序） */
export function listRequirementWorkspaces(reqId: string): Workspace[] {
  return getDb()
    .query<Workspace, [string]>(
      "SELECT w.* FROM requirement_workspaces rw JOIN workspaces w ON w.id = rw.workspace_id " +
        "WHERE rw.requirement_id = ? ORDER BY w.created_at ASC",
    )
    .all(reqId);
}

/** 需求 id → workspace_id[] 映射（RPC 列表响应批量 join 用） */
export function listRequirementWorkspaceIds(reqIds: string[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  if (reqIds.length === 0) return map;
  const placeholders = reqIds.map(() => "?").join(",");
  const rows = getDb()
    .query<{ requirement_id: string; workspace_id: string }, string[]>(
      `SELECT requirement_id, workspace_id FROM requirement_workspaces WHERE requirement_id IN (${placeholders})`,
    )
    .all(...reqIds);
  for (const r of rows) {
    const list = map.get(r.requirement_id) ?? [];
    list.push(r.workspace_id);
    map.set(r.requirement_id, list);
  }
  return map;
}

/**
 * 整体替换需求的代码库集合（PUT 语义）。
 * 入参校验（同项目 / 状态闸门）由 RPC 层负责。
 * workspace_id 列只是冗余缓存 = 集合第一个（主库语义已废除，2026-06-12）。
 * input_mode（迁移 045）随集合同步：显式空集 = 确认无库 'none'；非空 = 'git'。
 */
export function setRequirementWorkspaces(reqId: string, wsIds: string[]): void {
  const db = getDb();
  db.transaction(() => {
    db.run("DELETE FROM requirement_workspaces WHERE requirement_id = ?", [reqId]);
    for (const w of wsIds) {
      db.run(
        "INSERT OR IGNORE INTO requirement_workspaces (requirement_id, workspace_id) VALUES (?, ?)",
        [reqId, w],
      );
    }
    db.run("UPDATE requirements SET workspace_id = ?, updated_at = ? WHERE id = ?", [
      wsIds[0] ?? null,
      nowMs(),
      reqId,
    ]);
    try {
      db.run("UPDATE requirements SET input_mode = ? WHERE id = ?", [
        wsIds.length > 0 ? "git" : "none",
        reqId,
      ]);
    } catch (e: unknown) {
      // 仅「列不存在」静默（迁移 045 未跑的旧库/选择性迁移测试夹具）：声明态是增强，不阻塞集合写入。
      // 其它错误（约束冲突/磁盘）会让集合半提交语义不一致（input_mode 是澄清闸门判据），必须吼出来。
      const msg = e instanceof Error ? e.message : String(e);
      if (!/no such column|has no column/i.test(msg)) {
        log.warn("setRequirementWorkspaces: input_mode 写入失败（非列缺失，集合可能半提交）reqId=%s: %s", reqId, msg);
      }
    }
  })();
}

/**
 * 删除需求 + 级联删反馈、sub_prs 和 requirement_workspaces 关联。仅供调用方自己保证 id 处于终态（cancelled / done / failed）。
 *
 * 抽出此函数是为了让 REST handler / chat tools 不直接写 SQL，集中数据库写入到 core 层。
 */
export function deleteRequirement(id: string): void {
  const db = getDb();
  db.transaction(() => {
    // requirement_comments 已有 ON DELETE CASCADE，但显式删一次便于无 FK 场景（如旧 DB / 测试纯表）
    db.run("DELETE FROM requirement_comments WHERE requirement_id = ?", [id]);
    db.run("DELETE FROM requirement_sub_prs WHERE requirement_id = ?", [id]);
    db.run("DELETE FROM requirement_workspaces WHERE requirement_id = ?", [id]);
    deleteDeliveriesForRequirement(id);
    db.run("DELETE FROM requirements WHERE id = ?", [id]);
  })();
  // 需求运行时目录（workspace/ 浅 clone + runs/ 执行历史）随需求删除整树清理；
  // 失败不阻塞（内部已容错）。v2 R2：runs/ 从属需求目录，删需求 = 级联删执行历史。
  deleteRequirementRuntimeDir(id);
}

/**
 * 设置状态。校验状态机合法性后写入，并 emit event-bus 事件。
 * 调用方（REST handler / chat tool）应只通过此函数改 status，
 * 不要直接 UPDATE status 列（会跳过校验和事件）。
 */
export function setRequirementStatus(
  id: string,
  to: string,
  opts?: { reason?: string | null; reason_source?: StatusReasonSource },
): Requirement {
  const cur = getRequirementById(id);
  if (!cur) throw new Error(`requirement not found: ${id}`);
  if (cur.status === to) return cur;
  if (!canTransitionStatus(cur.status, to)) {
    // 把当前合法目标列出来，客户读 daemon log 时知道下一步可以走哪
    const allowed = legalTransitionsFrom(cur.status);
    const hint = allowed.length > 0 ? `（合法去向：${allowed.join(" / ")}）` : "（无合法去向，已是终态）";
    throw new Error(`requirement ${id} 非法状态转换：${cur.status} → ${to}${hint}`);
  }
  const db = getDb();
  const ts = nowMs();
  const isTerminal = to === "cancelled" || to === "failed";
  const reason = isTerminal ? opts?.reason ?? null : null;
  // CAS 乐观锁（与 task 状态机 state-machine.ts:transition 对称）：WHERE 绑定读到的 cur.status，
  // changes===0 = 读后写前被其它驱动者抢改（pr-poller 判 done × 人工驳回 fix_revision 等并发），
  // 不静默覆盖、明确抛冲突。需求状态机有 6 个直接写者（scheduler/clarifier/pr-poller/run-outcome/
  // task-actions/agent-tools），此前无原子保护是历史遗留，非有意设计。
  let res: { changes: number };
  if (isTerminal) {
    // 终态统一记 status_before_terminal（即便无 reason），步骤条据此定位死亡步
    res = db.run(
      "UPDATE requirements SET status = ?, status_reason = ?, status_reason_source = ?, status_before_terminal = ?, updated_at = ? WHERE id = ? AND status = ?",
      [to, reason, reason ? opts?.reason_source ?? "system" : null, cur.status, ts, id, cur.status],
    );
  } else if (cur.status === "failed") {
    // failed → queued / awaiting_approval 重试：清掉上一轮的失败原因（与 schedule_error 成功清空同理）
    res = db.run(
      "UPDATE requirements SET status = ?, status_reason = NULL, status_reason_source = NULL, status_before_terminal = NULL, updated_at = ? WHERE id = ? AND status = ?",
      [to, ts, id, cur.status],
    );
  } else {
    res = db.run("UPDATE requirements SET status = ?, updated_at = ? WHERE id = ? AND status = ?", [to, ts, id, cur.status]);
  }
  if (res.changes === 0) {
    throw new Error(`requirement ${id} 并发状态冲突：期望 ${cur.status}（已被其它写入者改变，本次 ${cur.status} → ${to} 未生效）`);
  }
  // #17：离开澄清态 → 清残留 clarifier_error（仅在 clarifying 期有意义）。澄清失败后用户改走
  // 取消 / 重选库 / finish 等任一出口都不再经过 runClarifierRound 的开轮清理，残留错误会污染
  // 后续卡片（CLI req show 无条件展示「澄清失败」、failed 卡兜底 reason、列表卡 notice）。
  // 故意做成独立 best-effort 语句而非塞进上面的 CAS UPDATE：① 不让中心状态转换耦合一个 30 个
  // 迁移前才加的列；② 与下面 status_logs 同范式容忍「迁移未跑的旧库/纯表夹具」无此列。
  if (cur.status === "clarifying" && to !== "clarifying") {
    try {
      db.run("UPDATE requirements SET clarifier_error = NULL WHERE id = ?", [id]);
    } catch (e: unknown) {
      // 只容忍「列不存在」（migration 015 未跑的旧库/测试纯表夹具）——清理是增强不阻塞转换；
      // 其余真错误（SQLITE_BUSY / 磁盘满 / IO）必须冒泡，不空吞掩盖。
      if (!/no such column/i.test(String(e))) throw e;
    }
  }
  // 需求级状态转移日志（与 task_logs 对称）：审批/排队时间、终态审计的真理来源
  try {
    db.run(
      "INSERT INTO requirement_status_logs (requirement_id, from_status, to_status, reason, created_at) VALUES (?, ?, ?, ?, ?)",
      [id, cur.status, to, reason, ts],
    );
  } catch {
    // 表不存在（迁移未跑的旧库/测试纯表夹具）：日志是增强，不阻塞状态转换
  }
  emit({ type: "requirement:status-changed", payload: { id, from: cur.status, to, reason } });
  return getRequirementById(id) as Requirement;
}

export interface RequirementStatusLog {
  id: number;
  requirement_id: string;
  from_status: string;
  to_status: string;
  reason: string | null;
  created_at: number;
}

/** 需求状态转移历史（升序）。 */
export function listRequirementStatusLogs(requirementId: string): RequirementStatusLog[] {
  const db = getDb();
  try {
    return db
      .query<RequirementStatusLog, [string]>(
        "SELECT * FROM requirement_status_logs WHERE requirement_id = ? ORDER BY id ASC",
      )
      .all(requirementId);
  } catch {
    return [];
  }
}

/**
 * 只更新终态原因两列、不动 status。给「级联停 task 时 bridge 抢先把需求置 cancelled」
 * 的手动取消路径用：随后用 user 来源覆盖 bridge 写入的 task 来源（这次取消的根因是用户操作）。
 */
export function setRequirementStatusReason(
  id: string,
  reason: string | null,
  source: StatusReasonSource | null,
): void {
  const db = getDb();
  db.run(
    "UPDATE requirements SET status_reason = ?, status_reason_source = ?, updated_at = ? WHERE id = ?",
    [reason, reason === null ? null : source, nowMs(), id],
  );
}

/**
 * 设置 active_question_id 字段，并 emit requirement:active-question-changed 事件。
 * 传入 null 表示清空（没有等回答的问题）。
 */
export function setActiveQuestionId(requirementId: string, questionId: string | null): void {
  const db = getDb();
  db.run(
    "UPDATE requirements SET active_question_id = ?, updated_at = ? WHERE id = ?",
    [questionId, nowMs(), requirementId],
  );
  emit({
    type: "requirement:active-question-changed",
    payload: { id: requirementId, question_id: questionId },
  });
}

/**
 * 用户强制结束澄清（"够了，直接审批"），或 clarifier 决定 done=true 时调用。
 *
 * 流程：
 * 1. 若 active_question_id 非空 → resolveQuestion 该 question
 * 2. active_question_id = NULL
 * 3. status = awaiting_approval（走 setRequirementStatus 保证校验 + emit）
 */
export function finishClarification(requirementId: string): void {
  const db = getDb();
  db.transaction(() => {
    const req = getRequirementById(requirementId);
    if (!req) return;
    if (req.active_question_id) {
      resolveComment(req.active_question_id);
    }
    db.run(
      "UPDATE requirements SET active_question_id = NULL, updated_at = ? WHERE id = ?",
      [nowMs(), requirementId],
    );
    emit({
      type: "requirement:active-question-changed",
      payload: { id: requirementId, question_id: null },
    });
  })();
  setRequirementStatus(requirementId, "awaiting_approval");
}

/**
 * 生成下一个 requirement id，格式 "req-NNN"。
 *
 * TODO: 当 requirements 数 > 999 时，3 位 padding 会让 lex 排序出错
 * （"req-1000" < "req-999"），需要改成更宽 padding 或用 CAST 数字排序。
 * 跟 nextRepoId 的同名 TODO 一致。
 */
export function nextRequirementId(): string {
  const db = getDb();
  // 同时扫 requirements 和 requirement_comments，防止需求被删后评论残留导致 ID 复用
  const rows = db
    .query<{ id: string }, []>(
      "SELECT id FROM requirements WHERE id LIKE 'req-%' " +
      "UNION SELECT requirement_id AS id FROM requirement_comments WHERE requirement_id LIKE 'req-%' " +
      "ORDER BY id DESC LIMIT 1",
    )
    .all();
  if (rows.length === 0) return "req-001";
  const n = parseInt(rows[0].id.replace("req-", ""), 10) + 1;
  return `req-${String(n).padStart(3, "0")}`;
}

/**
 * 列出所有 source='reqgenie' 且尚未终态的需求（daemon 重启时用于重建 mirror-pusher 映射）。
 * 终态 = done / cancelled / failed；其余全视为进行中。
 * 若 DB 中无 source 列（旧测试 DB），安全回退返回空列表。
 */
export interface InflightReqgenieRequirement {
  id: string;
  external_ref: string;
  status: string;
  task_id: string | null;
}

export function listInflightReqgenieRequirements(): InflightReqgenieRequirement[] {
  const db = getDb();
  try {
    return db
      .query<InflightReqgenieRequirement, []>(
        "SELECT id, external_ref, status, task_id FROM requirements " +
        "WHERE source = 'reqgenie' AND status NOT IN ('done', 'cancelled', 'failed') " +
        "ORDER BY created_at ASC",
      )
      .all();
  } catch {
    // source 列不存在（旧测试 DB 未跑 migration 050）时安全回退
    return [];
  }
}
