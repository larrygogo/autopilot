/**
 * 扩展注册表 + 初始化器
 *
 * registerExtension(ext) — 进内存数组（daemon 启动序列调用，initExtensions 之前）。
 * initExtensions()       — 遍历已注册扩展，跳过 enabled()=false 的；
 *                          为每个 enabled 扩展建 ExtensionContext，调 init(ctx)；
 *                          返回统一 dispose 闭包（逆序调各扩展 dispose + offEvent 全部事件）。
 *
 * daemon/index.ts 在 notification-recorder 之后调一次 registerExtension + initExtensions，
 * dispose 接进 daemon 关停清理序列。
 */

import { createLogger } from "../../core/logger";
import { offEvent } from "../../core/event-bus";
import type { AutopilotEvent } from "../../core/events";
import { type Extension, createExtensionContext } from "./context";

const log = createLogger("extensions:registry");

/** 进程内已注册扩展列表（module-level 单例） */
const _extensions: Extension[] = [];

/** 已成功进入 init 流程且未 dispose 的扩展 id（running 判定用） */
const _running = new Set<string>();

/** 注册一个扩展到进程内列表。必须在 initExtensions 调用前完成。 */
export function registerExtension(ext: Extension): void {
  _extensions.push(ext);
  log.info("扩展已注册: %s", ext.id);
}

export interface ExtensionInfo {
  id: string;
  enabled: boolean;
  running: boolean;
  /** 扩展自报的展示状态（键=业务标签）；无 status 方法或调用异常时为 null */
  status: Record<string, unknown> | null;
}

/** 列出所有已注册扩展及其状态（通用宿主能力；status 内容由各扩展自报，宿主零业务知识）。 */
export function listExtensionsInfo(): ExtensionInfo[] {
  return _extensions.map((ext) => {
    let status: Record<string, unknown> | null = null;
    try {
      status = ext.status?.() ?? null;
    } catch {
      status = null;
    }
    return {
      id: ext.id,
      enabled: ext.enabled(),
      running: _running.has(ext.id),
      status,
    };
  });
}

/**
 * 初始化所有已注册的、enabled() 为 true 的扩展。
 *
 * 为每个扩展创建独立的 ExtensionContext（绑定 id、隔离 storage/config/on 归属）；
 * 调用 ext.init(ctx)（同步或异步均支持，async 失败只 warn 不阻塞 daemon 启动）。
 *
 * 返回的 dispose 函数：
 *   - 逆序调各扩展的 dispose()（LIFO）
 *   - 统一 offEvent 所有通过 ctx.on 登记的 handler（扩展无需手动清理事件）
 */
type ExtState = {
  ext: Extension;
  registeredHandlers: Array<[string, (e: AutopilotEvent) => void]>;
};

/** 已初始化扩展的运行态（模块级，供 initExtensions 的 dispose 与 startExtension 共用） */
const _states: ExtState[] = [];

/** 初始化单个扩展（建 ctx → init → 登记状态）。调用方负责 enabled/running 检查。 */
function startOne(ext: Extension): void {
  const { ctx, registeredHandlers } = createExtensionContext(ext.id);

  try {
    const result = ext.init(ctx);
    if (result instanceof Promise) {
      result.catch((e: unknown) => {
        log.error(
          "扩展异步初始化失败: %s — %s",
          ext.id,
          e instanceof Error ? e.message : String(e),
        );
      });
    }
    log.info("扩展已初始化: %s", ext.id);
    _running.add(ext.id);
  } catch (e: unknown) {
    log.error(
      "扩展同步初始化失败: %s — %s",
      ext.id,
      e instanceof Error ? e.message : String(e),
    );
  }

  _states.push({ ext, registeredHandlers });
}

/**
 * 运行期启动单个扩展（如注册凭证落盘后热启动，不必重启 daemon）。
 * 已在运行则 no-op；未注册/未启用抛错。
 */
export function startExtension(id: string): void {
  const ext = _extensions.find((e) => e.id === id);
  if (!ext) throw new Error(`扩展不存在: ${id}`);
  if (_running.has(id)) return;
  if (!ext.enabled()) throw new Error(`扩展未启用: ${id}`);
  startOne(ext);
}

/**
 * 调用扩展自报的动作（Extension.invoke），供通用 RPC extensions.invoke 路由。
 * 动作语义完全由扩展定义（宿主零业务知识）。
 */
export function invokeExtension(
  id: string,
  action: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const ext = _extensions.find((e) => e.id === id);
  if (!ext) throw new Error(`扩展不存在: ${id}`);
  if (!ext.invoke) throw new Error(`扩展不支持动作调用: ${id}`);
  return Promise.resolve(ext.invoke(action, params));
}

export function initExtensions(): () => void {
  for (const ext of _extensions) {
    if (!ext.enabled()) {
      log.info("扩展已跳过（未启用）: %s", ext.id);
      continue;
    }
    startOne(ext);
  }

  return () => {
    // 逆序 dispose（LIFO，与初始化相反）；含运行期经 startExtension 热启的扩展
    const states = _states.splice(0, _states.length);
    for (let i = states.length - 1; i >= 0; i--) {
      const { ext, registeredHandlers } = states[i];
      try {
        const result = ext.dispose();
        if (result instanceof Promise) {
          result.catch((e: unknown) => {
            log.warn(
              "扩展异步 dispose 失败: %s — %s",
              ext.id,
              e instanceof Error ? e.message : String(e),
            );
          });
        }
      } catch (e: unknown) {
        log.warn(
          "扩展同步 dispose 失败: %s — %s",
          ext.id,
          e instanceof Error ? e.message : String(e),
        );
      }

      // 统一 offEvent —— 宿主负责清理所有通过 ctx.on 注册的 handler
      // 若扩展的 dispose() 已 offEvent（如 MirrorPusher.dispose），重复调用为 no-op
      for (const [type, handler] of registeredHandlers) {
        offEvent(type, handler);
      }
      _running.delete(ext.id);
    }
    log.info("所有扩展已停止");
  };
}
