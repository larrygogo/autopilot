import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { up as m001 } from "../../src/migrations/001-baseline";
import { up as m002 } from "../../src/migrations/002-schedules";
import { up as m004 } from "../../src/migrations/004-repos";
import { up as m005 } from "../../src/migrations/005-requirements";
import { up as m006 } from "../../src/migrations/006-submodules";
import { up as m007 } from "../../src/migrations/007-workflows";
import { up as m008 } from "../../src/migrations/008-projects";
import { up as m009 } from "../../src/migrations/009-nullable-codebase";
import { up as m010 } from "../../src/migrations/010-question-suggestions";
import { up as m011 } from "../../src/migrations/011-now-dismissed-cards";
import { up as m019 } from "../../src/migrations/019-task-requirement-id";
import { up as m021 } from "../../src/migrations/021-requirement-comments";
import { up as m024 } from "../../src/migrations/024-codebase-to-workspace";
import { up as m033 } from "../../src/migrations/033-workspace-remote-url";
import { _setDbForTest } from "../../src/core/db";
import { createProject } from "../../src/core/projects";
import { createWorkspace } from "../../src/core/workspaces";
import { createRequirement } from "../../src/core/requirements";
import { createEmptyStateSource } from "../../src/core/card-sources/empty-state";

function initSchema(): void {
  const db = new Database(":memory:");
  [m001, m002, m004, m005, m006, m007, m008, m009, m010, m011, m019, m021, m024, m033].forEach(fn => fn(db));
  _setDbForTest(db);
}

describe("CardSource: empty-state", () => {
  beforeEach(() => initSchema());

  it("零项目零库存 → 一张'建项目'引导卡", async () => {
    const cards = await createEmptyStateSource().scan();
    expect(cards).toHaveLength(1);
    expect(cards[0].id).toBe("empty-state:no-project");
    expect(cards[0].title).toContain("项目");
  });

  it("有项目无 workspace → 一张'加 workspace'引导卡", async () => {
    createProject({ id: "proj-001", name: "P" });
    const cards = await createEmptyStateSource().scan();
    expect(cards).toHaveLength(1);
    expect(cards[0].id).toBe("empty-state:no-workspace");
  });

  it("有项目有 workspace 无需求 → 一张'提需求'引导卡", async () => {
    createProject({ id: "proj-001", name: "P" });
    createWorkspace({ id: "cb-001", project_id: "proj-001", alias: "main", path: "/tmp" });
    const cards = await createEmptyStateSource().scan();
    expect(cards).toHaveLength(1);
    expect(cards[0].id).toBe("empty-state:no-requirement");
  });

  it("有需求 → 不出引导卡", async () => {
    createProject({ id: "proj-001", name: "P" });
    createWorkspace({ id: "cb-001", project_id: "proj-001", alias: "main", path: "/tmp" });
    createRequirement({ id: "REQ-001", project_id: "proj-001", title: "X", spec_md: "" });
    const cards = await createEmptyStateSource().scan();
    expect(cards).toEqual([]);
  });
});
