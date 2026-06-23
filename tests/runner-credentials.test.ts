import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { saveCredentials, loadCredentials, credentialsPath, restrictFileAcl } from "../src/daemon/runner/credentials";

let home: string, prev: string | undefined;
beforeEach(() => {
  prev = process.env.AUTOPILOT_HOME;
  home = mkdtempSync(join(tmpdir(), "runner-cred-"));
  process.env.AUTOPILOT_HOME = home;
});
afterEach(() => {
  if (prev === undefined) delete process.env.AUTOPILOT_HOME; else process.env.AUTOPILOT_HOME = prev;
  try { rmSync(home, { recursive: true, force: true }); } catch {}
});

test("loadCredentials：未注册返回 null", () => {
  expect(loadCredentials()).toBeNull();
});

test("saveCredentials → loadCredentials 往返一致，落在 runner/credentials.json", () => {
  saveCredentials({ control_plane_url: "https://rg.example", runner_id: "rnr-1", secret: "s3cr3t" });
  expect(credentialsPath()).toBe(join(home, "runner", "credentials.json"));
  expect(existsSync(credentialsPath())).toBe(true);
  const c = loadCredentials();
  expect(c?.runner_id).toBe("rnr-1");
  expect(c?.secret).toBe("s3cr3t");
  expect(c?.control_plane_url).toBe("https://rg.example");
});

test("saveCredentials：POSIX 下文件权限收紧到 0o600", () => {
  if (process.platform === "win32") return; // Windows 走 icacls，权限位不可比
  saveCredentials({ control_plane_url: "https://rg.example", runner_id: "rnr-1", secret: "s" });
  expect(statSync(credentialsPath()).mode & 0o777).toBe(0o600);
});

test("restrictFileAcl：对不存在的文件不抛错（best-effort）", () => {
  expect(() => restrictFileAcl(join(home, "nope.json"))).not.toThrow();
});
