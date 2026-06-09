# A2：服务端鉴权模型 — 设计稿

> 来源：architect subagent 对 backlog A2 的设计（2026-06-09），主 agent 核实承重事实后落盘。未排实施计划。
> 实施前用 writing-plans 拆 TDD 任务。**鉴权是安全敏感热路径，红线：不半修**（上一轮「只改 HTTP 不改 WS」造成半不一致已被回退）。

**目标**：让 JWT 在 LAN 上成为**一等服务端鉴权**——(a) 把「`!API_TOKEN` 全放行」收窄为「`!API_TOKEN && !hasAnyUser()`」让 JWT 被服务端强制；(b) 让 HTTP 和 WS 走**同一个 `authResolve` 函数**，使 WS 也认 JWT cookie，根除半不一致。**只做这两件事，不造 IAM。**

---

## 0. 核实纪要（主 agent 复核）

architect 本轮严谨（自跑 Bun 探针验 F7）。主 agent 再核实全部承重事实，**未发现事实错误**：

| 事实 | 状态 |
|------|------|
| F1：`checkAuth` 首行 `if (!API_TOKEN) return true`（routes.ts:280）在 loopback 检查（281）**之前** → 无 token 时无条件放行，与 hasAnyUser 无关 | ✅ 亲验 |
| loopback 豁免 `isLoopbackSocket`（routes.ts:256，按 socket peer IP 判 127.x/::1） | ✅ 亲验 |
| `extractJwtFromCookie`(auth.ts:116) / `hasAnyUser`(145) / `verifyJwt`(87，async，无效即抛 Promise<JwtPayload>) | ✅ 亲验 |
| 启动门 daemon/index.ts:119 `isExposedHost(host) && !tokenState.is_set && !insecureNoAuth` → **只认 token、不认 hasAnyUser**（SEC-6） | ✅ 亲验 |
| **F7**：Bun WS 升级握手 Request 携带 Cookie 头，`req.headers.get("cookie")` 能读到 | ✅ architect Bun 探针实测 |
| **F8（唯一开放点）**：浏览器同源 WS 握手是否自动带 HttpOnly cookie | ⚠️ architect 基于 RFC 6455 推断、**未真实浏览器实测**。**query-token 退路全程保留，设计两种情况都成立**——F8 成立则半不一致彻底根除，不成立则 LAN 浏览器需额外贴 token（与今天一致） |
| F9：WS 鉴权只在升级握手一次性完成，连上后 RPC 分发不二次校验（JWT 7 天过期不踢已连 socket，单开发者可接受） | ✅ architect 亲验 |

---

## 1. 鉴权模型：三件事定清

### 1.1 API token vs JWT —— 平级两条独立凭证路径（OR 关系，非主从覆盖）
- **API token** = 机器/CI 路径（共享密钥，无身份）。
- **JWT cookie** = 人/浏览器路径（登录后自动带，含 `sub`/`email`）。
- **loopback** = 本机进程零配置豁免（CLI/TUI 命脉）。

判定优先级（短路求值，任一命中即放行）：

| 顺序 | 条件 | 结果 |
|---|------|------|
| 1 | loopback socket | 放行（CLI/TUI 命脉）|
| 2 | 正确 API token（Bearer / X-Autopilot-Token / `?token=`）| 放行（机器路径）|
| 3 | 有效 JWT cookie | 放行（人路径）|
| 4 | `!API_TOKEN && !hasAnyUser()` | 放行（auth 未启用，零配置全新用户）|
| 5 | 以上都不满足 | **401** |

第 4 条把当前 F1 的「`!API_TOKEN` 无条件放行」**收窄为 `!API_TOKEN && !hasAnyUser()`**——这是上次想做但做半截的核心。关键差异：**这次 HTTP 和 WS 用同一张表**（§2），不再 HTTP 强制 JWT 而 WS 不认。

### 1.2 loopback 豁免对 JWT 同样成立（本机浏览器即便 hasAnyUser 也不服务端强制登录）
理由：loopback 是全项目统一可信闸（token/fs/mcp 豁免同款，按内核给的 socket peer IP 不可伪造）；本机强制登录会割裂「CLI 能用、浏览器要登录」；AuthGate 客户端登录页仍渲染（本机登录是 UX 选择非安全边界）；真实安全边界在 LAN（LAN 请求拿不到 loopback 豁免）。
**诚实代价**：本机 `curl 127.0.0.1` 仍绕过登录页读数据——有意接受（SEC-1 audit 已降为 P2「本机进程可信」），堵它要放弃 loopback 豁免、连带锁死 CLI/TUI，YAGNI。

