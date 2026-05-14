import type { Command } from "commander";
import { existsSync, readFileSync } from "fs";
import { runChecks, type DoctorReport } from "../core/doctor";
import { getConfigPath } from "../core/config";
import { initDb } from "../core/db";

export function registerConfigCommands(program: Command): void {
  const config = program.command("config").description("配置管理（init / 检查 / 修复）");

  config
    .command("doctor")
    .description("检查配置（默认 L1；--probe 走 L2+L3）")
    .option("--probe", "包含 L2 CLI + L3 凭证探测")
    .option("--json", "JSON 输出")
    .option("--fix", "交互式修复向导")
    .action(async (opts: { probe?: boolean; json?: boolean; fix?: boolean }) => {
      if (opts.fix) {
        const { runFixWizard } = await import("./config-fix");
        await runFixWizard();
        return;
      }
      try { initDb(); } catch {}
      const level = opts.probe ? 3 : 1;
      let report: DoctorReport;
      try {
        report = await runChecks({ level });
      } catch (e: unknown) {
        console.error(`doctor 自身异常：${e instanceof Error ? e.message : String(e)}`);
        process.exit(3);
        // 告知 TS 此处不可达
        throw e;
      }
      if (opts.json) console.log(JSON.stringify(report));
      else printReport(report);
      process.exit(exitCodeFor(report.status));
    });

  config
    .command("show")
    .description("打印 config.yaml 原文（脱敏 base_url 凭证）")
    .action(() => {
      const p = getConfigPath();
      if (!existsSync(p)) {
        console.error(`config.yaml 不存在：${p}`);
        process.exit(1);
      }
      console.log(redactCredentials(readFileSync(p, "utf-8")));
    });

  config
    .command("path")
    .description("打印 config.yaml 绝对路径")
    .action(() => { console.log(getConfigPath()); });
}

export function printReport(report: DoctorReport): void {
  const lvLabel = report.level === 1 ? "L1 静态" : report.level === 2 ? "L2 + CLI" : "L3 全探测";
  for (const c of report.checks) {
    const icon = c.status === "ok" ? "[✓]" : c.status === "warning" ? "[!]" : c.status === "skipped" ? "[-]" : "[✗]";
    console.log(`${icon} ${c.title}`);
    if (c.detail) console.log(`      ${c.detail}`);
    if (c.fix?.cli) console.log(`      修复：${c.fix.cli}`);
    if (c.fix?.url) console.log(`      或访问：${c.fix.url}`);
  }
  const errors = report.checks.filter((c) => c.status === "error").length;
  const warnings = report.checks.filter((c) => c.status === "warning").length;
  console.log(`${lvLabel} (${errors} errors, ${warnings} warnings)`);
}

function exitCodeFor(status: DoctorReport["status"]): number {
  return status === "ok" ? 0 : status === "warning" ? 1 : 2;
}

function redactCredentials(yaml: string): string {
  return yaml.replace(/(base_url:\s*['"]?)([^'"\s]+:\/\/)([^@'"\s]+)@/g, "$1$2***@");
}
