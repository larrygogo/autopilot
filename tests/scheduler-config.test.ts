import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadSchedulerConfig, saveSchedulerConfig } from "../src/core/config";

let tmpFile: string;
let tmpDir: string;

beforeEach(() => {
  tmpDir = join(tmpdir(), `ap-sched-cfg-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });
  tmpFile = join(tmpDir, "config.json");
  writeFileSync(tmpFile, "{}", "utf-8");
  process.env.DEV_WORKFLOW_CONFIG = tmpFile;
});

afterEach(() => {
  delete process.env.DEV_WORKFLOW_CONFIG;
  if (tmpDir && existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

describe("loadSchedulerConfig()", () => {
  it("scheduler 段缺失时返回空对象", () => {
    expect(loadSchedulerConfig()).toEqual({});
  });

  it("max_concurrent_tasks = 3 时正确解析", () => {
    writeFileSync(tmpFile, JSON.stringify({ scheduler: { max_concurrent_tasks: 3 } }, null, 2), "utf-8");
    expect(loadSchedulerConfig().max_concurrent_tasks).toBe(3);
  });

  it("max_concurrent_tasks = 1 合法（最小值）", () => {
    writeFileSync(tmpFile, JSON.stringify({ scheduler: { max_concurrent_tasks: 1 } }, null, 2), "utf-8");
    expect(loadSchedulerConfig().max_concurrent_tasks).toBe(1);
  });

  it("max_concurrent_tasks 为浮点数时忽略", () => {
    writeFileSync(tmpFile, JSON.stringify({ scheduler: { max_concurrent_tasks: 2.5 } }, null, 2), "utf-8");
    expect(loadSchedulerConfig().max_concurrent_tasks).toBeUndefined();
  });

  it("max_concurrent_tasks 为 0 时忽略", () => {
    writeFileSync(tmpFile, JSON.stringify({ scheduler: { max_concurrent_tasks: 0 } }, null, 2), "utf-8");
    expect(loadSchedulerConfig().max_concurrent_tasks).toBeUndefined();
  });

  it("max_concurrent_tasks 为负数时忽略", () => {
    writeFileSync(tmpFile, JSON.stringify({ scheduler: { max_concurrent_tasks: -1 } }, null, 2), "utf-8");
    expect(loadSchedulerConfig().max_concurrent_tasks).toBeUndefined();
  });

  it("max_concurrent_tasks 为字符串时忽略", () => {
    writeFileSync(tmpFile, JSON.stringify({ scheduler: { max_concurrent_tasks: "three" } }, null, 2), "utf-8");
    expect(loadSchedulerConfig().max_concurrent_tasks).toBeUndefined();
  });

  it("scheduler 段存在但无 max_concurrent_tasks 时返回空对象", () => {
    writeFileSync(tmpFile, JSON.stringify({ scheduler: { other_field: true } }, null, 2), "utf-8");
    expect(loadSchedulerConfig()).toEqual({});
  });

  it("与其他 config 段共存不受影响", () => {
    writeFileSync(
      tmpFile,
      JSON.stringify({ daemon: { port: 6180 }, scheduler: { max_concurrent_tasks: 5 } }, null, 2),
      "utf-8",
    );
    expect(loadSchedulerConfig().max_concurrent_tasks).toBe(5);
  });
});

describe("saveSchedulerConfig()", () => {
  it("写入 max_concurrent_tasks 后可读回", () => {
    saveSchedulerConfig({ max_concurrent_tasks: 4 });
    expect(loadSchedulerConfig().max_concurrent_tasks).toBe(4);
  });

  it("保留 JSON 其他段", () => {
    writeFileSync(tmpFile, JSON.stringify({ daemon: { port: 6180 } }, null, 2), "utf-8");
    saveSchedulerConfig({ max_concurrent_tasks: 3 });
    const cfg = JSON.parse(readFileSync(tmpFile, "utf-8"));
    expect(cfg.daemon?.port).toBe(6180);
    expect(cfg.scheduler?.max_concurrent_tasks).toBe(3);
  });

  it("传入空对象时删除 scheduler 段", () => {
    writeFileSync(tmpFile, JSON.stringify({ scheduler: { max_concurrent_tasks: 2 } }, null, 2), "utf-8");
    saveSchedulerConfig({});
    const cfg = JSON.parse(readFileSync(tmpFile, "utf-8"));
    expect(cfg.scheduler).toBeUndefined();
  });

  it("max_concurrent_tasks 为 undefined 时删除 scheduler 段", () => {
    saveSchedulerConfig({ max_concurrent_tasks: 2 });
    saveSchedulerConfig({ max_concurrent_tasks: undefined });
    const cfg = JSON.parse(readFileSync(tmpFile, "utf-8"));
    expect(cfg.scheduler).toBeUndefined();
  });
});
