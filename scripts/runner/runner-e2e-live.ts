#!/usr/bin/env bun
// ┌─────────────────────────────────────────────────────────────────────────────┐
// │  Runner 全链路 live e2e — 【手动运行，CI 不跑】                                │
// │  需要：真 reqgenie 后端（含 PG + Redis）+ 真 GitHub 私有仓 + 已注册在线 runner   │
// │  不可在 CI 无人值守跑（gate 默认等人在 reqgenie 前端点）。                         │
// │  验证 mock 替代不了的真实链路：真 gate / 真飞书 / 真 vend token / 真 PR。          │
// └─────────────────────────────────────────────────────────────────────────────┘
//
// 环境变量（全部必填，缺少即 exit 2 明确报因）：
//   REQGENIE_URL        reqgenie 后端根地址，默认 http://127.0.0.1:3001
//   REQGENIE_JWT        有该需求写权限的开发者 JWT（必填）
//   REQGENIE_REQ_ID     已存在的需求 uuid（必填，需绑定真 GitHub 私有仓）
//   REQGENIE_RUNNER_ID  目标在线 runner uuid（必填）
//   REQGENIE_REPO_ID    需求关联的仓库 uuid（必填）
//
// 可选：
//   RUNNER_E2E_AUTO_APPROVE=1   脚本自动调 gate decision API 批准（否则暂停等人在前端点）
//
// 运行：
//   REQGENIE_JWT=<dev-jwt> REQGENIE_REQ_ID=<req> REQGENIE_RUNNER_ID=<runner> \
//   REQGENIE_REPO_ID=<repo uuid> [RUNNER_E2E_AUTO_APPROVE=1] bun run runner-e2e-live

// ── 环境变量读取（缺失立即 exit 2，不让轮询 30min 后以 limit_hit 掩盖配置错误）──
function mustEnv(key: string): string {
  const v = process.env[key];
  if (!v) {
    console.error(`[runner-e2e-live] 缺环境变量 ${key}（需真 reqgenie+真 GitHub 环境才可运行）`);
    process.exit(2);
  }
  return v;
}

const BASE_URL = process.env.REQGENIE_URL ?? "http://127.0.0.1:3001";
const JWT = mustEnv("REQGENIE_JWT");
const REQ_ID = mustEnv("REQGENIE_REQ_ID");
const RUNNER_ID = mustEnv("REQGENIE_RUNNER_ID");
const REPO_ID = mustEnv("REQGENIE_REPO_ID");
const AUTO_APPROVE = process.env.RUNNER_E2E_AUTO_APPROVE === "1";

// ── 类型定义（对齐 spec §15 DTO 契约）──
interface DevSession {
  id: string;
  status: string;
  current_stage: string;
  agent_backend: string;
  pr_url: string | null;
}

interface DevSessionEvent {
  seq: number;
  event_type: string;
  stage: string | null;
  actor: string | null;
  payload: Record<string, unknown>;
}

interface RunnerInfo {
  id: string;
  status: string; // offline|online|busy
  name: string;
}

// ── HTTP 辅助（带 JWT 鉴权，错误即 fail）──
const defaultHeaders = {
  authorization: `Bearer ${JWT}`,
  "content-type": "application/json",
} as const;

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: defaultHeaders,
    body: body != null ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) {
    const text = await r.text().catch(() => "(无响应体)");
    fail(`HTTP ${r.status} ${method} ${path}`, text.slice(0, 500));
  }
  const json = (await r.json()) as { data: T; success?: boolean };
  return json.data;
}

// ── 输出辅助 ──
function fail(msg: string, extra?: unknown): never {
  console.error(`\n  [FAIL] ${msg}`);
  if (extra != null) console.error(`         ${String(extra).slice(0, 800)}`);
  process.exit(1);
}

function ok(msg: string): void {
  console.log(`  [OK]  ${msg}`);
}

function info(msg: string): void {
  console.log(`  [INFO] ${msg}`);
}

