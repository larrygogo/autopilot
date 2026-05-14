import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { handleRequest, setListenHost } from "../src/daemon/routes";

let tmpHome: string;

beforeEach(() => {
  tmpHome = join(tmpdir(), `autopilot-fs-guard-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(tmpHome, "runtime"), { recursive: true });
  process.env.AUTOPILOT_HOME = tmpHome;
});

afterEach(() => {
  delete process.env.AUTOPILOT_HOME;
  if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
  setListenHost("127.0.0.1");
});

describe("/api/fs/list host 校验", () => {
  it("127.0.0.1 → 200", async () => {
    setListenHost("127.0.0.1");
    const res = await handleRequest(
      new Request(`http://127.0.0.1:6180/api/fs/list?path=${encodeURIComponent(tmpHome)}`),
    );
    expect(res.status).toBe(200);
  });

  it("0.0.0.0 → 403", async () => {
    setListenHost("0.0.0.0");
    const res = await handleRequest(
      new Request(`http://127.0.0.1:6180/api/fs/list?path=${encodeURIComponent(tmpHome)}`),
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain("fs-browser-disabled-on-public-bind");
  });

  it("192.168.x → 403", async () => {
    setListenHost("192.168.1.100");
    const res = await handleRequest(
      new Request(`http://127.0.0.1:6180/api/fs/list?path=${encodeURIComponent(tmpHome)}`),
    );
    expect(res.status).toBe(403);
  });

  it("localhost → 200", async () => {
    setListenHost("localhost");
    const res = await handleRequest(
      new Request(`http://127.0.0.1:6180/api/fs/list?path=${encodeURIComponent(tmpHome)}`),
    );
    expect(res.status).toBe(200);
  });
});
