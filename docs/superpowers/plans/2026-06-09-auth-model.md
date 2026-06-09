# A2：服务端鉴权模型 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 JWT 在 LAN 上成为一等服务端鉴权——抽统一 `authResolve` 让 HTTP+WS 同口径、收窄 `!API_TOKEN`→`!API_TOKEN && !hasAnyUser()` 让 JWT 被服务端强制、启动门 SEC-6 感知 hasAnyUser。

**Architecture:** `src/daemon/routes.ts` 抽 async `authResolve(req, server)`（loopback→token→JWT-if-hasAnyUser→零配置→deny 五规则）。HTTP 入口与 `checkWebSocketAuth`(改 async) 都调它，消灭「HTTP 认 JWT 但 WS 不认」半不一致。启动门改 `is_set || hasAnyUser()` 并移到 initDb 之后。

**Tech Stack:** Bun + TypeScript strict；测试 `bun:test`（驱动 `handleRequest`/`checkWebSocketAuth`，用 fakeLoopback/fakeLan server + signJwt 造 JWT cookie）。

**红线（spec）：绝不半修**——HTTP 和 WS 必须走同一 authResolve、loopback 必须在 JWT 之前短路、规则 4 必须是 `!API_TOKEN && !hasAnyUser()`（漏 `&& !hasAnyUser()` 等于没改）、verifyJwt 的 catch 必须吞异常落拒绝、tokenEquals 保持 timingSafeEqual。spec：`specs/2026-06-09-auth-model-design.md`。

---

## 关键事实（已核实）
- routes.ts `checkAuth`（279-294）仅 2 调用方：HTTP 入口（493）+ `checkWebSocketAuth`（298）。两者改走 authResolve 后 checkAuth 可删。**mcp-server.ts:118 的 checkAuth 是另一个函数（签名 `(req, token)`），不动。**
- HTTP 入口（491-505）当前：`!checkAuth` 时再 inline 查 JWT cookie。authResolve 把 JWT 收进函数内，入口简化为 `!(await authResolve(...))`。
- server.ts（40-47）WS 升级 `if (!checkWebSocketAuth(req, server))` 当前同步 → 改 `await`。
- 启动门 index.ts:119 当前 `!tokenState.is_set`，且在 `initDb()`（153）**之前** → 加 hasAnyUser 须先 initDb，故 gate 整块移到 migrations 之后。
- auth 原语：`signJwt(userId:number,email:string)`、`verifyJwt`（无效抛）、`makeSessionCookie(token)`（`autopilot_session=token; ...`）、`extractJwtFromCookie`、`hasAnyUser`、`createUser(email,password)`、`COOKIE_NAME="autopilot_session"`（已导出）。
- 测试 harness（routes-auth-token.test.ts）：`handleRequest(req, fakeLoopback|fakeLan)` 返 Response；`saveApiToken+reloadApiToken` 设 token、`deleteApiToken+reloadApiToken` 清。

---

## Task 1：authResolve + HTTP/WS 统一（核心，R-matrix 测试）

**Files:** Modify `src/daemon/routes.ts`、`src/daemon/server.ts`；Create `tests/auth-resolve.test.ts`

- [ ] **Step 1: 写新测试（R2/R4/R7-HTTP/R7-WS/R8）**

