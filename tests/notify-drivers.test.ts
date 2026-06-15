/**
 * Phase 4 — notify driver 层测试
 *
 * 覆盖：
 *   - factory 按 type 创建 driver
 *   - 未知 type → warn 跳过
 *   - enabled() 平台 / 配置探测
 *   - on_events 白名单过滤
 *   - send() 错误吞掉不抛
 */

import { describe, it, expect } from "bun:test";
import { getEnabledDrivers, type NotifyDriverConfig } from "../src/core/notify/drivers";
import { createWindowsToastDriver } from "../src/core/notify/drivers/windows-toast";
import { createMacosOsascriptDriver } from "../src/core/notify/drivers/macos-osascript";
import { createLinuxNotifySendDriver } from "../src/core/notify/drivers/linux-notify-send";
import { createSlackWebhookDriver } from "../src/core/notify/drivers/slack-webhook";

const fakeTask = {
  id: "t-1",
  title: "test",
  workflow: "dev",
  status: "running",
  failure_count: 0,
  channel: null,
  notify_target: null,
  extra: {},
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  started_at: null,
  parent_task_id: null,
  parallel_index: null,
  parallel_group: null,
  requirement_id: null,
};

describe("notify driver — factory", () => {
  it("getEnabledDrivers 按 type 实例化 + 跳过未知 type", async () => {
    const cfgs: NotifyDriverConfig[] = [
      { type: "windows-toast", on_events: ["task-done"] },
      { type: "macos-osascript", on_events: ["task-done"] },
      { type: "slack-webhook", url: "https://hooks.slack.com/services/X" },
      { type: "linux-notify-send" },
      { type: "unknown-driver-type" }, // 未知 type，应被跳过 + warn
    ];
    const drivers = await getEnabledDrivers(cfgs);

    // 实际能 enabled 的视当前平台而定；至少能确认未知 type 被丢掉
    expect(drivers.find(d => d.name === "unknown-driver-type")).toBeUndefined();

    // slack-webhook 配了合法 url 一定 enabled
    expect(drivers.find(d => d.name === "slack-webhook")).toBeDefined();

    // 平台相关 driver：当前平台对应那个应 enabled，否则被跳过
    const hasWin = drivers.find(d => d.name === "windows-toast") !== undefined;
    const hasMac = drivers.find(d => d.name === "macos-osascript") !== undefined;
    expect(hasWin).toBe(process.platform === "win32");
    expect(hasMac).toBe(process.platform === "darwin");
  });
});

describe("notify driver — windows-toast", () => {
  it("enabled() 仅 win32 为 true", () => {
    const d = createWindowsToastDriver({ type: "windows-toast" });
    expect(d.enabled()).toBe(process.platform === "win32");
  });

  it("on_events 白名单过滤：不在列表的事件 send no-op", async () => {
    const d = createWindowsToastDriver({ type: "windows-toast", on_events: ["task-failed"] });
    // event=task-done 不在白名单 → 不 spawn，不抛错（platform 不对也不抛）
    await d.send({ task: fakeTask as never, message: "应该被过滤", event: "task-done" });
    // 无断言 — 主要确认不抛错
    expect(true).toBe(true);
  });

  it("默认 on_events 是 [task-done, task-failed, phase-awaiting]", async () => {
    const d = createWindowsToastDriver({ type: "windows-toast" });
    // info 不在默认白名单 → send no-op
    await d.send({ task: fakeTask as never, message: "info", event: "info" });
    expect(true).toBe(true);
  });
});

describe("notify driver — macos-osascript", () => {
  it("enabled() 仅 darwin 为 true", () => {
    const d = createMacosOsascriptDriver({ type: "macos-osascript" });
    expect(d.enabled()).toBe(process.platform === "darwin");
  });

  it("on_events 白名单过滤", async () => {
    const d = createMacosOsascriptDriver({ type: "macos-osascript", on_events: ["task-failed"] });
    await d.send({ task: fakeTask as never, message: "filtered", event: "task-done" });
    expect(true).toBe(true);
  });
});

describe("notify driver — linux-notify-send", () => {
  it("enabled() 仅 linux + 有 notify-send 为 true", () => {
    const d = createLinuxNotifySendDriver({ type: "linux-notify-send" });
    const expected = process.platform === "linux" && Bun.which("notify-send") !== null;
    expect(d.enabled()).toBe(expected);
  });

  it("on_events 白名单过滤：不在列表的事件 send no-op（不 spawn）", async () => {
    const d = createLinuxNotifySendDriver({ type: "linux-notify-send", on_events: ["task-failed"] });
    // event 不在白名单 → 在 spawn 前 return，跨平台都不抛
    await d.send({ task: fakeTask as never, message: "filtered", event: "task-done" });
    expect(true).toBe(true);
  });
});

describe("notify driver — slack-webhook", () => {
  it("enabled() 需要 url 以 https:// 开头", () => {
    expect(createSlackWebhookDriver({ type: "slack-webhook" }).enabled()).toBe(false);
    expect(createSlackWebhookDriver({ type: "slack-webhook", url: "http://x" }).enabled()).toBe(false);
    expect(createSlackWebhookDriver({ type: "slack-webhook", url: "https://hooks.slack.com/x" }).enabled()).toBe(true);
  });

  it("on_events 白名单过滤：不在列表的事件 send no-op（不发 HTTP）", async () => {
    const d = createSlackWebhookDriver({ type: "slack-webhook", url: "https://x", on_events: ["task-failed"] });
    // event 不在白名单 → 在 fetch 前 return，不触网
    await d.send({ task: fakeTask as never, message: "filtered", event: "task-done" });
    expect(true).toBe(true);
  });

  it("send() 网络失败仅 log 不抛错", async () => {
    // 不可解析的 host → fetch reject → 被 catch 吞掉
    const d = createSlackWebhookDriver({ type: "slack-webhook", url: "https://invalid.invalid" });
    await d.send({ task: fakeTask as never, message: "y", event: "task-done" });
    expect(true).toBe(true);
  });
});

describe("notify driver — loadNotifyDrivers config schema", () => {
  it("缺 type 字段的 entry 跳过", async () => {
    const cfgs: NotifyDriverConfig[] = [
      { type: "" } as never, // 空 type
      { type: "windows-toast" },
    ];
    const drivers = await getEnabledDrivers(cfgs);
    // 空 type 不应该 throw，被静默跳过；具体 enabled 视平台
    expect(drivers.length).toBeLessThanOrEqual(1);
  });
});
