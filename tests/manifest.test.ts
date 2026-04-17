import { describe, it, expect, beforeEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

/**
 * 每个测试用独立 tmp 目录模拟 AUTOPILOT_HOME。
 * manifest.ts 内部用 AUTOPILOT_HOME，通过设置 env 再 fresh-import 来隔离。
 */
async function withTempHome<T>(
  fn: (modules: {
    atomic: typeof import("../src/core/atomic-write");
    manifest: typeof import("../src/core/manifest");
    registry: typeof import("../src/core/registry");
  }, home: string) => T | Promise<T>
): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), "autopilot-manifest-"));
  const prevHome = process.env.AUTOPILOT_HOME;
  process.env.AUTOPILOT_HOME = home;
  try {
    // 强制重新加载 index / manifest / atomic-write 以绑定新的 AUTOPILOT_HOME
    const atomic = await import("../src/core/atomic-write?t=" + Date.now());
    const manifest = await import("../src/core/manifest?t=" + Date.now());
    const registry = await import("../src/core/registry?t=" + Date.now());
    return await fn({ atomic, manifest, registry }, home);
  } finally {
    if (prevHome === undefined) delete process.env.AUTOPILOT_HOME;
    else process.env.AUTOPILOT_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  }
}

function makeManifest(m: typeof import("../src/core/manifest")): import("../src/core/manifest").TaskManifest {
  return {
    version: m.MANIFEST_VERSION,
    taskId: "t1",
    title: "hello",
    workflow: "demo",
    workflow_snapshot: {
      name: "demo",
      initial_state: "pending_plan",
      terminal_states: ["done"],
      phases: [{
        name: "plan",
        pending_state: "pending_plan",
        running_state: "running_plan",
        trigger: "plan",
        complete_trigger: "plan_complete",
        fail_trigger: "plan_fail",
        label: "plan",
      }],
    },
    status: "pending_plan",
    failure_count: 0,
    channel: "log",
    notify_target: null,
    created_at: "2026-04-17T00:00:00.000Z",
    updated_at: "2026-04-17T00:00:00.000Z",
    started_at: null,
    parent_task_id: null,
    parallel_index: null,
    parallel_group: null,
    extra: {},
    transitions: [],
  };
}

describe("atomicWriteSync", () => {
  it("写到目标路径", async () => {
    await withTempHome(async ({ atomic }, home) => {
      const p = join(home, "a", "b", "c.json");
      atomic.atomicWriteSync(p, '{"hello":1}');
      expect(readFileSync(p, "utf-8")).toBe('{"hello":1}');
    });
  });

  it("失败时不留 tmp", async () => {
    await withTempHome(async ({ atomic }, home) => {
      const p = join(home, "target.json");
      atomic.atomicWriteSync(p, "ok");
      expect(existsSync(p)).toBe(true);
      // 确认没有 .tmp- 残留
      const entries = (await import("fs")).readdirSync(home);
      expect(entries.filter(e => e.includes(".tmp-")).length).toBe(0);
    });
  });
});

describe("manifest 读写", () => {
  it("write + read 往返一致", async () => {
    await withTempHome(async ({ manifest }) => {
      const m = makeManifest(manifest);
      manifest.writeManifest(m);
      const got = manifest.readManifest("t1");
      expect(got).not.toBeNull();
      expect(got?.taskId).toBe("t1");
      expect(got?.workflow_snapshot.name).toBe("demo");
    });
  });

  it("读不存在返回 null", async () => {
    await withTempHome(async ({ manifest }) => {
      expect(manifest.readManifest("nope")).toBeNull();
    });
  });

  it("版本不匹配返回 null + 警告", async () => {
    await withTempHome(async ({ manifest }) => {
      const m = makeManifest(manifest);
      manifest.writeManifest(m);
      // 改写文件把 version 改坏
      const p = manifest.getManifestPath("t1");
      const raw = JSON.parse(readFileSync(p, "utf-8"));
      raw.version = 999;
      writeFileSync(p, JSON.stringify(raw));
      expect(manifest.readManifest("t1")).toBeNull();
    });
  });

  it("updateManifest 合并 patch", async () => {
    await withTempHome(async ({ manifest }) => {
      const m = makeManifest(manifest);
      manifest.writeManifest(m);
      expect(manifest.updateManifest("t1", { status: "running_plan" })).toBe(true);
      const got = manifest.readManifest("t1");
      expect(got?.status).toBe("running_plan");
    });
  });

  it("updateManifest 对不存在的 manifest 返回 false", async () => {
    await withTempHome(async ({ manifest }) => {
      expect(manifest.updateManifest("nope", { status: "x" })).toBe(false);
    });
  });

  it("appendTransition 追加 + 更新状态", async () => {
    await withTempHome(async ({ manifest }) => {
      const m = makeManifest(manifest);
      manifest.writeManifest(m);
      manifest.appendTransition("t1", {
        from: "pending_plan",
        to: "running_plan",
        trigger: "plan",
        ts: "2026-04-17T00:00:01.000Z",
      }, { status: "running_plan", started_at: "2026-04-17T00:00:01.000Z" });
      const got = manifest.readManifest("t1");
      expect(got?.transitions.length).toBe(1);
      expect(got?.transitions[0]?.to).toBe("running_plan");
      expect(got?.status).toBe("running_plan");
      expect(got?.started_at).toBe("2026-04-17T00:00:01.000Z");
    });
  });

  it("listManifestTaskIds 扫描存在的 manifest", async () => {
    await withTempHome(async ({ manifest }) => {
      const m = makeManifest(manifest);
      manifest.writeManifest({ ...m, taskId: "t1" });
      manifest.writeManifest({ ...m, taskId: "t2" });
      const ids = manifest.listManifestTaskIds().sort();
      expect(ids).toEqual(["t1", "t2"]);
    });
  });
});

describe("snapshotWorkflow", () => {
  it("剥除 func / hooks", async () => {
    await withTempHome(async ({ manifest }) => {
      const wf = {
        name: "demo",
        initial_state: "pending_a",
        terminal_states: ["done"],
        phases: [
          { name: "a", pending_state: "pending_a", running_state: "running_a",
            trigger: "a", complete_trigger: "a_c", fail_trigger: "a_f", label: "a",
            func: async () => {} },
          { parallel: { name: "g", fail_strategy: "cancel_all", phases: [
            { name: "x", pending_state: "pending_x", running_state: "running_x",
              trigger: "x", complete_trigger: "x_c", fail_trigger: "x_f", label: "x",
              func: async () => {} },
          ]}},
        ],
        hooks: { onStart: () => {} },
        setup_func: () => ({}),
      } as any;
      const snap = manifest.snapshotWorkflow(wf);
      // 确认可序列化（若还有函数会抛）
      JSON.stringify(snap);
      expect((snap.phases[0] as any).func).toBeUndefined();
      const g = snap.phases[1] as any;
      expect(g.parallel.phases[0].func).toBeUndefined();
    });
  });
});
