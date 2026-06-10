import { describe, it, expect } from "bun:test";
import { parseUnifiedDiff } from "../src/web/src/lib/diff-parse";

describe("parseUnifiedDiff（GitHub 风 diff 渲染的行级解析）", () => {
  it("跳过文件头、解析 hunk 行号、add/del/ctx 各自维护行号", () => {
    const patch = [
      "diff --git a/foo.ts b/foo.ts",
      "index 1234567..89abcde 100644",
      "--- a/foo.ts",
      "+++ b/foo.ts",
      "@@ -10,3 +10,4 @@ function foo() {",
      " const a = 1;",
      "-const b = 2;",
      "+const b = 3;",
      "+const c = 4;",
      " return a;",
    ].join("\n");
    const lines = parseUnifiedDiff(patch);
    expect(lines[0]).toEqual({ kind: "hunk", text: "@@ -10,3 +10,4 @@ function foo() {" });
    expect(lines[1]).toEqual({ kind: "ctx", oldNo: 10, newNo: 10, text: "const a = 1;" });
    expect(lines[2]).toEqual({ kind: "del", oldNo: 11, text: "const b = 2;" });
    expect(lines[3]).toEqual({ kind: "add", newNo: 11, text: "const b = 3;" });
    expect(lines[4]).toEqual({ kind: "add", newNo: 12, text: "const c = 4;" });
    expect(lines[5]).toEqual({ kind: "ctx", oldNo: 12, newNo: 13, text: "return a;" });
  });

  it("多 hunk 各自重置行号；新文件（无逗号计数）也能解析", () => {
    const patch = [
      "diff --git a/new.ts b/new.ts",
      "new file mode 100644",
      "@@ -0,0 +1 @@",
      "+hello",
      "@@ -100,1 +200,2 @@",
      " ctx",
      "+added",
    ].join("\n");
    const lines = parseUnifiedDiff(patch);
    expect(lines[1]).toEqual({ kind: "add", newNo: 1, text: "hello" });
    expect(lines[3]).toEqual({ kind: "ctx", oldNo: 100, newNo: 200, text: "ctx" });
    expect(lines[4]).toEqual({ kind: "add", newNo: 201, text: "added" });
  });

  it("「No newline」反斜杠行按无行号上下文展示", () => {
    const patch = ["@@ -1 +1 @@", "-a", "+b", "\\ No newline at end of file"].join("\n");
    const lines = parseUnifiedDiff(patch);
    expect(lines[3].kind).toBe("ctx");
    expect(lines[3].oldNo).toBeUndefined();
    expect(lines[3].text).toContain("No newline");
  });
});