新建 `tests/auth-resolve.test.ts`：
```ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Database } from "bun:sqlite";
import { _setDbForTest, initDb } from "../src/core/db";
import { runPendingMigrations } from "../src/core/migrate";
import { saveApiToken, deleteApiToken } from "../src/core/api-token";
import { handleRequest, reloadApiToken, checkWebSocketAuth } from "../src/daemon/routes";
import { createUser, signJwt, makeSessionCookie } from "../src/core/auth";

const fakeLoopback = { requestIP: () => ({ address: "127.0.0.1", port: 0, family: "IPv4" }) } as unknown as import("bun").Server<undefined>;
const fakeLan = { requestIP: () => ({ address: "192.168.1.42", port: 0, family: "IPv4" }) } as unknown as import("bun").Server<undefined>;

let tmpHome: string;
let oldHome: string | undefined;

beforeEach(async () => {
  tmpHome = mkdtempSync(join(tmpdir(), "autopilot-authresolve-"));
  mkdirSync(join(tmpHome, "runtime"), { recursive: true });
  oldHome = process.env.AUTOPILOT_HOME;
  process.env.AUTOPILOT_HOME = tmpHome;
  _setDbForTest(new Database(":memory:"));
  initDb();
  await runPendingMigrations();
  deleteApiToken();   // 本套全部测「无 API token」场景
  reloadApiToken();
});
afterEach(() => {
  if (oldHome !== undefined) process.env.AUTOPILOT_HOME = oldHome; else delete process.env.AUTOPILOT_HOME;
  try { deleteApiToken(); } catch { /* ignore */ }
  reloadApiToken();
  _setDbForTest(null);
  rmSync(tmpHome, { recursive: true, force: true });
});

async function jwtCookieHeader(): Promise<string> {
  const user = await createUser("a@b.io", "pw123456");
  const jwt = await signJwt(user.id, user.email);
  return makeSessionCookie(jwt); // "autopilot_session=<jwt>; HttpOnly; ..."（extractJwtFromCookie 取首段）
}

describe("authResolve · 零配置 / JWT 强制（HTTP）", () => {
  it("R2 无 token 无用户 + LAN 无凭证 → 200（零配置放行）", async () => {
    const res = await handleRequest(new Request("http://localhost/api/status"), fakeLan);
    expect(res.status).toBe(200);
  });

  it("R4 无 token 有用户 + LAN 无凭证 → 401（JWT 被服务端强制）", async () => {
    await createUser("u@b.io", "pw123456"); // hasAnyUser=true
    const res = await handleRequest(new Request("http://localhost/api/status"), fakeLan);
    expect(res.status).toBe(401);
  });

  it("R1 无 token 有用户 + loopback 无凭证 → 200（本机豁免，CLI/TUI 命脉）", async () => {
    await createUser("u@b.io", "pw123456");
    const res = await handleRequest(new Request("http://localhost/api/status"), fakeLoopback);
    expect(res.status).toBe(200);
  });

  it("R7-HTTP LAN + 有效 JWT cookie → 200", async () => {
    const cookie = await jwtCookieHeader();
    const res = await handleRequest(new Request("http://localhost/api/status", { headers: { Cookie: cookie } }), fakeLan);
    expect(res.status).toBe(200);
  });

  it("R8 LAN + 伪造 JWT cookie → 401", async () => {
    await createUser("u@b.io", "pw123456");
    const res = await handleRequest(
      new Request("http://localhost/api/status", { headers: { Cookie: makeSessionCookie("not.a.jwt") } }),
      fakeLan,
    );
    expect(res.status).toBe(401);
  });
});

describe("authResolve · WS 同口径（checkWebSocketAuth 改 async）", () => {
  it("R7-WS LAN + 有效 JWT cookie → 放行（半不一致根除点）", async () => {
    const cookie = await jwtCookieHeader();
    const ok = await checkWebSocketAuth(
      new Request("http://localhost/ws", { headers: { Cookie: cookie } }),
      fakeLan,
    );
    expect(ok).toBe(true);
  });

  it("R4-WS LAN 有用户无凭证 → 拒绝", async () => {
    await createUser("u@b.io", "pw123456");
    const ok = await checkWebSocketAuth(new Request("http://localhost/ws"), fakeLan);
    expect(ok).toBe(false);
  });

  it("R1-WS loopback 无凭证 → 放行（CLI/TUI 命脉）", async () => {
    await createUser("u@b.io", "pw123456");
    const ok = await checkWebSocketAuth(new Request("http://localhost/ws"), fakeLoopback);
    expect(ok).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认红**

Run: `bun test tests/auth-resolve.test.ts`
Expected: **R4 FAIL**（现码 `!API_TOKEN→return true` → 200 而非 401）、**R7-WS FAIL**（现 checkWebSocketAuth=checkAuth 无 JWT、且 await 一个同步 boolean 返回的是该 boolean 仍 false）、R8 可能 FAIL。R1/R2/R7-HTTP 可能已绿（零配置/loopback/HTTP JWT fallback 现已部分支持）。至少 R4 + R7-WS 红。

- [ ] **Step 3: 实现 authResolve（routes.ts）**

在 routes.ts `checkAuth`（279-294）位置，**替换**为 authResolve（删旧 checkAuth）：
```ts
/**
 * 统一鉴权裁决（HTTP + WS 共用，消除两套逻辑漂移）。返回 true=放行。
 * 规则（短路）：1 loopback 豁免 → 2 API token → 3 JWT cookie(hasAnyUser 时) → 4 零配置(!token&&!user) → 5 拒绝。
 */
export async function authResolve(
  req: Request,
  server?: import("bun").Server<undefined>,
): Promise<boolean> {
  // 1. 本机 loopback 永远豁免（CLI/TUI/本机浏览器命脉，按 socket peer IP，必须在 JWT 之前短路）
  if (isLoopbackSocket(server, req)) return true;
  // 2. API token 路径（机器/CI）
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
  // 3. JWT cookie 路径（人/浏览器）—— HTTP 与 WS 同此分支
  if (hasAnyUser()) {
    const jwt = extractJwtFromCookie(req);
    if (jwt) {
      try { await verifyJwt(jwt); return true; }
      catch (e: unknown) { /* 无效/过期 → 落拒绝 */ }
    }
  }
  // 4. 既没 token 也没用户 → auth 未启用，放行（零配置全新用户）
  if (!API_TOKEN && !hasAnyUser()) return true;
  // 5. 启用了某种 auth 但凭证缺失/无效
  return false;
}

