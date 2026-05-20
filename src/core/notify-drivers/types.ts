import type { Task } from "../db";

/**
 * 通知事件类别。调用 notify(task, message, event) 的 event 字段值。
 * 各 driver 用 on_events 白名单过滤。
 */
export type NotifyEvent =
  | "task-done"
  | "task-failed"
  | "phase-awaiting"
  | "info"
  | string;

/** notify driver 收到的 payload */
export interface NotifyPayload {
  task: Task;
  message: string;
  event: NotifyEvent;
}

/** 单个通知 driver 的配置（config.yaml notify.drivers[]） */
export interface NotifyDriverConfig {
  type: string;
  on_events?: NotifyEvent[];
  /** driver 私有字段：slack-webhook 用 url，其他保留扩展 */
  [key: string]: unknown;
}

/** notify driver 接口（spec §3.5） */
export interface NotifyDriver {
  /** driver 名（如 "windows-toast"），与 config.yaml notify.drivers[].type 对应 */
  readonly name: string;
  /** driver 是否可用（平台 + 依赖探测）。enabled=false 时不会被调用 */
  enabled(): boolean | Promise<boolean>;
  /** 发送通知。错误由 driver 内部吞（外层 notify 不阻塞） */
  send(payload: NotifyPayload): Promise<void>;
}

/** driver factory 函数签名（按 config 生产 driver 实例） */
export type NotifyDriverFactory = (cfg: NotifyDriverConfig) => NotifyDriver;
