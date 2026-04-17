import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import * as sessions from "../src/core/sessions";

async function withTempHome<T>(fn: () => T | Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), "autopilot-sessions-"));
  const prev = process.env.AUTOPILOT_HOME;
  process.env.AUTOPILOT_HOME = home;
  try { return await fn(); }
  finally {
    if (prev === undefined) delete process.env.AUTOPILOT_HOME;
    else process.env.AUTOPILOT_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
}

describe("session manager", () => {
  it("createSession 写出 manifest", async () => {
    await withTempHome(async () => {
      const s = sessions.createSession({ agent: "coder", workflow: "dev", title: "调试" });
      expect(s.id).toBeTruthy();
      expect(s.agent).toBe("coder");
      expect(s.workflow).toBe("dev");
      expect(s.message_count).toBe(0);

      const read = sessions.readManifest(s.id);
      expect(read?.title).toBe("调试");
    });
  });

  it("appendMessage 增加 message_count + jsonl 持久化", async () => {
    await withTempHome(async () => {
      const s = sessions.createSession({ agent: "coder" });
      sessions.appendMessage(s.id, { role: "user", content: "你好", ts: "2026-04-17T00:00:00Z" });
      sessions.appendMessage(s.id, { role: "assistant", content: "Hi", ts: "2026-04-17T00:00:01Z" });

      const m = sessions.readManifest(s.id);
      expect(m?.message_count).toBe(2);

      const msgs = sessions.readMessages(s.id);
      expect(msgs.length).toBe(2);
      expect(msgs[0]?.role).toBe("user");
      expect(msgs[1]?.content).toBe("Hi");
    });
  });

  it("updateManifest 合并 provider_session_id", async () => {
    await withTempHome(async () => {
      const s = sessions.createSession({ agent: "coder" });
      expect(sessions.updateManifest(s.id, { provider_session_id: "abc-123" })).toBe(true);
      expect(sessions.readManifest(s.id)?.provider_session_id).toBe("abc-123");
    });
  });

  it("listSessions 按 updated_at 倒序", async () => {
    await withTempHome(async () => {
      const a = sessions.createSession({ agent: "a" });
      await new Promise((r) => setTimeout(r, 10));
      const b = sessions.createSession({ agent: "b" });
      const list = sessions.listSessions();
      expect(list.length).toBe(2);
      expect(list[0]?.id).toBe(b.id);
      expect(list[1]?.id).toBe(a.id);
    });
  });

  it("deleteSession 清目录", async () => {
    await withTempHome(async () => {
      const s = sessions.createSession({ agent: "coder" });
      expect(sessions.deleteSession(s.id)).toBe(true);
      expect(sessions.readManifest(s.id)).toBeNull();
    });
  });

  it("非法 id 拒绝", async () => {
    await withTempHome(async () => {
      expect(() => sessions.createSession({ agent: "a", id: "bad id!" })).toThrow(/非法/);
    });
  });

  it("readMessages limit 返回最新 N 条", async () => {
    await withTempHome(async () => {
      const s = sessions.createSession({ agent: "coder" });
      for (let i = 0; i < 5; i++) {
        sessions.appendMessage(s.id, { role: "user", content: `m${i}`, ts: new Date().toISOString() });
      }
      const last2 = sessions.readMessages(s.id, 2);
      expect(last2.length).toBe(2);
      expect(last2[0]?.content).toBe("m3");
      expect(last2[1]?.content).toBe("m4");
    });
  });
});
