import { test, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { StepBar } from "./StepBar";

test("渲染 5 个步骤标签", () => {
  const html = renderToStaticMarkup(
    <StepBar status="running" selected="execute" onSelect={() => {}} />,
  );
  for (const label of ["澄清", "审批", "执行", "验收", "完成"]) {
    expect(html).toContain(label);
  }
});

test("每个步骤都是可点击 button（含未到达，共 5 个）", () => {
  const html = renderToStaticMarkup(
    <StepBar status="drafting" selected="clarify" onSelect={() => {}} />,
  );
  expect((html.match(/<button/g) || []).length).toBe(5);
});

test("当前步骤之前的步骤是 done 态（success 配色）", () => {
  const html = renderToStaticMarkup(
    <StepBar status="running" selected="execute" onSelect={() => {}} />,
  );
  expect(html).toContain("bg-success/15");
});

test("选中步骤有 accent 描边 pill 高亮（深色下下划线不可见，已改 ring）", () => {
  const html = renderToStaticMarkup(
    <StepBar status="running" selected="clarify" onSelect={() => {}} />,
  );
  expect(html).toContain("ring-accent/40");
});

test("failed 时完成步：圈与标签都标红（含选中态）", () => {
  const html = renderToStaticMarkup(
    <StepBar status="failed" selected="done" onSelect={() => {}} />,
  );
  expect(html).toContain("bg-destructive"); // 圈红
  expect(html).toContain("font-medium text-destructive"); // 标签也红（旧 bug 会漏）
});

test("cancelled 时完成步同样标红", () => {
  const html = renderToStaticMarkup(
    <StepBar status="cancelled" selected="done" onSelect={() => {}} />,
  );
  expect(html).toContain("font-medium text-destructive");
});

test("running 时恰好 2 个步骤为 done 态", () => {
  const html = renderToStaticMarkup(
    <StepBar status="running" selected="execute" onSelect={() => {}} />,
  );
  expect((html.match(/bg-success\/15/g) || []).length).toBe(2); // 澄清/审批
});
