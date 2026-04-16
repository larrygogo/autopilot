import { existsSync, readFileSync, writeFileSync, copyFileSync } from "fs";
import { join } from "path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { AUTOPILOT_HOME } from "../index";
import { log } from "./logger";

/**
 * 返回当前使用的 config.yaml 路径。
 * 优先级：DEV_WORKFLOW_CONFIG > AUTOPILOT_HOME/config.yaml
 */
export function getConfigPath(): string {
  if (process.env.DEV_WORKFLOW_CONFIG && existsSync(process.env.DEV_WORKFLOW_CONFIG)) {
    return process.env.DEV_WORKFLOW_CONFIG;
  }
  return join(AUTOPILOT_HOME, "config.yaml");
}

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

/**
 * 读取 config.yaml 原文。
 */
export function loadConfigRaw(): string {
  const p = getConfigPath();
  if (existsSync(p)) {
    return readFileSync(p, "utf-8");
  }
  return "";
}

/**
 * 保存配置到 config.yaml。写入前备份原文件。
 * @param yamlContent YAML 格式的字符串
 * @throws 如果 YAML 解析失败
 */
export function saveConfigRaw(yamlContent: string): void {
  // 先校验 YAML 语法
  parseYaml(yamlContent);

  const p = getConfigPath();
  // 备份
  if (existsSync(p)) {
    copyFileSync(p, p + ".bak");
  }
  writeFileSync(p, yamlContent, "utf-8");
}
