# WEB-08：Web WS 被动断线 fast-fail — 设计稿

> 来源：architect subagent 对 backlog WEB-08 的设计（2026-06-09），主 agent git-show 核实后落盘。未排实施计划。
> **硬红线**：不回归 9ed3042 的首屏 RPC 假死修复；不破坏 38ec63b 的 `restarting` 主动重启路径。

**目标**：commit 9ed3042 声称「真断线 fast-fail，行为不变」但实现里**被动断线也等满 waitForOpen 5s**（空头支票）。引入 `everConnected` 区分「首连 CONNECTING」（必须等，保首屏修复）与「被动掉线 backoff」（该 fast-fail），把承诺补成真。**只做这一件事，不造离线框架。**

---

## 0. 核实纪要（主 agent git-show 复核，本轮无 architect 事实错误）

| 事实 | 状态 |
|------|------|
| `rpcCall`（ws-singleton.ts:256-264）：`if(restarting) throw RESTARTING` → `waitForOpen(5000)` → 超时 `DISCONNECTED`，**对「ws 非 OPEN」一刀切走 5s 等待、无首连/被动断线区分** | ✅ 亲验 |
| line 252 注释「真断线场景：等不到 OPEN 仍会 reject DISCONNECTED，行为不变」= 空头支票（被动断线也卡 5s） | ✅ 亲验 |
| 9ed3042 实修「首屏假死」：此前 ws 非 OPEN 立即 reject，首屏 useEffect 的 RPC 全被毙→满屏 toast；修法加 `waitForOpen(5000)` gate | ✅ architect git show |
| 38ec63b 的全局 `restarting`（ws-singleton.ts:240/241）唯一调用方是 **Settings.tsx:288/322/330**（改 host/port 主动 daemon.restart） | ✅ 亲验 |
| **architect 自我纠正**：`TaskProgressCard.tsx:68` 的 `setRestarting` 是组件自己的 `useState`（按钮 busy 态），**不是** ws-singleton 全局 restarting | ✅ 亲验（纠正属实，实施/写测试别去 TaskProgressCard 找 restarting 钩子） |
| 被动断线（onclose→backoff 重连）完全不碰 restarting → 落入 waitForOpen 5s 干等 = WEB-08 核心 bug | ✅ 亲验 |
| ws-singleton 零单测；`tests/ws-rpc-client.test.ts` 只测底层 `WsRpcClient`（注入 sendRaw/isOpen），帮不上 ws-singleton | ✅ 亲验 |
| 下游：`rpcCall` reject `DISCONNECTED` → useApi.requestRpc 归一成「WebSocket 未连接（daemon 是否在运行？）」→ toast；`DaemonOfflineBanner` 另行 5s 去抖显红条（与 rpcCall 5s 是两套独立计时，本设计不动） | ✅ architect 核实 |

---

## 1. 连接阶段判别：新增单调布尔 `everConnected`

一个瞬时 `state`（connecting/connected/disconnected）表达不了「这次 connecting 是首连还是断线重连」。正交叠加一个生命周期位：

```ts
// 本会话内是否曾成功建立过 WS 连接（onopen 至少触发过一次）。
// 区分「首连 CONNECTING」(false) 与「被动掉线重连」(true)——两者 ws 都非 OPEN 但语义相反：
// 首连必须等（保 9ed3042 首屏修复），被动掉线该 fast-fail。
// 单调：onopen 置 true，永不在重连中回 false（仅 disconnect/_resetWsSingletonForTest 复位）。
let everConnected = false;
```
**置位**：`sock.onopen` 内第一次成功 `everConnected = true`。**不用阶段枚举**——`state`（瞬时）+ `everConnected`（生命周期）+ `restarting`（主动重启）三个正交标志已能精确表达全部场景，合成大枚举徒增转换点与测试面（YAGNI）。

### 三态判别矩阵
| 场景 | ws.readyState | everConnected | restarting | rpcCall |
|------|--------------|---------------|------------|---------|
| 首连 CONNECTING（首屏，从未连上） | CONNECTING | **false** | false | **等** waitForOpen(5000)（保 9ed3042） |
| 已连上 | OPEN | true | false | 直接发 |
| **被动掉线 backoff**（daemon 崩/网抖/睡眠唤醒） | CLOSED | **true** | false | **fast-fail DISCONNECTED** |
| 主动 daemon.restart（Settings） | 非 OPEN | 任意 | **true** | fast-fail RESTARTING（现状不动） |

---

## 2. rpcCall 改造（判别优先级，短路）

```ts
export async function rpcCall<T = unknown>(method, params?, opts?): Promise<T> {
  // 1. 主动 daemon 重启窗口（38ec63b，不动，最高优先级）
  if (restarting) throw new RpcCallError("RESTARTING", "daemon 正在重启，请稍后再试");
  ensureConnected();
  if (ws?.readyState !== WebSocket.OPEN) {
    if (!everConnected) {
      // 2. 首连 CONNECTING：仍等，保住 9ed3042 首屏修复（硬红线）
      const ok = await waitForOpen(5000);
      if (!ok) throw new RpcCallError("DISCONNECTED", "WebSocket 未连接，等待超时");
    } else {
      // 3. 被动掉线（曾连上、非主动重启、当前断开/重连中）：同步 fast-fail，不卡 5s
      throw new RpcCallError("DISCONNECTED", "WebSocket 已断开（重连中）");
    }
  }
  return rpc.call<T>(method, params, opts);
}
```
`restarting` 在第 1 步已拦截，故第 3 步的 `everConnected` 分支天然只覆盖被动掉线，不误伤主动重启。

