// 协议枚举对齐校验（双侧单一真理来源，spec §11「契约一致性：seq/gate_id/stage 枚举对齐」+ §14.3/§15）。
//
// 不变式：autopilot runner（A 模式）回写/处理的 event_type 与 stage 取值，必须 ⊆ reqgenie 后端
// 实际接受的集合。oracle 取自 **reqgenie 仓的真理来源**，autopilot 侧不另写死一份枚举常量对照——
// 否则两侧会各自漂移。
//
// ⚠ 与计划原始措辞的偏离（已在 PR/汇报记录，理由见下）：
//  1) 计划设想「event_type 枚举从 052_dev_sessions.sql 注释解析」。但 B（reqgenie 侧）落地时
//     **刻意未给 event_type/stage/kind 加 CHECK 约束**（见 reqgenie 20260623b_dev_sessions_runner.sql
//     头部注释「无 CHECK 约束…不需要补 CHECK 迁移」），且 052 的 event_type 注释是 codex 时代旧集合，
//     **未列** stage_artifact / pr_created / session_failed 等 B 新增摄取分支。reqgenie 侧 event_type
//     的**真正单一真理来源**是 `dev_session_service.rs` 的 `ingest_worker_event` match 臂。故本测试
//     从该 match + 052 注释的并集解析事件枚举（仍是「reqgenie 单侧真理」，无 autopilot 写死副本）。
//  2) stage 枚举：052 注释（line 5）已完整列出全 7 阶段，且与 `models/dev_session.rs` STAGES 常量一致，
//     两处都解析并交叉核对，任一缺失即红。
//  3) 计划设想「rounds.ts 不得出现 `seq:`」。但 runner 域事件用 `seq: 0` **占位**（types.ts 明文：
//     回写时不带 seq、占位 0、后端定序回填），且占位在 `sessionEventToWireBody` 出线时被剥离——
//     线上 body 永不携带 runner 自定 seq。故本测试按**真实不变式**校验：出线 body 无 seq 键 +
//     rounds/session-loop 只用 `seq: 0` 哨兵（绝无非零 seq）。gate_id 同理：rounds 永不构造 gate_id，
//     出线 body 仅在事件已带 gate_id 时透传（gate_opened 回写不带）。
import { test, expect } from "bun:test";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { sessionEventToWireBody } from "../src/daemon/runner/types";
import type { SessionEvent } from "../src/daemon/runner/types";

const REQGENIE = join(import.meta.dir, "../../reqgenie/backend");
const MIGRATION_052 = join(REQGENIE, "migrations/052_dev_sessions.sql");
const INGEST_SRC = join(REQGENIE, "src/services/dev_session_service.rs");
const STAGES_SRC = join(REQGENIE, "src/models/dev_session.rs");

const ROUNDS = join(import.meta.dir, "../src/daemon/runner/rounds.ts");
const SESSION_LOOP = join(import.meta.dir, "../src/daemon/runner/session-loop.ts");

// ── autopilot runner（A 模式）实际回写 / 处理的取值（手列 = 被测对象，须 ⊆ reqgenie oracle）──
// 与 src/daemon/runner/rounds.ts + session-loop.ts emit 的 type 字面量逐一对应（见下方静态自检）。
const RUNNER_EMITTED_EVENTS = [
  "assistant_message",
  "clarification_requested",
  "stage_advance",
  "stage_artifact",
  "gate_opened",
  "pr_created",
  "limit_hit",
  "session_failed",
] as const;
// runner 会处理 / 推进的 stage（spec §2 D5 + §4.5；done 是终点，runner 不主动产出但需识别）。
const RUNNER_STAGES = ["clarify", "spec", "eng_review", "ui_review", "dev", "pr"] as const;

function reqgenieAvailable(): boolean {
  return existsSync(MIGRATION_052) && existsSync(INGEST_SRC) && existsSync(STAGES_SRC);
}

/**
 * reqgenie 后端实际接受的 event_type 集合（单一真理来源）。
 * = 052 注释枚举（codex 时代基础事件：gate_decided/user_message/...）
 * ∪ ingest_worker_event match 臂（B 新增：stage_artifact/pr_created/session_failed/limit_hit/...）。
 */
