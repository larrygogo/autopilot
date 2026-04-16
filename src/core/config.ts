import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { parse as parseYaml } from "yaml";
import { AUTOPILOT_HOME } from "../index";
import { log } from "./logger";

export function loadConfig(): Record<string, unknown> {
  const paths = [
    process.env.DEV_WORKFLOW_CONFIG,
    join(AUTOPILOT_HOME, "config.yaml"),
    join(process.cwd(), "config.yaml"),
  ].filter(Boolean) as string[];

  for (const p of paths) {
    if (existsSync(p)) {
      try {
        const content = readFileSync(p, "utf-8");
        return parseYaml(content) ?? {};
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        log.error("配置文件解析失败（%s）：%s", p, message);
        throw new Error(`配置文件解析失败（${p}）：${message}`);
      }
    }
  }
  return {};
}
