import { loadRunnerConfig } from "../../core/config";
import { loadCredentials } from "./credentials";
import { HttpRunnerBackend } from "./backend";
import { RunnerPoller } from "./poller";
import { runSessionLoop, defaultWaitGate } from "./session-loop";
import { runStageRound, type RoundDeps } from "./rounds";
import { createAgent } from "../../agents/registry";
import { resolveDefaultProvider } from "../../core/default-provider";
import { runRoundAgent, ensureCodebase, produceDiff, submitPrPure, runGit } from "../../core/executor";
import type { SessionStage } from "./types";
import { log } from "../../core/logger";

// 按 spec §14.7 barrel 统一导出类型，供消费方统一从此模块导入。
export * from "./types";

// 注：CLI 命令组（registerRunnerCommands）由 Task 8 的 src/cli/runner.ts 提供，
// 并直接在 src/cli/index.ts 注册——不经此 barrel 转发（避免 daemon 模块依赖 cli 模块）。

let _poller: RunnerPoller | null = null;
/** 当前跑 session 的 AbortController（dispose 时先 abort，再等 loop 结束，最后释放锁）。 */
let _loopController: AbortController | null = null;
/** 当前 session loop 的 Promise（用于 dispose 等待循环结束后再释放锁）。 */
let _loopPromise: Promise<void> | null = null;

/** 默认成本闸门（§4.3）。 */
const COST_LIMITS = { sessionMax: 30, stageMax: 5 };
const ROUND_TIMEOUT_MS = 30 * 60_000; // 单 round 30 分钟墙钟
const WAIT_POLL_MS = 30_000;          // WAIT/gate 轮询 30s（§4.3）

/**
 * stage → agent permission_mode（纯映射，便于单测——createAgent 需 provider 解析，难直测）。
 * clarify/spec/eng_review/ui_review/dev 都要跑 git/grep 探索代码 → bypassPermissions
 * （autopilot 无「Bash 只读、禁写」模式，default/auto 拒 Bash 会让 headless 子进程探索不了代码 =
 * 产垃圾 artifact「撞墙」，审查修正 #5 / CLAUDE.md）。只读探索由 STAGE_SYSTEM prompt 约束「不改文件」。
 * pr/done 不需 git 探索，留 undefined（pr 的 commit/push 走 submitPrPure 而非 agent Bash）。
 */
export function runnerPermissionMode(stage: SessionStage): string | undefined {
  return stage === "pr" || stage === "done" ? undefined : "bypassPermissions";
}

/** 把 A1 executor 公共面 + git 操作绑成 rounds 的 RoundDeps（生产装配）。 */
function buildRoundDeps(backend: HttpRunnerBackend, accumulated: string): RoundDeps {
  return {
    buildAgent: (stage: SessionStage) => createAgent({
      name: `runner-${stage}`,
      provider: resolveDefaultProvider(),
      permission_mode: runnerPermissionMode(stage),
      max_turns: stage === "dev" ? 40 : 15,
    }),
    runRoundAgent,
    ensureCodebase,
    produceDiff,
    submitPrPure,
    getGitToken: (sid, repoId) => backend.getGitToken(sid, repoId),
    resetToBase: (cwd, base) => {
      runGit(["fetch", "origin", base], cwd, false);
      runGit(["reset", "--hard", `origin/${base}`], cwd, false);
      runGit(["clean", "-fdx"], cwd, false);
    },
    accumulated,
  };
}

/**
 * mode:runner daemon 入口（§6.3）：要求已注册凭证 + 配 control_plane_url。
 * 起 poller：领到 session → runSessionLoop（rounds 绑真实 executor，waitGate 走 defaultWaitGate）。
 */
export function initRunnerMode(): void {
  const creds = loadCredentials();
  if (!creds) {
    log.error("mode:runner 但未注册 runner —— 先运行 `autopilot runner register --url <reqgenie>`。daemon 不启 poller。");
    return;
  }
  const cfg = loadRunnerConfig();
  const backend = new HttpRunnerBackend(creds);
  _poller = new RunnerPoller(backend, {
    pollWaitSeconds: cfg.poll_wait_seconds ?? 50,
    heartbeatMs: (cfg.heartbeat_seconds ?? 30) * 1000,
    runSession: async (sessionId: string) => {
      // 每个 session 独享 AbortController——dispose 时先 abort 再等 loop 结束再释放锁。
      const controller = new AbortController();
      _loopController = controller;
      const loop = runSessionLoop(sessionId, backend, {
        runStageRound: (session, accumulated) => runStageRound(session, buildRoundDeps(backend, accumulated)),
        pollMs: WAIT_POLL_MS,
        limits: COST_LIMITS,
        roundTimeoutMs: ROUND_TIMEOUT_MS,
        waitGate: (gateId, sid) => defaultWaitGate(backend, gateId, sid, WAIT_POLL_MS, controller.signal),
        signal: controller.signal,
      });
      _loopPromise = loop;
      try {
        await loop;
      } finally {
        if (_loopController === controller) { _loopController = null; _loopPromise = null; }
      }
    },
  });
  _poller.start();
}

/** dispose 顺序：先 abort loop（止损），再等 loop 结束，最后走 poller.dispose（释放锁 + deregister）。 */
export async function disposeRunnerMode(): Promise<void> {
  // 1. abort 当前正在跑的 session loop
  if (_loopController) {
    _loopController.abort();
    _loopController = null;
  }
  // 2. 等 loop 结束（最多 5s，超时后强制继续，不卡 daemon 关闭）
  if (_loopPromise) {
    const timeout = new Promise<void>((r) => setTimeout(r, 5000));
    await Promise.race([_loopPromise.catch(() => {}), timeout]);
    _loopPromise = null;
  }
  // 3. 停 poller（释放 runner.lock + deregister）
  _poller?.dispose();
  _poller = null;
}