/** WebSocket upgrade 路径 —— 与 HTTP 同口径（server 必填）。 */
export function checkWebSocketAuth(req: Request, server: import("bun").Server<undefined>): Promise<boolean> {
  return authResolve(req, server);
}
```
> 确认 routes.ts 顶部已 import `hasAnyUser, extractJwtFromCookie, verifyJwt`（现 HTTP 入口已用 extractJwtFromCookie/verifyJwt；hasAnyUser 若未 import 则补 `import { hasAnyUser } from "../core/auth";`，与现有 auth import 合并）。

- [ ] **Step 4: 改 HTTP 入口（routes.ts 491-505）**

把：
```ts
  if (path.startsWith("/api/") && !checkAuth(req, server)) {
    const jwtToken = extractJwtFromCookie(req);
    if (jwtToken) {
      try {
        await verifyJwt(jwtToken);
      } catch {
        return error("Unauthorized", 401);
      }
    } else {
      return error("Unauthorized", 401);
    }
  }
```
改为：
```ts
  // 鉴权（仅 /api/* 生效）：loopback / API token / JWT cookie 任一通过即放行，统一走 authResolve。
  if (path.startsWith("/api/") && !(await authResolve(req, server))) {
    return error("Unauthorized", 401);
  }
```

- [ ] **Step 5: 改 server.ts WS 升级为 await（40-47）**

把 `if (!checkWebSocketAuth(req, server))` 改为 `if (!(await checkWebSocketAuth(req, server)))`（该 fetch 回调已是 async）。

- [ ] **Step 6: 跑测试 + typecheck**

Run: `bun test tests/auth-resolve.test.ts tests/routes-auth-token.test.ts && bun run typecheck`
Expected: auth-resolve 全绿（R1/R2/R4/R7/R8 HTTP+WS）；**routes-auth-token 既有 8 个全绿**（token 路径不变——R1/R3/R5/R6 守住）；typecheck 0 错（checkAuth 删除后无悬挂引用——若报 checkAuth 未定义说明有漏改调用方，回查）。

- [ ] **Step 7: 全量测试 + 提交**

Run: `bun test`
Expected: 全绿。
```bash
git add src/daemon/routes.ts src/daemon/server.ts tests/auth-resolve.test.ts
git commit -m "feat(daemon): A2 统一 authResolve 让 HTTP/WS 同口径鉴权，JWT 服务端强制"
```

---

## Task 2：启动门 SEC-6（感知 hasAnyUser + 移到 initDb 后）

**Files:** Modify `src/daemon/routes.ts`（加纯谓词）、`src/daemon/index.ts`（gate 移位 + 改条件）、`tests/auth-resolve.test.ts`（加谓词测试）

- [ ] **Step 1: 加纯谓词测试（auth-resolve.test.ts 追加）**

```ts
import { startupAuthBlocked } from "../src/daemon/routes";

