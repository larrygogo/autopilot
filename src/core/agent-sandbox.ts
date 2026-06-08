/**
 * Agent 级即用即焚 sandbox（重构核心机制，零业务知识）。
 *
 * 每个 agent 每次执行都新建一个独立代码副本（git clone --local），跑完销毁，代码状态靠
 * 任务文件夹里的**累积 patch**（artifacts/patches/cumulative.patch）传递，不依赖常驻 clone。
 *
 * 生命周期（runner 包裹 phase 执行）：
 *   acquire  → clone 干净副本 + checkout base + apply 累积 patch（拿到当前全量代码）
 *   (agent 在副本里跑)
 *   capture  → read-write phase：git diff base 覆盖写 cumulative.patch（全量模型）
 *   release  → rmSync 临时副本（即用即焚）
 *
 * 全量 patch 模型（用户拍板「先全量跑通再优化增量」）：只维护一个 cumulative.patch，每个
 * read-write phase 用相对 base 的全量 diff 覆盖它，下个 phase apply 它。无 apply 链、无串行冲突。
 *
 * 源仓库零痕迹：clone --local 只读源仓库；临时副本纯 rmSync 销毁，绝不碰源仓库 .git。
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { AUTOPILOT_HOME } from "../index";
import { getTaskWorktreeMeta, getTaskArtifactsDir } from "./sandbox";
import { createLogger } from "./logger";

const log = createLogger("agent-sandbox");
const TASK_ID_RE = /^[\w.\-]+$/;

export interface AgentSandboxHandle {
  taskId: string;
  phase: string;
  runId: string;
  /** 临时代码副本工作树（注入 task context 当 cwd） */
  dir: string;
  code: "read-only" | "read-write";
  /** 交付分支 + base（capture diff / submit_pr push 用） */
  branch: string;
  base: string;
}

/** 临时 agent 副本容器 runtime/tasks/<id>/.agent-runs（即焚，可随时清空不丢状态）。 */
function agentRunsDir(taskId: string): string {
  if (!TASK_ID_RE.test(taskId)) throw new Error(`非法 task ID：${taskId}`);
  return join(AUTOPILOT_HOME, "runtime", "tasks", taskId, ".agent-runs");
}

/** 累积 patch（代码状态唯一载体）artifacts/patches/cumulative.patch。 */
export function cumulativePatchPath(taskId: string): string {
  return join(getTaskArtifactsDir(taskId), "patches", "cumulative.patch");
}

function git(args: string[], cwd?: string): { code: number; stdout: string; stderr: string } {
  const p = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return {
    code: p.exitCode,
    stdout: p.stdout ? new TextDecoder().decode(p.stdout) : "",
    stderr: p.stderr ? new TextDecoder().decode(p.stderr) : "",
  };
}

/**
 * 建即焚副本：clone --local + remote set-url + checkout base→branch + apply 累积 patch。
 * 返回 null = 工作流无代码仓库（无 .worktree.json/deliver 元数据），调用方按"无代码沙盒"处理。
 * 抛错 = clone / apply patch 失败（落入 runner 失败指纹机制）。
 */
export function acquireAgentSandbox(
  taskId: string,
  phase: string,
  code: "read-only" | "read-write",
): AgentSandboxHandle | null {
  const meta = getTaskWorktreeMeta(taskId);
  if (!meta || !meta.workspace_path) {
    log.warn("acquireAgentSandbox: 无交付元数据（工作流无代码仓库？）[task=%s phase=%s]", taskId, phase);
    return null;
  }
  if (!existsSync(join(meta.workspace_path, ".git"))) {
    log.warn("acquireAgentSandbox: workspace %s 非 git 仓库；跳过代码沙盒 [task=%s]", meta.workspace_path, taskId);
    return null;
  }

  const runId = String(Date.now());
  const dir = join(agentRunsDir(taskId), `${phase}-${runId}`);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, ".."), { recursive: true });

  // 1. 本地硬链接 clone（源仓库只读、零痕迹）
  const cl = git(["clone", "--local", meta.workspace_path, dir]);
  if (cl.code !== 0) {
    throw new Error(`agent sandbox clone 失败 [task=${taskId} phase=${phase}]: ${cl.stderr.slice(0, 300)}`);
  }

  // 2. 修正 origin → GitHub（push 用），否则 push 推回本地源仓库
  if (meta.remote_url) {
    git(["-C", dir, "remote", "set-url", "origin", meta.remote_url]);
  }

  // 3. 基于 base 建交付分支
  const co = git(["-C", dir, "checkout", "-B", meta.branch, meta.base]);
  if (co.code !== 0) {
    log.warn("acquireAgentSandbox: 建交付分支失败 [task=%s branch=%s base=%s]: %s",
      taskId, meta.branch, meta.base, co.stderr.slice(0, 200));
  }

  // 4. apply 累积 patch（全量模型：相对 base 的全量改动）。空/不存在则 no-op。
  const patch = cumulativePatchPath(taskId);
  if (existsSync(patch)) {
    const ap = git(["-C", dir, "apply", "--3way", patch]);
    if (ap.code !== 0) {
      rmSync(dir, { recursive: true, force: true });
      throw new Error(`agent sandbox apply 累积 patch 失败 [task=${taskId} phase=${phase}]: ${ap.stderr.slice(0, 300)}`);
    }
  }

  log.info("acquireAgentSandbox [task=%s phase=%s code=%s dir=%s]", taskId, phase, code, dir);
  return { taskId, phase, runId, dir, code, branch: meta.branch, base: meta.base };
}

/**
 * 提取本次改动 → 覆盖写 cumulative.patch（全量模型）。仅 read-write phase 调用。
 * deliver phase（submit_pr）由 runner 跳过本步（它消费 patch、不回写）。
 */
export function captureAgentSandbox(handle: AgentSandboxHandle): { patchWritten: boolean } {
  if (handle.code !== "read-write") return { patchWritten: false };

  git(["-C", handle.dir, "add", "-A"]);
  // staged 改动 vs base = 相对 base 的全量 diff（含新增/删除/修改）
  const d = git(["-C", handle.dir, "diff", "--cached", handle.base]);
  if (d.code !== 0) {
    log.warn("captureAgentSandbox: git diff 失败 [task=%s phase=%s]: %s",
      handle.taskId, handle.phase, d.stderr.slice(0, 200));
    return { patchWritten: false };
  }
  const patchPath = cumulativePatchPath(handle.taskId);
  mkdirSync(join(patchPath, ".."), { recursive: true });
  writeFileSync(patchPath, d.stdout);
  const written = d.stdout.trim().length > 0;
  log.info("captureAgentSandbox [task=%s phase=%s patch=%d bytes]", handle.taskId, handle.phase, d.stdout.length);
  return { patchWritten: written };
}

/** 销毁临时副本（即用即焚）。不丢代码状态（在 cumulative.patch 里）。 */
export function releaseAgentSandbox(handle: AgentSandboxHandle): void {
  try {
    rmSync(handle.dir, { recursive: true, force: true });
  } catch (e: unknown) {
    log.warn("releaseAgentSandbox: 销毁失败 [task=%s dir=%s]: %s",
      handle.taskId, handle.dir, e instanceof Error ? e.message : String(e));
  }
}

/** 清空任务的所有即焚副本残留（重跑 / 清理时用）。 */
export function purgeAgentRuns(taskId: string): void {
  try {
    const d = agentRunsDir(taskId);
    if (existsSync(d)) rmSync(d, { recursive: true, force: true });
  } catch { /* ignore */ }
}