// ────────────────────────────────────────────────────────────────────────────
// § smoke 检查（审查修正第 6 条）
// 先验后端可达 + JWT 有效 + runner 在线，任一不过立即 fail 明确报因。
// 目的：避免因 token 过期/权限问题导致整个 30min 轮询以 limit_hit 等模糊错误结束。
// ────────────────────────────────────────────────────────────────────────────
async function smokeChecks(): Promise<void> {
  console.log("\n── smoke 检查（先验后端/鉴权/runner，再跑主流程）──");

  // 1. 后端 /api/health 可达
  info(`检查后端可达：GET ${BASE_URL}/api/health`);
  {
    let ok2 = false;
    try {
      const r = await fetch(`${BASE_URL}/api/health`, { signal: AbortSignal.timeout(10_000) });
      ok2 = r.status < 500;
    } catch (e) {
      fail(
        `后端不可达：${BASE_URL}/api/health — 请先启动 reqgenie daemon（见 docs/runner-integration-guide.md §2）`,
        e instanceof Error ? e.message : String(e),
      );
    }
    if (!ok2) fail(`后端 /api/health 返回 5xx — 请检查 reqgenie 服务健康状态`);
    ok(`后端可达（${BASE_URL}）`);
  }

  // 2. JWT 有效：能成功 GET 需求详情
  info(`检查 JWT 有效：GET /api/requirements/${REQ_ID}`);
  {
    let req: unknown;
    try {
      req = await api<unknown>("GET", `/api/requirements/${REQ_ID}`);
    } catch {
      fail(
        `JWT 无效或需求不存在 (req_id=${REQ_ID})` +
          " — 请检查 REQGENIE_JWT 是否过期，或 REQGENIE_REQ_ID 是否正确",
      );
    }
    if (req == null) fail(`需求 ${REQ_ID} 不存在 — 请检查 REQGENIE_REQ_ID`);
    ok(`JWT 有效，需求 ${REQ_ID} 存在`);
  }

  // 3. runner 在线：GET /api/runners（admin 权限路径）或直接检查 runner 心跳端点
  // 注：runner 列表通常需要 runner_manage 权限（JWT 可能无权），降级策略：
  //   先尝试 GET /api/runners/{id}，后端若返回 200 且 status==online 则通过；
  //   若 403（无权查 runner 列表）则改为尝试创建 session 前的间接判断，
  //   并打 warning（不 fail）— 避免因权限差异拒绝有效配置。
  info(`检查 runner 在线：GET /api/runners/${RUNNER_ID}`);
  {
    let runnerOnline = false;
    let permissionDenied = false;
    try {
      const r = await fetch(`${BASE_URL}/api/runners/${RUNNER_ID}`, {
        headers: { authorization: `Bearer ${JWT}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (r.status === 403 || r.status === 401) {
        permissionDenied = true;
      } else if (r.ok) {
        const body = (await r.json()) as { data?: RunnerInfo };
        const runner = body.data;
        if (runner) {
          if (runner.status === "online" || runner.status === "busy") {
            runnerOnline = true;
          } else {
            fail(
              `runner ${RUNNER_ID} 状态 = ${runner.status}（需 online/busy）` +
                " — 请确认 autopilot runner start 已启动并成功注册心跳",
            );
          }
        }
      } else if (r.status === 404) {
        fail(
          `runner ${RUNNER_ID} 不存在（404）` +
            " — 请检查 REQGENIE_RUNNER_ID，或重新执行 autopilot runner register",
        );
      }
    } catch (e) {
      if (e instanceof Error && e.name !== "AbortError" && !permissionDenied) {
        fail(`检查 runner 状态时网络错误`, e.message);
      }
    }

    if (permissionDenied) {
      // 当前 JWT 无权查 runner 详情（非 admin），降级为警告
      console.log(
        `  [WARN] 无权 GET /api/runners/${RUNNER_ID}（403/401）— JWT 可能无 runner_manage 权限；` +
          `跳过 runner 在线校验，进入主流程（若 runner 未在线，session 将卡 created 不领）`,
      );
    } else if (runnerOnline) {
      ok(`runner ${RUNNER_ID} 在线`);
    }
    // runnerOnline=false 且非 permissionDenied 且非 404 已在上方 fail
  }

  console.log("── smoke 检查全部通过，进入主流程 ──\n");
}

// ────────────────────────────────────────────────────────────────────────────
// 主流程：建 session → 驱动事件流 → 断言 clarify→spec→dev→pr→pr_created→done
// ────────────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log(
    `[runner-e2e-live] reqgenie=${BASE_URL} req=${REQ_ID} runner=${RUNNER_ID} auto_approve=${AUTO_APPROVE}`,
  );

  // smoke 检查（审查修正第 6 条：先验后端/JWT/runner，任一不通立即 fail 报因）
  await smokeChecks();

  // 1. 建 dev_session（autopilot_selfhosted + 目标 runner）
  info(`建 dev_session（autopilot_selfhosted → runner ${RUNNER_ID}）`);
  const created = await api<DevSession>("POST", `/api/requirements/${REQ_ID}/dev-sessions`, {
    agent_backend: "autopilot_selfhosted",
    assigned_runner: RUNNER_ID,
    repo_ids: [REPO_ID],
  });
  if (created.status !== "created") {
    fail(
      `新 session 应为 created，实际 status=${created.status}` +
        " — 可能该需求已有活跃 session（单需求单活跃 session 约束，spec §5.5）",
      created,
    );
  }
  ok(`session 建成 id=${created.id}（status=created, stage=clarify）`);
  const sessionId = created.id;

  // 2. 驱动链路：轮询事件流，处理 clarify / gate，直到 done / failed
  let lastSeq = 0;
  const DEADLINE = Date.now() + 30 * 60_000; // 真 AI + 真 clone + 真 push 给 30min
  const POLL_INTERVAL_MS = 3_000;
  const seenStages = new Set<string>();
  const seenEventTypes = new Set<string>();

  while (Date.now() < DEADLINE) {
    // 拉增量事件（spec §4.1 GET /api/dev-sessions/{id}/events?after_seq=N，JWT 路径）
    const evs = await api<DevSessionEvent[]>(
      "GET",
      `/api/dev-sessions/${sessionId}/events?after_seq=${lastSeq}`,
    );

    for (const e of evs) {
      lastSeq = Math.max(lastSeq, e.seq);
      seenEventTypes.add(e.event_type);
      if (e.stage) seenStages.add(e.stage);

      switch (e.event_type) {
        case "clarification_requested": {
          // 自动回答澄清（真实场景由飞书卡或 Web 回答）
          info(`澄清请求（seq=${e.seq}）— 自动回答：按默认方案实现`);
          await api("POST", `/api/dev-sessions/${sessionId}/messages`, {
            message: "按默认方案实现，无额外约束",
          });
          ok("已回答澄清（user_message）");
          break;
        }

        case "gate_opened": {
          const gateId = String(e.payload.gate_id ?? "");
          if (!gateId) {
            fail(
              `gate_opened 事件缺 payload.gate_id（spec §4.1：gate_id 由后端注入）`,
              e.payload,
            );
          }
          if (AUTO_APPROVE) {
            // RUNNER_E2E_AUTO_APPROVE=1：调真后端 gate decision API 自动批
            await api("POST", `/api/dev-sessions/${sessionId}/gates/${gateId}/decision`, {
              decision: "approved",
            });
            ok(`自动批准 gate（stage=${e.stage ?? "?"}, gate_id=${gateId}）`);
          } else {
            // 默认：暂停等人在 reqgenie 前端点通过/驳回
            console.log(
              `\n  [PAUSE] gate 打开 — stage=${e.stage ?? "?"}, gate_id=${gateId}` +
                "\n          请在 reqgenie 前端点「通过」或「驳回」，脚本继续 30s 轮询…",
            );
          }
          break;
        }

        case "pr_created": {
          const prUrl = String(e.payload.pr_url ?? "");
          ok(`pr_created 事件：PR URL = ${prUrl || "(无 pr_url)"}`);
          if (!prUrl) {
            fail(
              `pr_created 事件缺 payload.pr_url（spec §4.5：pr round 必须携带 pr_url）`,
              e.payload,
            );
          }
          break;
        }

        case "limit_hit": {
          // 成本闸门触顶（spec §4.3）：不静默，立即 fail 明确诊断
          fail(
            `命中成本闸门 limit_hit（stage=${e.stage ?? "?"}, seq=${e.seq}）` +
              " — 可能 round 超时 / STAGE_MAX / SESSION_MAX 触顶。" +
              " 检查：① runner 日志是否有 round timeout；② 调低测试参数后重试",
            e.payload,
          );
          break;
        }

        case "session_cancelled":
          fail(
            `session 被取消（seq=${e.seq}）— 请检查是否有人在前端手动取消了此 session`,
            e.payload,
          );
          break;

        default:
          break;
      }
    }

    // 检查 session 终态
    const cur = await api<DevSession>("GET", `/api/dev-sessions/${sessionId}`);

    if (cur.status === "completed") {
      // ── 终态断言 ──

      // 断言关键阶段均已经历（spec §7 时序：clarify→spec→dev→pr）
      for (const requiredStage of ["clarify", "spec", "dev", "pr"]) {
        if (!seenStages.has(requiredStage)) {
          fail(
            `链路未经历 stage=${requiredStage}（实际经历：${[...seenStages].join(", ")}）` +
              " — 可能 max_stage 未放开到 pr（spec §5.3），或 runner 未实现该 round",
          );
        }
      }
      ok(`全部关键阶段已经历：${[...seenStages].join(" → ")}`);

      // 断言 pr_url 已落库
      if (!cur.pr_url) {
        fail(
          `session 状态 completed 但 pr_url 为空` +
            " — pr_created 事件可能未被后端摄取（spec §5.2 ingest_worker_event pr_created 分支）",
        );
      }
      ok(`pr_url 已落库：${cur.pr_url}`);

      // 断言 pr_created 事件出现在事件流
      if (!seenEventTypes.has("pr_created")) {
        fail(
          `事件流未出现 pr_created（实际事件类型：${[...seenEventTypes].join(", ")}）` +
            " — pr round 可能未执行 submitPR，或 pr_created 事件未回写",
        );
      }

      console.log(
        `\n  [DONE] 全链路完成 PR=${cur.pr_url}` +
          `\n         请在 GitHub 手动 review + merge，完成最终签字（spec §7.6）`,
      );
      console.log(
        "\n✅ runner live e2e 全链路通（clarify→spec→dev→pr→pr_created→completed）。" +
          "\n   merge 由人在 GitHub 完成，飞书澄清/gate 人审已在本次运行中经历或自动批准。",
      );
      return;
    }

    if (cur.status === "failed") {
      fail(
        `session status=failed（stage=${cur.current_stage}）` +
          " — 请查 reqgenie dev_session_events 表找 session_failed/limit_hit 事件定位根因",
        cur,
      );
    }

    if (cur.status === "cancelled") {
      fail(`session 已被取消（status=cancelled）`, cur);
    }

    // 进度日志（每 poll 一次打当前 stage，便于人工观察）
    info(
      `等待推进… status=${cur.status}, stage=${cur.current_stage}, seq=${lastSeq}, ` +
        `elapsed=${Math.round((Date.now() - (DEADLINE - 30 * 60_000)) / 1000)}s`,
    );

    await Bun.sleep(POLL_INTERVAL_MS);
  }

  // 超时：给出诊断建议，区分「gate 未点」还是真卡死
  fail(
    `live e2e 超时（30min 未达终态，最后 status 见 /api/dev-sessions/${sessionId}）` +
      " — 可能原因：① gate 等人点但无人响应（加 RUNNER_E2E_AUTO_APPROVE=1 自动批）；" +
      " ② runner 进程已崩（查 autopilot runner status）；" +
      " ③ AI round 超时（查 runner 日志 ROUND_TIMEOUT）；" +
      " ④ clone / push 因 vend token 问题失败（查 runner 日志 git 错误）",
  );
}

main().catch((e: unknown) => {
  console.error("[runner-e2e-live] 未捕获异常：", e instanceof Error ? e.message : e);
  process.exit(1);
});
