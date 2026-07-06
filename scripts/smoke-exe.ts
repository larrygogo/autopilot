#!/usr/bin/env bun
// ──────────────────────────────────────────────
// 编译产物（bun build --compile 单文件 exe）冒烟测试 —— 跨平台（bun API，Win/Linux/macOS 通用）。
//
// 复刻「立即崩」场景的最终验收：隔离 HOME 跑 exe init（迁移注册表 + examples 常量）→
// daemon run（前台，嵌入 web-dist serve）→ fetch dashboard 断言 200 text/html → 清理。
// CI matrix（.github/workflows/build-exe.yml）在三平台 runner 上各跑一次，弥补「本地只能验 Windows」。
//
// 用法：bun run scripts/smoke-exe.ts <exe-path>
// ──────────────────────────────────────────────
import { mkdtempSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const exe = process.argv[2];
if (!exe || !existsSync(exe)) {
  console.error(`用法: bun run scripts/smoke-exe.ts <exe-path>（找不到 ${exe ?? "(缺参数)"}）`);
  process.exit(1);
}

const home = mkdtempSync(join(tmpdir(), "autopilot-smoke-"));
const port = 16321;
const env = { ...process.env, AUTOPILOT_HOME: home, AUTOPILOT_NO_BROWSER: "1" };

let daemonProc: ReturnType<typeof Bun.spawn> | null = null;
let failed = false;

try {
  // 1. init —— 跑迁移（静态注册表）+ 种 examples 常量工作流；复刻「迁移目录不存在→no such table」崩溃点
  console.log("=== smoke: exe init ===");
  const initProc = Bun.spawn([exe, "init"], { env, stdout: "inherit", stderr: "inherit" });
  if ((await initProc.exited) !== 0) throw new Error("exe init 退出码非 0");

  // 2. daemon run（前台，进程内启动 + 嵌入 web-dist serve）
  console.log("=== smoke: exe daemon run ===");
  daemonProc = Bun.spawn([exe, "daemon", "run", "--port", String(port), "--insecure-no-auth"], {
    env,
    stdout: "ignore",
    stderr: "ignore",
  });

  // 3. 轮询 dashboard —— 断言 web-dist 嵌入清单 serve 生效（200 text/html）
  let ok = false;
  for (let i = 0; i < 60; i++) {
    await Bun.sleep(500);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      const ct = res.headers.get("content-type") ?? "";
      if (res.status === 200 && ct.includes("text/html")) {
        ok = true;
        break;
      }
    } catch {
      /* daemon 未就绪，继续轮询 */
    }
  }
  if (!ok) throw new Error("dashboard 30s 内未返回 200 text/html（web-dist 嵌入 serve 失败）");
  console.log("=== smoke: GET / → 200 text/html ✓（web-dist 嵌入）===");

  console.log("✓ 冒烟通过：init（迁移+examples）+ daemon + 嵌入 dashboard 全 OK");
} catch (e: unknown) {
  failed = true;
  console.error(`✗ 冒烟失败：${e instanceof Error ? e.message : String(e)}`);
} finally {
  if (daemonProc) {
    try {
      daemonProc.kill();
    } catch {
      /* ignore */
    }
  }
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    /* Windows 下 daemon 句柄可能短暂占用，清理失败不影响冒烟结论 */
  }
}

process.exit(failed ? 1 : 0);
