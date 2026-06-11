/**
 * Autopilot 事件总线类型定义。
 *
 * 历史上这里的事件类型定义在 `daemon/protocol.ts`，而 core 模块发射事件却
 * 需要反向 import daemon —— 形成不健康的依赖方向。本文件把事件协议下沉到
 * core，作为 core 内部 + daemon WebSocket 协议共享的真相源头。
 *
 * `daemon/protocol.ts` 仍保留 ClientMessage / ServerMessage / DaemonStatus
 * 等 WebSocket / HTTP 协议类型，并 re-export 此处的 AutopilotEvent 以保留
 * 既有 import 路径。
 */

import type { Task } from "./db";
import type { ChatMessage } from "./sessions";
import type { Schedule } from "./schedules";
import type { Notification } from "./notification-types";

export type AutopilotEvent =
  | { type: "task:created"; payload: { task: Task } }
  | { type: "task:updated"; payload: { task: Task; fields: string[] } }
  | { type: "task:deleted"; payload: { taskId: string; parentTaskId: string | null } }
  | { type: "task:transition"; payload: { taskId: string; from: string; to: string; trigger: string; note: string | null } }
  | { type: "phase:started"; payload: { taskId: string; phase: string; label: string } }
  | { type: "phase:completed"; payload: { taskId: string; phase: string } }
  | { type: "phase:awaiting"; payload: { taskId: string; phase: string } }
  | { type: "phase:error"; payload: { taskId: string; phase: string; error: string } }
  | { type: "task:asking"; payload: { taskId: string; phase: string; question: string } }
  | { type: "task:answered"; payload: { taskId: string; phase: string } }
  | { type: "log:entry"; payload: { taskId?: string; phase: string; level: string; message: string; timestamp: string } }
  | { type: "watcher:recovery"; payload: { taskId: string; phase: string; fromStatus: string; toStatus: string } }
  | { type: "daemon:status"; payload: { version: string; uptime: number; pid: number; taskCounts: Record<string, number> } }
  | { type: "config:updated"; payload: Record<string, never> }
  | { type: "workflow:reloaded"; payload: Record<string, never> }
  | { type: "chat:delta"; payload: { sessionId: string; delta: string } }
  | { type: "chat:complete"; payload: { sessionId: string; message: ChatMessage } }
  | { type: "chat:error"; payload: { sessionId: string; error: string } }
  | { type: "schedule:created"; payload: { schedule: Schedule } }
  | { type: "schedule:updated"; payload: { schedule: Schedule } }
  | { type: "schedule:deleted"; payload: { scheduleId: string } }
  | { type: "schedule:fired"; payload: { schedule: Schedule; taskId: string } }
  | { type: "projects:changed"; payload: { id: string; action: "create" | "update" | "delete" } }
  | { type: "workspaces:changed"; payload: { id: string; action: "create" | "update" | "delete" } }
  | { type: "requirement:status-changed"; payload: { id: string; from: string; to: string; reason?: string | null } }
  | { type: "requirement:questions-updated"; payload: { id: string } }
  | { type: "requirement:all-questions-resolved"; payload: { id: string } }
  // ── Clarifier 重设计（PR-A）新增事件 ──
  | { type: "requirement:question-resolved"; payload: { id: string; question_id: string } }
  | { type: "requirement:active-question-changed"; payload: { id: string; question_id: string | null } }
  | { type: "requirement:spec-revised"; payload: { id: string; revision_id: number } }
  | { type: "requirement:clarifier-error"; payload: { id: string; reason: string } }
  | { type: "requirement:schedule-error"; payload: { id: string; reason: string } }
  // CI 自动修复触顶（pr-poller）：同一交付 PR 的 CI 失败自动修复达上限，停下报人
  | { type: "requirement:ci-fix-limit"; payload: { id: string; pr_number: number; reason: string } }
  // Provider 健康度（反应式 + 主动 CLI 探测）
  | { type: "provider:health-changed"; payload: { provider: string; healthy: boolean; reason?: string; ts: number } }
  | { type: "provider:health-snapshot"; payload: { states: import("./provider-health").ProviderHealthState[]; ts: number } }
  // Clarifier 进度反馈（内存态，daemon 重启即清）
  | { type: "requirement:clarifier-round-update"; payload: import("../daemon/clarifier-progress").ClarifierRoundState }
  // Phase 5 — 运行中 task 追加 prompt（spec §3.8）
  | { type: "task:prompt-queued"; payload: { taskId: string; source: string; queued_at: number } }
  | { type: "task:prompt-answered"; payload: { taskId: string; source: string } }
  | { type: "phase:pending-prompts-unconsumed"; payload: { taskId: string; phase: string; count: number; preview: string[] } }
  // Phase 6 — prompt phase handoff 协议（spec §3.10）
  | { type: "phase:handoff-incomplete"; payload: { taskId: string; phase: string; missing: string[] } }
  // 通知（事件型通知流，notifications 表；read/all_read/dismissed 由 RPC handler 写库后广播）
  | { type: "notification:created"; payload: { notification: Notification } }
  | { type: "notification:read"; payload: { ids: number[] } }
  | { type: "notification:all_read"; payload: Record<string, never> }
  | { type: "notification:dismissed"; payload: { id: number } };
