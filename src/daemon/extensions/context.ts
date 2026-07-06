/**
 * 扩展点 API — 接口定义 + 宿主绑定工厂
 *
 * Extension:        扩展实现此接口（id / enabled / init / dispose）。
 * ExtensionContext: 宿主为每个扩展提供的隔离视图，所有写操作经 act.*（Single-Writer）。
 * createExtensionContext: 宿主内部工厂，供 registry.ts 调用；返回 ctx + registeredHandlers
 *                         以便宿主在 dispose 时统一 offEvent，扩展无需自行清理事件。
 *
 * 约束：
 * - 此文件不得引入任何 reqgenie / selfhosted 字面量（业务知识在插件内）。
 * - ctx.act 是 Single-Writer 白名单；扩展禁止直接操作 DB。
 */

import type { AutopilotEvent } from "../../core/events";
import { createLogger } from "../../core/logger";
import { onEvent, offEvent } from "../../core/event-bus";
import { mkdirSync } from "fs";
import { join } from "path";
import { AUTOPILOT_HOME } from "../../index";
import { loadConfig } from "../../core/config";

// ── core read ──────────────────────────────────────────────────────────────
import {
  getRequirementById,
  listInflightRequirementsBySource,
  createRequirement as coreCreateRequirement,
  setRequirementStatus,
  setRequirementWorkspaces,
  finishClarification as coreFinishClarification,
  type Requirement,
  type InflightRequirement,
  type CreateRequirementOpts,
} from "../../core/requirements";
import {
  listComments,
  createComment,
  nextCommentId,
  resolveComment as coreResolveComment,
  type Comment,
  type CommentKind,
  type CommentFromRole,
} from "../../core/requirements/comments";
import { listSubPrs, type RequirementSubPr } from "../../core/requirements/sub-prs";
import {
  listTasksByRequirement,
  listTaskPhaseEvents,
  getTask,
  type Task,
} from "../../core/db";
import { cancelRequirementWithTasks } from "../task-actions";
import {
  createWorkspace,
  nextWorkspaceId,
  listWorkspaces,
  type Workspace,
} from "../../core/sandbox/workspaces";
import { loadGitConfig } from "../../core/config";
import { probeRemote, parseGithubFromRemote } from "../../core/sandbox/workspace-health";
import { runClarifierRound } from "../requirement-clarifier";

// ── 接口 ───────────────────────────────────────────────────────────────────

/** 扩展生命周期接口。 */
export interface Extension {
  id: string;
  enabled(): boolean;
  init(ctx: ExtensionContext): void | Promise<void>;
  dispose(): void | Promise<void>;
  /** 可选：自报展示状态（键=业务标签、值可序列化），供 extensions.list RPC / Web 设置页展示。 */
  status?(): Record<string, unknown>;
  /**
   * 可选：动作调用（供通用 RPC extensions.invoke 路由，如「注册」）。
   * 动作名与参数语义完全由扩展定义；未运行时也可被调（注册正是发生在启用之前）。
   */
  invoke?(action: string, params: Record<string, unknown>): Promise<unknown> | unknown;
}

/** phase 事件条目（与 mirror-pusher.ts PhaseEventSnapshot 形状兼容，结构类型系统保证）。 */
export interface PhaseEventEntry {
  run_seq: number;
  phase: string;
  label: string;
  state: string;
  started_at: string | null;
  ended_at: string | null;
  seq: number;
  run_kind?: string;
}

/** addComment 入参（避免泄露 CommentKind/CommentFromRole 给扩展）。 */
export interface AddCommentParams {
  requirement_id: string;
  kind: CommentKind;
  from_role: CommentFromRole;
  body: string;
  parent_id?: string | null;
}

/**
 * 宿主为扩展提供的隔离上下文。
 * 所有写操作必须经 act.*（不允许直接操作 DB）。
 */
export interface ExtensionContext {
  /** 绑定扩展 id 的日志器（前缀 ext:<id>）。 */
  log: ReturnType<typeof createLogger>;

