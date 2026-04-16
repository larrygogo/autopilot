import { EventEmitter } from "events";
import type { AutopilotEvent } from "./protocol";

// ──────────────────────────────────────────────
// 事件总线 — 懒激活模式
// ──────────────────────────────────────────────

export const bus = new EventEmitter();
bus.setMaxListeners(200);

let _emitFn: ((event: AutopilotEvent) => void) | null = null;

/**
 * 发射事件。daemon 未启动时是 no-op。
 * core 模块安全调用，无需关心 daemon 是否运行。
 */
export function emit(event: AutopilotEvent): void {
  _emitFn?.(event);
}

/**
 * 激活事件总线。仅 daemon 启动时调用。
 * 激活后，emit() 会将事件发射到 bus 上。
 */
export function enableBus(): void {
  _emitFn = (event) => {
    bus.emit(event.type, event);
    bus.emit("*", event);
  };
}

/**
 * 停用事件总线。daemon 关闭时调用。
 */
export function disableBus(): void {
  _emitFn = null;
}

/**
 * 监听特定类型的事件。
 */
export function onEvent(type: string, handler: (event: AutopilotEvent) => void): void {
  bus.on(type, handler);
}

/**
 * 取消监听。
 */
export function offEvent(type: string, handler: (event: AutopilotEvent) => void): void {
  bus.off(type, handler);
}
