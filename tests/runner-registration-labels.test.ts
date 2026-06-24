import { test, expect } from "bun:test";
import { HttpRunnerBackend, type FetchLike } from "../src/daemon/runner/backend";

test("register body 携带 labels", async () => {
  let captured: Record<string, unknown> | null = null;
  const fakeFetch: FetchLike = async (_url, init) => {
    captured = JSON.parse(init?.body as string);
    return new Response(JSON.stringify({ data: { runner_id: "r1", secret: "s1" } }), { status: 200 });
  };
  await HttpRunnerBackend.register("http://cp.test", "tok", "pc", ["gpu", "linux"], fakeFetch);
  expect(captured).not.toBeNull();
  expect((captured as any).labels).toEqual(["gpu", "linux"]);
  expect((captured as any).name).toBe("pc");
  expect((captured as any).token).toBe("tok");
});

test("register 不传 labels 时 body.labels 为空数组", async () => {
  let captured: Record<string, unknown> | null = null;
  const fakeFetch: FetchLike = async (_url, init) => {
    captured = JSON.parse(init?.body as string);
    return new Response(JSON.stringify({ data: { runner_id: "r2", secret: "s2" } }), { status: 200 });
  };
  await HttpRunnerBackend.register("http://cp.test", "tok2", "srv", [], fakeFetch);
  expect((captured as any).labels).toEqual([]);
});