  /**
   * 订阅事件总线事件。
   * 宿主记录所有 handler，dispose 时统一调用 offEvent，扩展无需手动清理。
   */
  on(type: string, handler: (event: AutopilotEvent) => void): void;

  read: {
    /** 按 id 读取需求（不存在返回 null）。 */
    requirement(id: string): Requirement | null;
    /** 列出处于非终态、来源为 source 的需求。 */
    inflightBySource(source: string): InflightRequirement[];
    /** 列出需求的全部评论（含问答 / feedback / handoff）。 */
    comments(reqId: string): Comment[];
    /** 列出需求的全部交付 PR。 */
    subPrs(reqId: string): RequirementSubPr[];
    /**
     * 列出需求最新 run 的 phase 事件（已映射为显示格式）。
     * 与 mirror-pusher MirrorPusherDeps.listPhaseEvents 返回形状兼容。
     */
    phaseEvents(reqId: string): PhaseEventEntry[];
    /** 按 taskId 读取 task（不存在返回 null）。 */
    task(taskId: string): Task | null;
  };

  act: {
    /** 创建需求，返回 req.id。 */
    createRequirement(opts: CreateRequirementOpts): string;
    /** 转换需求状态（经状态机校验 + emit）。 */
    setStatus(id: string, to: string, opts?: { reason?: string | null }): void;
    /** 整体替换需求的代码库集合（PUT 语义）。 */
    setWorkspaces(reqId: string, wsIds: string[]): void;
    /**
     * 把 repo_urls 数组中每个 URL 映射到本机已注册的 workspace_id。
     * 未注册时自动探测可达性并创建；失败跳过 warn，不抛。
     * （原 selfhosted-connector/index.ts 的 resolveWorkspaceIds 升格为宿主能力）
     */
    resolveWorkspacesByUrls(projectId: string, urls: string[]): Promise<string[]>;
    /** 添加评论（纯写入，不附带状态转换副作用；副作用由扩展自行调用 setStatus）。 */
    addComment(params: AddCommentParams): void;
    /** 标记评论为已解决。 */
    resolveComment(commentId: string): void;
    /** 完成澄清：resolve active_question + 转 awaiting_approval。 */
    finishClarification(id: string): void;
    /** 重新触发澄清轮。 */
    retryClarify(id: string): Promise<void>;
    /** 取消需求（级联停旗下 task）。 */
    cancelRequirement(id: string): void;
  };

  config: {
    /** 读取 config.json 的顶层 key 段（不存在返回 null）。 */
    section(key: string): unknown;
  };

  storage: {
    /** 返回扩展专属持久化目录（AUTOPILOT_HOME/extensions/<id>/），自动 mkdir -p。 */
    dir(): string;
  };
}

// ── 工厂 ───────────────────────────────────────────────────────────────────

/**
 * 创建绑定 extensionId 的 ExtensionContext 实例。
 * 宿主（registry.ts）调用；扩展不直接构造。
 *
 * 返回 { ctx, registeredHandlers }：
 * - ctx 传给扩展的 init(ctx)
 * - registeredHandlers 由宿主持有，dispose 时统一 offEvent
 */