describe("startupAuthBlocked（SEC-6 启动门谓词）", () => {
  it("暴露 host + 无 token 无用户 + 未 insecure → 阻塞", () => {
    expect(startupAuthBlocked("0.0.0.0", false, false, false)).toBe(true);
  });
  it("暴露 host + 有用户（无 token）→ 不阻塞（JWT 已是服务端一等鉴权）", () => {
    expect(startupAuthBlocked("0.0.0.0", false, true, false)).toBe(false);
  });
  it("暴露 host + 有 token → 不阻塞", () => {
    expect(startupAuthBlocked("0.0.0.0", true, false, false)).toBe(false);
  });
  it("loopback host → 永不阻塞", () => {
    expect(startupAuthBlocked("127.0.0.1", false, false, false)).toBe(false);
  });
  it("insecure 逃生口 → 不阻塞", () => {
    expect(startupAuthBlocked("0.0.0.0", false, false, true)).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认红**

Run: `bun test tests/auth-resolve.test.ts`
Expected: FAIL —— `startupAuthBlocked` 未导出。

- [ ] **Step 3: 加纯谓词（routes.ts）**

在 routes.ts 加（`isExposedHost` 已在该文件）：
```ts
/**
 * 启动门谓词（SEC-6）：暴露 host 上必须已设防（有 API token 或有登录用户）才放行启动。
 * A2 后 JWT 是服务端一等鉴权，故「有用户」等同于设了防。纯函数，便于测试。
 */
export function startupAuthBlocked(host: string, tokenIsSet: boolean, hasUser: boolean, insecure: boolean): boolean {
  return isExposedHost(host) && !(tokenIsSet || hasUser) && !insecure;
}
```

- [ ] **Step 4: index.ts gate 移到 initDb 后 + 改用谓词**

(a) 删除 index.ts 当前的 gate 块（约 116-133，从 `reloadApiToken();` 后的注释到 `process.exit(2); }`）。保留 `reloadApiToken()`（CORS 等后续仍需）。
(b) 在 `initDb(); await runPendingMigrations();`（153-154）**之后**插入新 gate（此时 users 表可查）：
```ts
  // 安全门（SEC-6）：暴露 host 必须已设防（API token 或登录用户），否则内网裸奔。移到 initDb 后以便查 hasAnyUser。
  reloadApiToken();
  const tokenState = getApiTokenState();
  if (startupAuthBlocked(host, tokenState.is_set, hasAnyUser(), !!opts.insecureNoAuth)) {
    console.error(`
错误：daemon 配置为监听 ${host}（对外暴露），但既未设置 API token、也无登录用户。
这意味着同网段的任何人都能访问你的任务、凭证、Agent 调用，等于内网裸奔。
请选择：1. Web 设置页生成 token / 创建登录用户（推荐） 2. 写 ~/.autopilot/runtime/api-token 3. 环境变量 AUTOPILOT_API_TOKEN 4. 切回 127.0.0.1 5. autopilot daemon run --insecure-no-auth
`);
    process.exit(2);
  }
```
(c) index.ts 顶部 import 补 `hasAnyUser`、`startupAuthBlocked`：`import { ..., isExposedHost, startupAuthBlocked } from "./routes";` + `import { hasAnyUser } from "../core/auth";`（与现有 import 合并）。
(d) 确认移位后 gate 仍在 `Bun.serve`/server 启动之前（grep server 启动行号，应 > 154）。若 reloadApiToken 在原位（117）已调，移位后重复调无害（幂等）；可删原位那次只留移位后的。

- [ ] **Step 5: typecheck + 全量测试 + 提交**

Run: `bun run typecheck && bun test`
Expected: 全绿（谓词 5 用例 + 全量）。
```bash
git add src/daemon/routes.ts src/daemon/index.ts tests/auth-resolve.test.ts
git commit -m "feat(daemon): A2 启动门 SEC-6 感知 hasAnyUser（有用户=已设防）"
```

---

## 收尾
用 superpowers:finishing-a-development-branch。
**F8 真实浏览器验证（不阻塞合并，query-token 全程退路）**：第二台机器浏览器登录 LAN daemon，DevTools Network 看 WS 握手请求头是否带 `Cookie`——带则 WS-via-JWT 链路闭合；不带则 LAN 浏览器回落贴 token（与今天一致）。
**不做（spec §6 YAGNI）**：多租户/RBAC、token 轮换/refresh、运行期动态门、WS 首帧鉴权、周期重校验、CSRF（cookie 已 SameSite=Strict）、限流。

## Self-Review
**1. Spec coverage**：authResolve 五规则（Task1 Step3）+ HTTP/WS 同口径（Step4/5）+ JWT 服务端强制 R4（Step1）+ 半不一致根除 R7-WS（Step1）+ loopback 命脉 R1（Step1）+ 零配置 R2（Step1）+ 启动门 SEC-6（Task2）。spec §1-3+§5 R-matrix 覆盖 R1/R2/R4/R7/R8（R3/R5/R6 token 路径由既有 routes-auth-token.test.ts 8 用例守，未删）。R9（token 设了用 JWT）/R10（双错）属边角，未单列——R7（JWT 通过）+ R4（无凭证拒）已覆盖核心；可在执行时按需补。
**2. Placeholder scan**：无 TBD；authResolve/入口/gate/谓词均给完整代码；测试给完整代码（含 jwtCookieHeader 辅助）。Step4(d)「确认移位后 gate 在 serve 之前」是执行时核查指令（gate 移位的正确性约束），非占位符。
**3. Type consistency**：`authResolve(req, server?): Promise<boolean>`、`checkWebSocketAuth(req, server): Promise<boolean>`、`startupAuthBlocked(host,tokenIsSet,hasUser,insecure): boolean` 跨 Task 一致；规则 4 严格 `!API_TOKEN && !hasAnyUser()`（spec 红线）；`createUser/signJwt/makeSessionCookie` 签名与 auth.ts 实际一致；JWT cookie 经 makeSessionCookie 注入、extractJwtFromCookie 取 COOKIE_NAME 首段。