**复用 `DISCONNECTED` code，不发明新 code**：下游 useApi/toast/DaemonOfflineBanner 已对齐该语义；用户视角「被动掉线」和「首连失败」同是 daemon 没响应，区别只在反馈速度（立刻 vs 5s），而速度正是 fast-fail 解决的。`message` 可微调「已断开（重连中）」便于日志区分，`code` 不变。

**不改 `waitForOpen` 本体**（它现只被首连分支调，职责单一正确）。被动掉线分支**纯 fast-fail、不给极短宽限窗口**（backoff 起步就 1s，300ms 内重连成功概率极低，徒增难测路径，YAGNI）。

---

## 3. 回归面 + 必钉死不变式

**最危险回归：首屏假死（9ed3042）**——`everConnected` 逻辑写反（首连误判成曾连上走 fast-fail）即满屏「WebSocket 未连接」toast。硬红线，测试钉死。

| # | 不变式 | 断言 |
|---|--------|------|
| **INV-1** | 首连期（everConnected===false，ws CONNECTING）rpcCall **必须等**、不被 fast-fail；窗口内 onopen 后正常返回 | 注入不立即 OPEN 的 fake ws → rpcCall 不立即 reject → 触发 onopen → 断言 resolve |
| **INV-2** | 被动掉线期（everConnected===true，ws 非 OPEN、非 restarting）rpcCall **立即 fast-fail** DISCONNECTED，不卡 5s | onopen 置 everConnected → onclose → rpcCall → 断言**同步/下一 microtask** reject DISCONNECTED（被动分支是同步 throw，无需 fake timer） |
| INV-3 | restarting===true 时 rpcCall 立即 reject RESTARTING，优先级高于 everConnected（守 38ec63b） | setRestarting(true) → rpcCall → 断言立即 reject RESTARTING |

**ws-singleton 可测性（当前零单测，最大短板）**：模块靠 `typeof globalThis.WebSocket === "undefined"` 判 no-op。测试注入 fake WebSocket 类到 `globalThis.WebSocket`，用 `_resetWsSingletonForTest()` 复位，手动驱动 `onopen()`/`onclose()` 控制 everConnected。Fake 最小面：构造记录实例、`readyState` 可设、暴露触发 onopen/onclose 的钩子、send/close no-op。新建 `tests/ws-singleton-rpc.test.ts`（与 ws-rpc-client.test.ts 分开）。优先**黑盒**（通过 rpcCall 快/慢失败反推 everConnected），仅当难写才加只读 `_everConnectedForTest()` getter。

**其他回归点（核查非阻塞）**：`DaemonOfflineBanner` 5s 去抖看 wsState 不看 rpcCall，不受影响；`subscribeChannel` 走底层 `rpc.call` 不经 rpcCall，本就静默 catch，不受影响；Settings 主动重启 restarting 优先级最高、不变。

---

## 4. 迁移路径（两阶段，低风险先行）

**阶段 1：零行为变更（先合、可独立回退）**——引入 `everConnected`（onopen 置 true、disconnect/reset 复位 false），**rpcCall 逻辑不变**（仍对所有非 OPEN 走 waitForOpen），把 line 251-254 误导注释（「真断线 fast-fail 行为不变」）改成诚实表述（说明当前被动断线也等满 5s、待阶段 2 切）。`typecheck`+`bun test` 全绿（无行为变化）。

**阶段 2：切 fast-fail（核心）**——rpcCall 加 `else if(everConnected) throw DISCONNECTED`；新建 `tests/ws-singleton-rpc.test.ts` 落 INV-1/2/3 + 首连超时；更新注释为最终三态语义。`bun test` 0 fail + `typecheck` + `build:web`。

拆两阶段：阶段 1 纯增量先还文档债；阶段 2 动行为带测试，出问题 revert 阶段 2、everConnected 留着无害。

---

## 5. YAGNI 边界（明确不做）
仅「区分首连/被动断线，让被动断线别卡 5s」，**不是**离线优先框架。不做：断线 RPC 队列重放、backoff 调参/jitter、离线模式/缓存兜底、被动分支极短宽限窗口、新错误码/文案体系、把 `ConnectionState` 重构成阶段枚举（动它波及 useWebSocket/DaemonOfflineBanner 多 hook 类型）、TUI/CLI 对等（Web 专属连接体验，TUI observer/CLI 一次性命令无此场景）。

---

## 6. 开放/待实施时确认的点（architect 诚实标注）
1. **fake WebSocket 注入具体写法未实测**：`connect()` 用 `new globalThis.WebSocket(getWsUrl())`，`getWsUrl` 读 location（有兜底 `ws://127.0.0.1:6180/ws`），但 `shouldUseToken()`/`getApiToken()` 依赖需在测试 stub 或确认无 token 环境返回安全值。**实施先写一个 fake 注入 smoke 用例验证能驱动 onopen/onclose，再铺 INV。**
2. **INV-2 计时断言**：被动掉线分支是**同步 throw**（§2），故 reject 是同步立即——断言「下一 microtask 就 reject」即可，无需 fake timer。
3. **`disconnect()` 是否复位 everConnected**：disconnect 仅测试/`_resetWsSingletonForTest` 用（grep 确认生产无业务路径调），复位利于测试隔离、对生产无影响，**建议复位**。

## 关键文件
- 主战场 `src/web/src/lib/ws-singleton.ts`（everConnected + rpcCall 分叉 + 注释诚实化）
- 下游归一化 `src/web/src/hooks/useApi.ts`（不改，仅契约锚点）
- 主动重启唯一调用方 `src/web/src/pages/Settings.tsx`（不改，仅核查 restarting 不变）
- 失联横幅 `src/web/src/components/DaemonOfflineBanner.tsx`（不改，仅核查去抖不受影响）
- 新建测试 `tests/ws-singleton-rpc.test.ts`（注入 fake globalThis.WebSocket 黑盒验三态）