export function createExtensionContext(extensionId: string): {
  ctx: ExtensionContext;
  registeredHandlers: Array<[string, (e: AutopilotEvent) => void]>;
} {
  const log = createLogger(`ext:${extensionId}`);
  const registeredHandlers: Array<[string, (e: AutopilotEvent) => void]> = [];

  const ctx: ExtensionContext = {
    log,

    on(type: string, handler: (event: AutopilotEvent) => void): void {
      onEvent(type, handler);
      registeredHandlers.push([type, handler]);
    },

    read: {
      requirement(id: string) {
        return getRequirementById(id);
      },

      inflightBySource(source: string) {
        return listInflightRequirementsBySource(source);
      },

      comments(reqId: string) {
        return listComments(reqId, {});
      },

      subPrs(reqId: string) {
        return listSubPrs(reqId);
      },

      phaseEvents(reqId: string): PhaseEventEntry[] {
        // 全部 run 的 phase 事件（执行历史多轮：重跑/fix run 各一组），
        // run_seq = 该 run 的轮次号（task.seq），seq = 阶段在 run 内顺序。
        const tasks = listTasksByRequirement(reqId);
        if (tasks.length === 0) return [];
        const sorted = [...tasks].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
        const out: PhaseEventEntry[] = [];
        for (const task of sorted) {
          const events = listTaskPhaseEvents(task.id);
          const runSeq = task.seq ?? 0;
          const runKind = task.kind ?? "execution";
          events.forEach((pe, i) => {
            out.push({
              run_seq: runSeq,
              phase: pe.phase,
              label: pe.phase,
              state: pe.status === "done" ? "completed" : pe.status,
              started_at: pe.started_at ? new Date(pe.started_at).toISOString() : null,
              ended_at: pe.ended_at ? new Date(pe.ended_at).toISOString() : null,
              seq: i,
              run_kind: runKind,
            });
          });
        }
        return out;
      },

      task(taskId: string) {
        return getTask(taskId);
      },
    },

    act: {
      createRequirement(opts: CreateRequirementOpts): string {
        const req = coreCreateRequirement(opts);
        return req.id;
      },

      setStatus(id: string, to: string, opts?: { reason?: string | null }): void {
        setRequirementStatus(id, to, opts);
      },

      setWorkspaces(reqId: string, wsIds: string[]): void {
        setRequirementWorkspaces(reqId, wsIds);
      },

      async resolveWorkspacesByUrls(projectId: string, urls: string[]): Promise<string[]> {
        if (urls.length === 0) return [];
        const existing = listWorkspaces({ projectId });
        const result: string[] = [];
        const gitCfg = loadGitConfig();

        for (const url of urls) {
          const found = existing.find((w: Workspace) => w.remote_url === url);
          if (found) {
            result.push(found.id);
            continue;
          }
          try {
            const probe = probeRemote(url, gitCfg.token);
            if (!probe.ok) {
              log.warn("repo_url 不可达（跳过）: %s", url);
              continue;
            }
            const parsed = parseGithubFromRemote(url);
            const alias =
              parsed?.repo ?? url.split("/").pop()?.replace(/\.git$/, "") ?? "repo";
            const ws = createWorkspace({
              id: nextWorkspaceId(),
              project_id: projectId,
              alias,
              remote_url: url,
              default_branch: probe.defaultBranch ?? "main",
              github_owner: parsed?.owner ?? null,
              github_repo: parsed?.repo ?? null,
            });
            result.push(ws.id);
            log.info("自动注册 workspace alias=%s url=%s id=%s", alias, url, ws.id);
          } catch (e: unknown) {
            log.warn(
              "自动注册 workspace 失败（跳过）url=%s: %s",
              url,
              e instanceof Error ? e.message : String(e),
            );
          }
        }
        return result;
      },

      addComment(params: AddCommentParams): void {
        const id = nextCommentId();
        createComment({
          id,
          requirement_id: params.requirement_id,
          kind: params.kind,
          from_role: params.from_role,
          body: params.body,
          parent_id: params.parent_id ?? null,
        });
      },

      resolveComment(commentId: string): void {
        coreResolveComment(commentId);
      },

      finishClarification(id: string): void {
        coreFinishClarification(id);
      },

      async retryClarify(id: string): Promise<void> {
        await runClarifierRound(id);
      },

      cancelRequirement(id: string): void {
        cancelRequirementWithTasks(id);
      },
    },

    config: {
      section(key: string): unknown {
        try {
          const raw = loadConfig();
          return raw[key] ?? null;
        } catch {
          return null;
        }
      },
    },

    storage: {
      dir(): string {
        const d = join(AUTOPILOT_HOME, "extensions", extensionId);
        mkdirSync(d, { recursive: true });
        return d;
      },
    },
  };

  return { ctx, registeredHandlers };
}
