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
  const html = renderToStaticMarkup(<Term name="jump_trigger" variant="withSubtitle" />);
  expect(html).toContain("驳回去向");
  expect(html).toContain("jump_trigger");
  expect(html).toContain("font-mono");
  expect(html).not.toContain("uppercase");
});

test("inline variant: 含业务标签 + 虚线下划线", () => {
  const html = renderToStaticMarkup(<Term name="jump_trigger" variant="inline" />);
  expect(html).toContain("驳回去向");
  expect(html).toContain("border-dotted");
  expect(html).toContain("cursor-help");
});

test("默认 variant 是 inline", () => {
  const a = renderToStaticMarkup(<Term name="jump_trigger" />);
  const b = renderToStaticMarkup(<Term name="jump_trigger" variant="inline" />);
  expect(a).toBe(b);
});