### 1.3 WS 携带 JWT 走 cookie，不需新机制
F7 已验服务端能读握手 cookie → `checkWebSocketAuth` 里可 `extractJwtFromCookie` + `await verifyJwt`。F8 成立则链路天然闭合。退路：web 已有 `?token=` query 路径（ws-singleton.ts:65-76），F8 不成立时 LAN 浏览器回落贴 token。
**async 注意**：`checkWebSocketAuth` 当前同步、`verifyJwt` 是 async → server.ts 升级判定改 `await`。握手只发生一次（F9），verifyJwt 是纯内存 HMAC，开销可忽略。
**不引入** WS 首帧握手鉴权/一次性 ticket（SEC-5 提案）——YAGNI（§6）。

---

## 2. 统一鉴权判定函数（HTTP + WS 同一口径）

抽 `authResolve(req, server): Promise<boolean>`，HTTP 和 WS 升级都调它，消灭两套逻辑漂移：

```ts
// routes.ts —— 统一鉴权裁决（HTTP + WS 共用）。true=放行
export async function authResolve(
  req: Request,
  server: import("bun").Server<undefined> | undefined,
): Promise<boolean> {
  // 1. 本机 loopback 永远豁免（CLI/TUI/本机浏览器命脉，按 socket peer IP）
  if (isLoopbackSocket(server, req)) return true;

  // 2. API token 路径（Bearer / X-Autopilot-Token / ?token=）
  if (API_TOKEN) {
    const header = req.headers.get("authorization") ?? "";
    if (header.startsWith("Bearer ") && tokenEquals(header.slice(7), API_TOKEN)) return true;
    const xToken = req.headers.get("x-autopilot-token");
    if (xToken && tokenEquals(xToken, API_TOKEN)) return true;
    try {
      const q = new URL(req.url).searchParams.get("token");
      if (q && tokenEquals(q, API_TOKEN)) return true;
    } catch { /* URL parse 失败忽略 */ }
  }

  // 3. JWT cookie 路径（HTTP 与 WS 同此分支，F7 已验 WS 握手带 cookie）
  if (hasAnyUser()) {
    const jwt = extractJwtFromCookie(req);
    if (jwt) {
      try { await verifyJwt(jwt); return true; }
      catch (e: unknown) { /* 无效/过期 → 落到下面拒绝 */ }
    }
  }

  // 4. 既没 token 也没用户 → auth 未启用，放行
  if (!API_TOKEN && !hasAnyUser()) return true;

  // 5. 启用了某种 auth 但凭证缺失/无效
  return false;
}
```

HTTP 入口（routes.ts:491-505 现有 JWT fallback 特例删掉，统一进 authResolve）：
```ts
if (path.startsWith("/api/") && !(await authResolve(req, server))) return error("Unauthorized", 401);
```
WS 入口（checkWebSocketAuth 改 async 调 authResolve，server 必填）+ server.ts:40-47 改 `await checkWebSocketAuth`。

各 client 对照（证明无人被锁死）：CLI/TUI→规则1放行；本机浏览器→规则1放行（AuthGate 仍渲染登录页但服务端不强制）；LAN 登录浏览器→规则3 JWT；LAN 未登录→规则5 401；CI/脚本→规则2 token；LAN 陌生→规则5 401；全新用户→规则4放行。

---

## 3. 0.0.0.0 暴露感知（SEC-6）：启动门收紧
现状 F6：启动门只认 token，配 0.0.0.0 + 建了用户但没设 token → 当前 exit 2（逼设 token，即便本意用 JWT 守 LAN）。
A2 后 JWT 服务端一等强制 → 门承认「有 token **或** 有用户」任一即已设防：
```ts
const authConfigured = tokenState.is_set || hasAnyUser();
if (isExposedHost(host) && !authConfigured && !opts.insecureNoAuth) { /* exit 2，文案补「或在 Web 创建登录用户」*/ }
```
`--insecure-no-auth` 逃生口保留。
**已知缺口（YAGNI 不做）**：启动门是启动快照，运行期删光用户又没 token 不会重判 → 回落规则4全放行。极端误操作、单开发者本地不现实；删最后用户时前端警告由 designer 兜（非强制）。

---

## 4. 迁移路径（绝不半修——三处同 PR）

**前置（可独立先合，零行为变更）**：抽 `authResolve`，**第一版行为与现状 100% 等价**（先不加规则3 JWT 分支，只把 checkAuth body 搬进来、HTTP/WS 都改调它）。补「重构等价」测试 + 新增 WS 升级路径镜像同样矩阵。**先把「HTTP/WS 走同一函数」结构钉死**，后续加 JWT 分支自动双路径覆盖，机制上杜绝半不一致。

**核心切片（一个 PR 三处齐改）**：authResolve 加规则3（JWT，async verifyJwt）+ 规则4 收窄；checkWebSocketAuth/server.ts 改 await；启动门改 `is_set || hasAnyUser()`。三者**同 PR** + §5 完整矩阵。