function reqgenieEventTypes(): Set<string> {
  const events = new Set<string>();
  // (a) 052 注释里列出的事件枚举（event_type VARCHAR 列的多行注释）。
  const sql052 = readFileSync(MIGRATION_052, "utf8");
  for (const m of sql052.matchAll(
    /\b(assistant_message|reasoning|tool_call|tool_result|stage_change|gate_opened|gate_decided|clarification_requested|clarification_answered|user_message|limit_hit|error|token_usage|heartbeat)\b/g,
  )) {
    events.add(m[1]!);
  }
  // (b) ingest_worker_event 的 match 臂字面量 —— `"event_type" =>`（B 真正登记新事件之处）。
  const ingest = readFileSync(INGEST_SRC, "utf8");
  for (const m of ingest.matchAll(/^\s*"([a-z_]+)"\s*=>/gm)) {
    events.add(m[1]!);
  }
  return events;
}

/** reqgenie stage 枚举（052 注释 + models STAGES 常量交叉核对）。 */
function reqgenieStages(): { from052: Set<string>; fromConst: Set<string> } {
  const sql052 = readFileSync(MIGRATION_052, "utf8");
  const from052 = new Set<string>();
  // 052 line 5: current_stage 注释 `clarify|spec|eng_review|ui_review|dev|pr|done`
  for (const m of sql052.matchAll(/\b(clarify|spec|eng_review|ui_review|dev|pr|done)\b/g)) from052.add(m[1]!);
  const stagesRs = readFileSync(STAGES_SRC, "utf8");
  const fromConst = new Set<string>();
  // models/dev_session.rs `pub const STAGES: [&str; 7] = [ "clarify", ... ];`
  for (const m of stagesRs.matchAll(/"(clarify|spec|eng_review|ui_review|dev|pr|done)"/g)) fromConst.add(m[1]!);
  return { from052, fromConst };
}

test("[前置] reqgenie 同级 checkout 存在（枚举单一真理来源）", () => {
  // 计划 Task 10：CI 用 actions/checkout 把 reqgenie 拉到同级 ../reqgenie，保持 052/ingest 单一真理。
  // 本机联调与 CI 都应满足；若缺，明确报指引而非静默跳过。
  expect(
    reqgenieAvailable(),
    `reqgenie 后端源不在 ${REQGENIE}（需两仓同级 checkout：${MIGRATION_052}）`,
  ).toBe(true);
});

test("autopilot 回写的 event_type 全部 ∈ reqgenie 实际接受集合（052 注释 ∪ ingest match）", () => {
  const accepted = reqgenieEventTypes();
  for (const e of RUNNER_EMITTED_EVENTS) {
    expect(
      accepted.has(e),
      `event_type "${e}" 不在 reqgenie 接受集合中（B 需在 ingest_worker_event 加分支 / 扩 052 注释）`,
    ).toBe(true);
  }
});

test("autopilot 处理的 stage 全部 ∈ reqgenie stage 枚举（052 注释 ∩ models STAGES 一致）", () => {
  const { from052, fromConst } = reqgenieStages();
  // 两处真理来源必须一致（防 reqgenie 内部漂移）。
  for (const s of RUNNER_STAGES) {
    expect(from052.has(s), `stage "${s}" 未在 reqgenie 052 注释枚举中`).toBe(true);
    expect(fromConst.has(s), `stage "${s}" 未在 reqgenie models/dev_session.rs STAGES 常量中`).toBe(true);
  }
});

test("被测枚举与 rounds.ts/session-loop.ts 实际 emit 的 type 字面量一致（防手列清单漂移）", () => {
  const src = readFileSync(ROUNDS, "utf8") + "\n" + readFileSync(SESSION_LOOP, "utf8");
  const emitted = new Set<string>();
  for (const m of src.matchAll(/\btype:\s*"([a-z_]+)"/g)) emitted.add(m[1]!);
  // 源码里 emit 的每个 type 都必须在被测清单里（否则清单漏校验了一个真实事件）。
  for (const t of emitted) {
    expect(
      (RUNNER_EMITTED_EVENTS as readonly string[]).includes(t),
      `rounds/session-loop emit 的 "${t}" 不在 RUNNER_EMITTED_EVENTS 清单里（更新清单）`,
    ).toBe(true);
  }
  // 反向：清单里所有事件都应被 emit。
  for (const e of RUNNER_EMITTED_EVENTS) {
    expect(emitted.has(e), `清单里的 "${e}" 未在 rounds/session-loop 中 emit（清单含死项？）`).toBe(true);
  }
});

