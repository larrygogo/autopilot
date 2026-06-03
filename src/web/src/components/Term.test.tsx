import { test, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Term } from "./Term";

test("plain variant: 只输出业务标签", () => {
  const html = renderToStaticMarkup(<Term name="jump_trigger" variant="plain" />);
  expect(html).toContain("驳回去向");
  expect(html).not.toContain("jump_trigger");
  expect(html).not.toContain("border-dotted");
});

test("withSubtitle variant: 业务标签 + mono 副标内核名", () => {
  const html = renderToStaticMarkup(<Term name="orphan_function" variant="withSubtitle" />);
  expect(html).toContain("废弃函数");
  expect(html).toContain("orphan function");
  expect(html).toContain("font-mono");
  expect(html).not.toContain("uppercase");
});

test("inline variant: trigger 含业务标签 + 虚线下划线", () => {
  const html = renderToStaticMarkup(<Term name="orphan_directory" variant="inline" />);
  expect(html).toContain("失联目录");
  expect(html).toContain("border-dotted");
  expect(html).toContain("cursor-help");
});

test("默认 variant 是 inline", () => {
  const a = renderToStaticMarkup(<Term name="jump_trigger" />);
  const b = renderToStaticMarkup(<Term name="jump_trigger" variant="inline" />);
  expect(a).toBe(b);
});

test("三个 key 都存在且文案正确", () => {
  const jt = renderToStaticMarkup(<Term name="jump_trigger" variant="plain" />);
  const od = renderToStaticMarkup(<Term name="orphan_directory" variant="plain" />);
  const of = renderToStaticMarkup(<Term name="orphan_function" variant="plain" />);
  expect(jt).toContain("驳回去向");
  expect(od).toContain("失联目录");
  expect(of).toContain("废弃函数");
});
