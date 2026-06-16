/**
 * tool 模式 decision 的两个纯/轻逻辑缝：
 * - parseVerdictBlock：文本路径从 agent 输出解析裁决 JSON 块（容错）
 * - agentSupportsMcpTools：判 provider 能否走工具硬契约（仅 cli claude）
 *
 * 完整 nudge/捕获/状态机回路靠 demo 工作流的真任务 dogfood 验（同 dev 纯提示词验法），
 * 不在此跑完整 runner+agent（与 review-loop-decision 测试同哲学）。
 */
import { describe, it, expect } from "bun:test";
import { parseVerdictBlock } from "../src/core/workflow/prompt-runner";
import { agentSupportsMcpTools, createAgent } from "../src/agents/registry";

describe("parseVerdictBlock 文本路径解析", () => {
  it("```json 围栏 pass", () => {
    const t = "评审完成。\n\n```json\n{\"verdict\": \"pass\", \"reason\": \"\"}\n```";
    expect(parseVerdictBlock(t)).toEqual({ verdict: "pass" });
  });

  it("```json 围栏 reject（带 reason）", () => {
    const t = "有问题。\n```json\n{\"verdict\":\"reject\",\"reason\":\"缺单测\"}\n```";
    expect(parseVerdictBlock(t)).toEqual({ verdict: "reject", reason: "缺单测" });
  });

  it("裸 JSON 对象（无围栏）也能解析", () => {
    const t = '结论：{"verdict":"pass","reason":"ok"}';
    expect(parseVerdictBlock(t)).toEqual({ verdict: "pass" });
  });

  it("多个候选 → 取文本中靠后的（agent 改主意）", () => {
    const t = '```json\n{"verdict":"reject","reason":"早先想驳"}\n```\n再想想……\n```json\n{"verdict":"pass","reason":""}\n```';
    expect(parseVerdictBlock(t)).toEqual({ verdict: "pass" });
  });

  it("reject 无 reason → 视为无效候选，回退 null（必经锁会追问）", () => {
    const t = '```json\n{"verdict":"reject","reason":""}\n```';
    expect(parseVerdictBlock(t)).toBeNull();
  });

  it("无裁决块 → null", () => {
    expect(parseVerdictBlock("我做完了评审但忘了下结论。")).toBeNull();
  });

  it("非法 verdict 值 → null", () => {
    expect(parseVerdictBlock('```json\n{"verdict":"maybe"}\n```')).toBeNull();
  });

  it("坏 JSON → 不抛错，返回 null", () => {
    expect(parseVerdictBlock('```json\n{verdict: pass,,,}\n```')).toBeNull();
  });
});

describe("agentSupportsMcpTools provider 能力判定", () => {
  it("cli claude（anthropic）→ true", () => {
    expect(agentSupportsMcpTools(createAgent({ name: "a", provider: "anthropic" }))).toBe(true);
  });

  it("cli codex（openai）→ false（无 MCP 接线）", () => {
    expect(agentSupportsMcpTools(createAgent({ name: "b", provider: "openai" }))).toBe(false);
  });

  it("cli gemini（google）→ false", () => {
    expect(agentSupportsMcpTools(createAgent({ name: "c", provider: "google" }))).toBe(false);
  });
});