**不被锁死保证**：规则1 loopback 必须在最前短路（JWT 分支任何 bug 都不波及本机 client）；每步合前手验 CLI `task status` 通 + 本机浏览器连 WS 通。

**收尾（可选独立）**：第二台机器真实浏览器验 F8（DevTools 看 WS 握手是否带 Cookie）。不阻塞核心合并（query-token 全程退路）。

---

## 5. 回归面 + 必钉死矩阵（HTTP + WS 双路径跑相同输入，防半不一致核心）

| # | 场景 | 凭证 | 期望 | 不变式 |
|---|------|------|------|--------|
| R1 | loopback 无凭证 | 无 | 放行 | CLI/TUI 命脉 |
| R2 | LAN 无凭证 + 无 auth | 无 | 放行 | 全新用户零配置（规则4）|
| R3 | LAN + 有 token、无凭证 | 无 | 401 | token 设防 |
| R4 | LAN + 有用户、无凭证 | 无 | **401** | **JWT 设防（核心修复）** |
| R5 | LAN + 正确 token | Bearer/X-Token/?token= | 放行 | 机器路径 |
| R6 | LAN + 错 token | 错 token | 401 | — |
| R7 | LAN + 有效 JWT cookie | Cookie | 放行 | **WS 也必须过（半不一致根除点）** |
| R8 | LAN + 过期/伪造 JWT | 坏 Cookie | 401 | verifyJwt 拒绝 |
| R9 | LAN + 设了 token 但用 JWT | 只 Cookie | 放行 | OR 关系（互不覆盖）|
| R10 | LAN + token 错 + cookie 坏 | 两者皆错 | 401 | 两路径都败才拒 |

**R7 必须在 WS 路径单独跑**（调 checkWebSocketAuth，用 F7 验证过的 fakeServer：requestIP + 带 cookie header 的 Request）——这是上次回退漏掉的、A2 的存在理由。建议 `tests/ws-auth.test.ts`。

**SEC-1 回退留下的坑（必避开）**：
- ⚠️ 不要只改 HTTP 不改 WS（R7 两路径都过是合并门槛）。
- ⚠️ loopback 规则必须在 JWT 之前短路（否则 JWT async 异常波及本机 client）。
- ⚠️ 规则4 是 `!API_TOKEN && !hasAnyUser()`，漏 `&& !hasAnyUser()` 就退回 F1 全放行 = 没改。
- ⚠️ `verifyJwt` 的 catch 必须 `catch (e: unknown)` 吞掉异常落到拒绝，不能抛穿 500。
- ⚠️ `tokenEquals` 保持 `timingSafeEqual`（F10），勿在重构中退化成 `===`。

---

## 6. YAGNI 边界
这是「让 JWT 在 LAN 上成为一等鉴权」，不是造 IAM。**明确不做**：多租户/组织、RBAC/角色、token 轮换/refresh token/滑动续期、运行期动态启动门、WS 首帧握手鉴权/一次性 ticket、WS 连上后周期性重校验 JWT、CSRF token（cookie 已 SameSite=Strict）、审计日志/登录失败锁定/限流。

**一句话边界**：只做 (a) `!API_TOKEN` → `!API_TOKEN && !hasAnyUser()` 让 JWT 被强制；(b) HTTP/WS 走同一 `authResolve` 使 WS 认 JWT cookie。其余一概不碰。

---

## 关键文件
- `src/daemon/routes.ts:279-298`（checkAuth/checkWebSocketAuth 抽 authResolve）、`:491-505`（HTTP 入口删 JWT fallback 特例统一进 authResolve）、`:256`（isLoopbackSocket 复用）、`:270-277`（tokenEquals 保留）
- `src/daemon/server.ts:40-47`（WS 升级改 await checkWebSocketAuth）
- `src/daemon/index.ts:116-133`（启动门改 `is_set || hasAnyUser()`，SEC-6）
- `src/core/auth.ts:87/116/145`（verifyJwt/extractJwtFromCookie/hasAnyUser，复用不改）
- `tests/routes-auth-token.test.ts` 扩 HTTP+WS 双路径矩阵 R1-R10 + 新增 `tests/ws-auth.test.ts`
- `src/web`（客户端无需改，query-token 退路保留；F8 确认后可简化）

**唯一需重点复核的技术前提是 F8**（浏览器同源 WS 握手是否自动带 HttpOnly cookie）。F7 已 Bun 实测「服务端能读握手 cookie」；F8 是「浏览器会发」另一半，推断成立未实测——成立则半不一致根除，不成立则 query-token 兜底，**两种情况设计都成立**。