test("runner 永不把自定 seq 送上线：sessionEventToWireBody 出线 body 无 seq 键", () => {
  // 不变式（spec §4.3）：seq 由后端 advisory 锁分配；runner 域用 seq 占位、出线剥离。
  const samples: SessionEvent[] = [
    { seq: 0, type: "assistant_message", text: "x" },
    { seq: 123, type: "gate_opened" }, // 即便事件带了非零 seq，出线也必须剥掉
    { seq: 7, type: "pr_created", pr: { repo: "r", branch_name: "b", pr_url: "u" } },
    { seq: 0, type: "stage_artifact", artifact: { kind: "dev", content: "c" } },
  ];
  for (const ev of samples) {
    const body = sessionEventToWireBody(ev);
    expect("seq" in body, `wire body 不应含 seq（${ev.type}）`).toBe(false);
    expect("seq" in body.payload, `wire payload 不应含 seq（${ev.type}）`).toBe(false);
  }
});

test("rounds.ts/session-loop.ts 仅用 seq 占位 0（绝无 runner 自定的非零/计算 seq）", () => {
  for (const file of [ROUNDS, SESSION_LOOP]) {
    const src = readFileSync(file, "utf8");
    // 允许的唯一形态：`seq: 0`（占位）。任何 `seq: <非0>` / `seq: <表达式>` 都是违规自定。
    for (const m of src.matchAll(/\bseq\s*:\s*([^,}\s]+)/g)) {
      expect(m[1], `${file} 出现非占位 seq（"${m[1]}"）——runner 不得自定 seq`).toBe("0");
    }
  }
});

test("runner 永不自定 gate_id：rounds.ts 不构造 gate_id 字段（后端注入）", () => {
  const src = readFileSync(ROUNDS, "utf8");
  // gate_opened 事件由 rounds 产出但不带 gate_id；只在拉到后端注入后才有。
  expect(/\bgate_id\s*:/.test(src), "rounds.ts 不应构造 gate_id（gate_opened 的 gate_id 由后端注入）").toBe(
    false,
  );
});

test("出线 gate_opened body 不含 gate_id（仅当事件已带才透传）", () => {
  const openedNoGate = sessionEventToWireBody({ seq: 0, type: "gate_opened" });
  expect("gate_id" in openedNoGate.payload).toBe(false);
  // 反例：若上游显式带了 gate_id（如重发后端回填的事件），则透传——证明剥离只针对「runner 不构造」。
  const withGate = sessionEventToWireBody({ seq: 0, type: "gate_opened", gate_id: "g-1" });
  expect(withGate.payload.gate_id).toBe("g-1");
});

// ── stage_advance 协议往返 ──────────────────────────────────────────────
import { wireToSessionEvent } from "../src/daemon/runner/types";
import type { WireEvent } from "../src/daemon/runner/types";

test("stage_advance：wireToSessionEvent 从 payload.to_stage 提平", () => {
  const w: WireEvent = { seq: 5, event_type: "stage_advance", payload: { to_stage: "spec" } };
  const ev = wireToSessionEvent(w);
  expect(ev.type).toBe("stage_advance");
  expect(ev.to_stage).toBe("spec");
});

test("stage_advance：sessionEventToWireBody 把 to_stage 写进 payload", () => {
  const ev = { seq: 0, type: "stage_advance" as const, to_stage: "spec" };
  const body = sessionEventToWireBody(ev);
  expect(body.event_type).toBe("stage_advance");
  expect(body.payload.to_stage).toBe("spec");
  expect("seq" in body).toBe(false);
});

test("clarification_requested：questions[] 经 wire 往返不丢失", () => {
  const ev = { seq: 0, type: "clarification_requested" as const, questions: ["q1", "q2"] };
  const body = sessionEventToWireBody(ev);
  expect(body.payload.questions).toEqual(["q1", "q2"]);
  // 反向：wire → flat（模拟 backend 喂来）
  const w2: WireEvent = { seq: 3, event_type: "clarification_requested", payload: { questions: ["a", "b"] } };
  const flat = wireToSessionEvent(w2);
  expect(flat.questions).toEqual(["a", "b"]);
});
