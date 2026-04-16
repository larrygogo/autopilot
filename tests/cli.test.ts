import { describe, expect, test } from "bun:test";

describe("cli", () => {
  test("--version", async () => {
    const proc = Bun.spawn(["bun", "run", "src/cli.ts", "--version"], { stdout: "pipe" });
    const out = await new Response(proc.stdout).text();
    expect(out.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });
  test("--help contains commands", async () => {
    const proc = Bun.spawn(["bun", "run", "src/cli.ts", "--help"], { stdout: "pipe" });
    const out = await new Response(proc.stdout).text();
    expect(out).toContain("start");
    expect(out).toContain("status");
  });
});
