import { test, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { StepBar } from "./StepBar";

test("渲染 6 个步骤标签", () => {
  const html = renderToStaticMarkup(
    <StepBar status="running" selected="execute" onSelect={() => {}} />,
  );
  for (const label of ["澄清", "审批", "排队", "执行", "验收", "完成"]) {
    expect(html).toContain(label);
  }
});

test("每个步骤都是可点击 button（含未到达，共 6 个）", () => {
  const html = renderToStaticMarkup(
    <StepBar status="drafting" selected="clarify" onSelect={() => {}} />,
  );
  expect((html.match(/<button/g) || []).length).toBe(6);
});

test("当前步骤之前的步骤是 done 态（success 配色）", () => {
  const html = renderToStaticMarkup(
    <StepBar status="running" selected="execute" onSelect={() => {}} />,
  );
  expect(html).toContain("bg-success/15");
});

test("选中步骤有下划线高亮", () => {
  const html = renderToStaticMarkup(
    <StepBar status="running" selected="clarify" onSelect={() => {}} />,
  );
  expect(html).toContain("underline");
});

test("failed 时完成步标红", () => {
  const html = renderToStaticMarkup(
    <StepBar status="failed" selected="done" onSelect={() => {}} />,
  );
  expect(html).toContain("bg-destructive");
});
