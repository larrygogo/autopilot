/**
 * 项目多代码库（1:N）+ 需求代码库集合反写（requirements.setWorkspaces）。
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { up as m001 } from "../src/migrations/001-baseline";
import { up as m002 } from "../src/migrations/002-schedules";
import { up as m004 } from "../src/migrations/004-repos";
import { up as m005 } from "../src/migrations/005-requirements";
import { up as m006 } from "../src/migrations/006-submodules";
import { up as m007 } from "../src/migrations/007-workflows";
import { up as m008 } from "../src/migrations/008-projects";
import { up as m009 } from "../src/migrations/009-nullable-codebase";
import { up as m010 } from "../src/migrations/010-question-suggestions";
import { up as m012 } from "../src/migrations/012-spec-revisions";
import { up as m013 } from "../src/migrations/013-active-question-id";
import { up as m014 } from "../src/migrations/014-resolve-orphan-open-questions";
import { up as m015 } from "../src/migrations/015-clarifier-error";
import { up as m019 } from "../src/migrations/019-task-requirement-id";
import { up as m021 } from "../src/migrations/021-requirement-comments";
import { up as m024 } from "../src/migrations/024-codebase-to-workspace";
import { up as m025 } from "../src/migrations/025-one-workspace-per-project";
import { up as m028 } from "../src/migrations/028-requirement-status-reason";
import { up as m029 } from "../src/migrations/029-requirement-status-before-terminal";
import { up as m030 } from "../src/migrations/030-requirement-status-logs";
import { up as m031 } from "../src/migrations/031-requirement-workflow";
import { up as m033 } from "../src/migrations/033-workspace-remote-url";
import { up as m037 } from "../src/migrations/037-multi-workspace-per-project";
import { up as m043 } from "../src/migrations/043-workspace-id-demote-backfill";
import { _setDbForTest } from "../src/core/db";
import { createProject } from "../src/core/projects";
import { createWorkspace } from "../src/core/workspaces";
import {
  createRequirement,
  getRequirementById,
  updateRequirement,
  listRequirements,
  listRequirementWorkspaces,
  listRequirementWorkspaceIds,
  setRequirementWorkspaces,
  setRequirementStatus,
} from "../src/core/requirements";
import { invokeRpcMethod } from "../src/daemon/rpc";
import { registerCoreRpcMethods } from "../src/daemon/rpc-methods";

function setup(): Database {
  const db = new Database(":memory:");
  [m001, m002, m004, m005, m006, m007, m008, m009, m010, m012, m013, m014, m015, m019, m021, m024, m025, m028, m029, m030, m031, m033, m037].forEach((fn) => fn(db));
  _setDbForTest(db);
  createProject({ id: "p1", name: "项目一" });
  return db;
}

function mkWs(id: string, alias: string, projectId = "p1") {
  return createWorkspace({ id, alias, path: `C:/fake/${alias}`, project_id: projectId, remote_url: `https://github.com/x/${alias}.git` });
}

describe("迁移 037：1:N + 回填", () => {
  it("删除 1:1 唯一索引后同项目可建多个顶层代码库", () => {
    const db = setup();
    mkWs("ws-001", "a");
    mkWs("ws-002", "b"); // 1:1 索引还在的话这里会抛 UNIQUE
    const rows = db.query<{ c: number }, []>(
      "SELECT COUNT(*) AS c FROM workspaces WHERE project_id = 'p1' AND parent_workspace_id IS NULL",
    ).get();
    expect(rows?.c).toBe(2);
  });

  it("回填：已有 workspace_id 的需求补进 requirement_workspaces", () => {
    const db = setup();
    mkWs("ws-001", "a");
    createRequirement({ id: "req-001", project_id: "p1", workspace_id: "ws-001", title: "t", spec_md: "" });
    // 模拟历史脏数据：换主库但关联表没同步（直接 SQL 绕过 update 同步逻辑）
    mkWs("ws-002", "b");
    db.run("UPDATE requirements SET workspace_id = 'ws-002' WHERE id = 'req-001'");
    db.run("DELETE FROM requirement_workspaces WHERE requirement_id = 'req-001'");
    m037(db); // 重跑迁移（幂等）
    const ids = listRequirementWorkspaceIds(["req-001"]).get("req-001") ?? [];
    expect(ids).toContain("ws-002");
  });
});

describe("core：关联集合维护", () => {
  it("updateRequirement 改主库时 INSERT OR IGNORE 同步关联表（不清旧行）", () => {
    setup();
    mkWs("ws-001", "a");
    mkWs("ws-002", "b");
    createRequirement({ id: "req-001", project_id: "p1", workspace_id: "ws-001", title: "t", spec_md: "" });
    updateRequirement("req-001", { workspace_id: "ws-002" });
    const ids = (listRequirementWorkspaceIds(["req-001"]).get("req-001") ?? []).sort();
    expect(ids).toEqual(["ws-001", "ws-002"]);
  });

  it("setRequirementWorkspaces 整体替换：workspace_id 缓存 = 集合第一个", () => {
    setup();
    mkWs("ws-001", "a");
    mkWs("ws-002", "b");
    mkWs("ws-003", "c");
    createRequirement({ id: "req-001", project_id: "p1", workspace_id: "ws-001", title: "t", spec_md: "" });
    setRequirementWorkspaces("req-001", ["ws-003", "ws-002"]);
    expect(getRequirementById("req-001")?.workspace_id).toBe("ws-003");
    const ws = listRequirementWorkspaces("req-001").map((w) => w.id).sort();
    expect(ws).toEqual(["ws-002", "ws-003"]);
  });

  it("listRequirements({workspace_id}) 走集合 EXISTS：多库需求按任一关联库命中", () => {
    setup();
    mkWs("ws-001", "a");
    mkWs("ws-002", "b");
    createRequirement({ id: "req-001", project_id: "p1", workspace_id: "ws-001", title: "t", spec_md: "" });
    setRequirementWorkspaces("req-001", ["ws-001", "ws-002"]);
    // 缓存列 = ws-001，但按 ws-002（非缓存列）过滤也应命中
    expect(getRequirementById("req-001")?.workspace_id).toBe("ws-001");
    expect(listRequirements({ workspace_id: "ws-002" }).map((r) => r.id)).toEqual(["req-001"]);
    expect(listRequirements({ workspace_id: "ws-001" }).map((r) => r.id)).toEqual(["req-001"]);
  });
});

describe("迁移 043：主库语义降级回填（幂等）", () => {
  it("集合空但列非空 → 补集合行；列 NULL 但集合非空 → 回填 created_at 最早；重跑幂等", () => {
    const db = setup();
    mkWs("ws-001", "a");
    mkWs("ws-002", "b");
    // 场景 1：集合空但列非空（直接 SQL 制造历史脏数据）
    createRequirement({ id: "req-001", project_id: "p1", workspace_id: "ws-001", title: "t1", spec_md: "" });
    db.run("DELETE FROM requirement_workspaces WHERE requirement_id = 'req-001'");
    // 场景 2：列 NULL 但集合非空（含两个库，created_at 区分先后）
    createRequirement({ id: "req-002", project_id: "p1", title: "t2", spec_md: "" });
    db.run("UPDATE requirements SET workspace_id = NULL WHERE id = 'req-002'");
    db.run("INSERT OR IGNORE INTO requirement_workspaces (requirement_id, workspace_id) VALUES ('req-002', 'ws-001'), ('req-002', 'ws-002')");
    db.run("UPDATE workspaces SET created_at = 1000 WHERE id = 'ws-002'");
    db.run("UPDATE workspaces SET created_at = 2000 WHERE id = 'ws-001'");

    m043(db);
    // 场景 1：集合补回
    expect(listRequirementWorkspaceIds(["req-001"]).get("req-001")).toEqual(["ws-001"]);
    // 场景 2：列回填 = 集合内 workspace.created_at 最早（ws-002）
    expect(getRequirementById("req-002")?.workspace_id).toBe("ws-002");

    // 幂等：重跑无副作用
    m043(db);
    expect(listRequirementWorkspaceIds(["req-001"]).get("req-001")).toEqual(["ws-001"]);
    expect(getRequirementById("req-002")?.workspace_id).toBe("ws-002");
  });
});

describe("RPC requirements.setWorkspaces", () => {
  beforeEach(() => {
    setup();
    registerCoreRpcMethods();
    mkWs("ws-001", "a");
    mkWs("ws-002", "b");
    createRequirement({ id: "req-001", project_id: "p1", workspace_id: "ws-001", title: "t", spec_md: "" });
  });

  it("反写集合：workspace_id 缓存 = 第一个；响应附 workspace_ids", async () => {
    const r = await invokeRpcMethod("requirements.setWorkspaces", {
      id: "req-001",
      workspace_ids: ["ws-002", "ws-001"],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const d = r.payload as { requirement: { workspace_id: string; workspace_ids: string[] }; workspace_ids: string[] };
      expect(d.requirement.workspace_id).toBe("ws-002");
      expect(d.workspace_ids.sort()).toEqual(["ws-001", "ws-002"]);
      expect(d.requirement.workspace_ids.sort()).toEqual(["ws-001", "ws-002"]);
    }
  });

  it("primary_workspace_id 入参接受但忽略（主库概念已废除，兼容老 web-dist）", async () => {
    const r = await invokeRpcMethod("requirements.setWorkspaces", {
      id: "req-001", workspace_ids: ["ws-001"], primary_workspace_id: "ws-002",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const d = r.payload as { requirement: { workspace_id: string } };
      expect(d.requirement.workspace_id).toBe("ws-001"); // = 集合第一个，与 primary 入参无关
    }
  });

  it("校验：空集合 / 跨项目 / 不存在", async () => {
    const empty = await invokeRpcMethod("requirements.setWorkspaces", { id: "req-001", workspace_ids: [] });
    expect(empty.ok).toBe(false);

    createProject({ id: "p2", name: "项目二" });
    mkWs("ws-100", "other", "p2");
    const crossProject = await invokeRpcMethod("requirements.setWorkspaces", {
      id: "req-001", workspace_ids: ["ws-100"],
    });
    expect(crossProject.ok).toBe(false);

    const missing = await invokeRpcMethod("requirements.setWorkspaces", {
      id: "req-001", workspace_ids: ["ws-999"],
    });
    expect(missing.ok).toBe(false);
  });

  it("开始澄清即冻结：clarifying/awaiting_approval/queued 拒改，failed 放行", async () => {
    // 澄清基于已选代码库的浅 clone 做，中途换库会让澄清失效 —— drafting 之后全程冻结
    setRequirementStatus("req-001", "clarifying");
    const inClarify = await invokeRpcMethod("requirements.setWorkspaces", {
      id: "req-001", workspace_ids: ["ws-002"],
    });
    expect(inClarify.ok).toBe(false);

    setRequirementStatus("req-001", "ready");
    setRequirementStatus("req-001", "awaiting_approval");
    const inApproval = await invokeRpcMethod("requirements.setWorkspaces", {
      id: "req-001", workspace_ids: ["ws-002"],
    });
    expect(inApproval.ok).toBe(false);

    setRequirementStatus("req-001", "queued");
    const frozen = await invokeRpcMethod("requirements.setWorkspaces", {
      id: "req-001", workspace_ids: ["ws-002"],
    });
    expect(frozen.ok).toBe(false);

    setRequirementStatus("req-001", "running");
    setRequirementStatus("req-001", "failed");
    const retry = await invokeRpcMethod("requirements.setWorkspaces", {
      id: "req-001", workspace_ids: ["ws-002"],
    });
    expect(retry.ok).toBe(true);
  });

  it("requirements.get 响应附 workspace_ids", async () => {
    const r = await invokeRpcMethod("requirements.get", { id: "req-001" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const d = r.payload as { requirement: { workspace_ids: string[] } };
      expect(d.requirement.workspace_ids).toEqual(["ws-001"]);
    }
  });

  it("transition → clarifying 守卫按集合判定：集合空被拒，确认集合后放行", async () => {
    // p1 下已有 2 个库 → create 不自动派生（仅唯一时自动选），集合为空
    createRequirement({ id: "req-002", project_id: "p1", title: "t2", spec_md: "" });
    expect(listRequirementWorkspaces("req-002").length).toBe(0);

    const denied = await invokeRpcMethod("requirements.transition", { id: "req-002", to: "clarifying" });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.message).toContain("代码库集合为空");

    const set = await invokeRpcMethod("requirements.setWorkspaces", {
      id: "req-002", workspace_ids: ["ws-002"],
    });
    expect(set.ok).toBe(true);
    const allowed = await invokeRpcMethod("requirements.transition", { id: "req-002", to: "clarifying" });
    expect(allowed.ok).toBe(true);
    expect(getRequirementById("req-002")?.status).toBe("clarifying");
  });
});
