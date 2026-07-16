/**
 * `autopilot service` —— 把 daemon 注册为系统级开机自启服务（子项目 C · runner 稳定长跑）。
 *
 * 模型：让**系统服务管理器成为最外层看护**，开机时前台跑 `autopilot daemon run --supervise`。
 *   - 内部 supervisor（src/daemon/supervisor.ts）管进程崩溃的快恢复（指数退避 / crash-loop 熔断）；
 *   - OS 管理器管两件 supervisor 兜不住的事：**机器重启后拉起** + **supervisor 自身退出后重启**。
 *   两层看护正交，合起来补上「重启不回来」「supervisor 挂了没人管」两个 runner 硬缺口。
 *
 * 全部走**用户级、免管理员**渠道：
 *   - Linux   → systemd user unit（`~/.config/systemd/user/autopilot.service`）+ enable-linger
 *   - macOS   → launchd LaunchAgent（`~/Library/LaunchAgents/com.autopilot.daemon.plist`）
 *   - Windows → HKCU Run 注册表键（登录自启，零提权）。schtasks ONLOGON 在根任务目录实测需管理员
 *     （非提权 shell 报 Access denied），故不用；真 Windows Service（登录前启动 + restart-on-exit）
 *     需管理员 + 服务宿主，留后续。HKCU Run 是 OneDrive / 飞书等应用的同款用户级自启渠道。
 *
 * 托管的命令由 daemonSpawnPlan(supervise:true) 统一裁决（与 `daemon start` 同一真相源）：
 *   编译单文件 → `<exe> daemon run --supervise`；dev → `bun run <supervisor.ts>`。
 */

import { spawnSync as nodeSpawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { Command } from "commander";
import { isStandaloneBinary } from "../core/runtime-env";
import { daemonSpawnPlan } from "./spawn-plan";

export const SERVICE_NAME = "autopilot";
export const LAUNCHD_LABEL = "com.autopilot.daemon";
const WINDOWS_RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const WINDOWS_RUN_VALUE_NAME = "autopilot-daemon";

/** systemd ExecStart / execLine 用：含空格或引号的 token 双引号包裹并转义内部引号。 */
export function shQuote(s: string): string {
  return /[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s;
}

/** 托管命令：复用 daemonSpawnPlan（supervise:true），与 `daemon start` 同一真相源。 */
export function resolveServiceExec(opts: {
  standalone: boolean;
  execPath: string;
  scriptDir: string;
}): { cmd: string; args: string[] } {
  return daemonSpawnPlan({
    standalone: opts.standalone,
    supervise: true,
    execPath: opts.execPath,
    scriptDir: opts.scriptDir,
  });
}

// ════════════════════════════════════════════════════════════════════════════
// 纯生成器（无副作用，便于单测）
// ════════════════════════════════════════════════════════════════════════════

/** systemd user unit 文件内容。execLine = 已 shQuote 的完整命令行。 */
export function systemdUnitContent(opts: {
  cmd: string;
  args: string[];
  autopilotHome?: string;
}): string {
  const execLine = [opts.cmd, ...opts.args].map(shQuote).join(" ");
  const envLines = opts.autopilotHome
    ? `Environment=AUTOPILOT_HOME=${opts.autopilotHome}\n`
    : "";
  return `[Unit]
Description=autopilot daemon (multi-stage task runner)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${execLine}
Restart=on-failure
RestartSec=5
${envLines}
[Install]
WantedBy=default.target
`;
}

/** launchd LaunchAgent plist 内容。ProgramArguments = [cmd, ...args] 逐个 <string>。 */
export function launchdPlistContent(opts: {
  label: string;
  cmd: string;
  args: string[];
  autopilotHome?: string;
  logDir: string;
}): string {
  const escapeXml = (s: string): string =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const progArgs = [opts.cmd, ...opts.args]
    .map((a) => `    <string>${escapeXml(a)}</string>`)
    .join("\n");
  const envBlock = opts.autopilotHome
    ? `  <key>EnvironmentVariables</key>
  <dict>
    <key>AUTOPILOT_HOME</key>
    <string>${escapeXml(opts.autopilotHome)}</string>
  </dict>
`
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(opts.label)}</string>
  <key>ProgramArguments</key>
  <array>
${progArgs}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
${envBlock}  <key>StandardOutPath</key>
  <string>${escapeXml(join(opts.logDir, "launchd.out.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(join(opts.logDir, "launchd.err.log"))}</string>
</dict>
</plist>
`;
}

/**
 * Windows HKCU Run 键的命令值：`"<exe>" <args>`。exe 路径必带双引号（Program Files 含空格）——
 * 与系统内既有 Run 项（OneDrive 等）同款格式。Windows 登录时按此值启动。
 */
export function windowsRunCommand(opts: { cmd: string; args: string[] }): string {
  const quotedCmd = `"${opts.cmd}"`;
  return [quotedCmd, ...opts.args].join(" ");
}

// ════════════════════════════════════════════════════════════════════════════
// 平台路径
// ════════════════════════════════════════════════════════════════════════════

function systemdUnitPath(): string {
  return join(homedir(), ".config", "systemd", "user", `${SERVICE_NAME}.service`);
}

function launchdPlistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
}

/** 服务日志目录（launchd stdout/stderr 落此）。 */
function serviceLogDir(): string {
  const home = process.env.AUTOPILOT_HOME || join(homedir(), ".autopilot");
  return join(home, "runtime", "logs");
}

// ════════════════════════════════════════════════════════════════════════════
// install / uninstall / status（命令实现）
// ════════════════════════════════════════════════════════════════════════════

function run(cmd: string, args: string[]): { code: number; stdout: string; stderr: string } {
  const r = nodeSpawnSync(cmd, args, { encoding: "utf-8", windowsHide: true });
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function hasCommand(cmd: string): boolean {
  const probe = process.platform === "win32"
    ? run("where", [cmd])
    : run("sh", ["-c", `command -v ${cmd}`]);
  return probe.code === 0;
}

function currentExec(): { cmd: string; args: string[] } {
  return resolveServiceExec({
    standalone: isStandaloneBinary(),
    execPath: process.execPath,
    scriptDir: import.meta.dir,
  });
}

function installLinux(dryRun: boolean): number {
  if (!dryRun && !hasCommand("systemctl")) {
    console.error("错误：未找到 systemctl（本机可能非 systemd 发行版）。");
    console.error("  可改用 crontab 的 @reboot 项手动配置：");
    const { cmd, args } = currentExec();
    console.error(`  @reboot ${[cmd, ...args].map(shQuote).join(" ")}`);
    return 1;
  }
  const { cmd, args } = currentExec();
  const home = process.env.AUTOPILOT_HOME || undefined;
  const unitPath = systemdUnitPath();
  const content = systemdUnitContent({ cmd, args, autopilotHome: home });
  if (dryRun) {
    console.log(`[dry-run] 将写入 systemd user unit：${unitPath}`);
    console.log(`[dry-run] 随后执行：systemctl --user daemon-reload; loginctl enable-linger ${process.env.USER ?? "<user>"}; systemctl --user enable --now ${SERVICE_NAME}`);
    console.log("──── unit 内容 ────");
    console.log(content);
    return 0;
  }
  mkdirSync(join(homedir(), ".config", "systemd", "user"), { recursive: true });
  writeFileSync(unitPath, content);
  console.log(`已写入 systemd user unit：${unitPath}`);

  run("systemctl", ["--user", "daemon-reload"]);
  // enable-linger：无需登录也能开机自启（headless / SSH 断开后仍在）
  const linger = run("loginctl", ["enable-linger", process.env.USER ?? ""]);
  if (linger.code !== 0) {
    console.log("提示：loginctl enable-linger 未成功——注销后服务可能停止（需要时手动开启 linger）。");
  }
  const en = run("systemctl", ["--user", "enable", "--now", SERVICE_NAME]);
  if (en.code !== 0) {
    console.error(`systemctl enable --now 失败：${en.stderr.trim() || en.stdout.trim()}`);
    return 1;
  }
  console.log(`✓ 已启用并启动开机自启服务（systemctl --user status ${SERVICE_NAME} 查看）。`);
  return 0;
}

function installMacos(dryRun: boolean): number {
  const { cmd, args } = currentExec();
  const home = process.env.AUTOPILOT_HOME || undefined;
  const logDir = serviceLogDir();
  const plistPath = launchdPlistPath();
  const content = launchdPlistContent({ label: LAUNCHD_LABEL, cmd, args, autopilotHome: home, logDir });
  if (dryRun) {
    console.log(`[dry-run] 将写入 launchd LaunchAgent：${plistPath}`);
    console.log(`[dry-run] 随后执行：launchctl unload -w <plist>; launchctl load -w <plist>`);
    console.log("──── plist 内容 ────");
    console.log(content);
    return 0;
  }
  mkdirSync(logDir, { recursive: true });
  mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
  writeFileSync(plistPath, content);
  console.log(`已写入 launchd LaunchAgent：${plistPath}`);
  // 先 unload（幂等清旧）再 load -w（-w 写 disabled=false，开机自启）
  run("launchctl", ["unload", "-w", plistPath]);
  const load = run("launchctl", ["load", "-w", plistPath]);
  if (load.code !== 0) {
    console.error(`launchctl load 失败：${load.stderr.trim() || load.stdout.trim()}`);
    return 1;
  }
  console.log(`✓ 已加载开机自启 LaunchAgent（launchctl list | grep ${LAUNCHD_LABEL} 查看）。`);
  return 0;
}

function installWindows(dryRun: boolean): number {
  const { cmd, args } = currentExec();
  const value = windowsRunCommand({ cmd, args });
  if (dryRun) {
    console.log(`[dry-run] 将执行：reg add ${WINDOWS_RUN_KEY} /v ${WINDOWS_RUN_VALUE_NAME} /t REG_SZ /d <值> /f`);
    console.log(`[dry-run] 命令值：${value}`);
    return 0;
  }
  // HKCU Run 键：登录自启，零提权（schtasks ONLOGON 在根目录实测需管理员，故改用此渠道）。
  const r = run("reg", [
    "add", WINDOWS_RUN_KEY,
    "/v", WINDOWS_RUN_VALUE_NAME,
    "/t", "REG_SZ",
    "/d", value,
    "/f",
  ]);
  if (r.code !== 0) {
    console.error(`reg add 失败：${r.stderr.trim() || r.stdout.trim()}`);
    return 1;
  }
  console.log(`✓ 已写入登录自启项（HKCU\\...\\Run\\${WINDOWS_RUN_VALUE_NAME}）。`);
  console.log("  下次登录 Windows 时自动启动；本次可 `autopilot daemon start` 立即起。");
  console.log("  注：这是用户登录级自启（免管理员），非登录前的系统服务（真 Windows Service 需管理员）。");
  return 0;
}

function uninstallLinux(): number {
  if (hasCommand("systemctl")) {
    run("systemctl", ["--user", "disable", "--now", SERVICE_NAME]);
    run("systemctl", ["--user", "daemon-reload"]);
  }
  const unitPath = systemdUnitPath();
  if (existsSync(unitPath)) rmSync(unitPath);
  console.log("✓ 已移除 systemd user unit 并停用自启。");
  return 0;
}

function uninstallMacos(): number {
  const plistPath = launchdPlistPath();
  if (existsSync(plistPath)) {
    run("launchctl", ["unload", "-w", plistPath]);
    rmSync(plistPath);
  }
  console.log("✓ 已卸载 LaunchAgent 并停用自启。");
  return 0;
}

function uninstallWindows(): number {
  const r = run("reg", ["delete", WINDOWS_RUN_KEY, "/v", WINDOWS_RUN_VALUE_NAME, "/f"]);
  // reg delete 对不存在的值返回非 0 + "unable to find"——视作已卸载，不报错。
  if (r.code !== 0 && !/找不到|cannot find|unable to find/i.test(r.stderr + r.stdout)) {
    console.error(`reg delete 失败：${r.stderr.trim() || r.stdout.trim()}`);
    return 1;
  }
  console.log(`✓ 已移除登录自启项「${WINDOWS_RUN_VALUE_NAME}」。`);
  return 0;
}

function statusLinux(): number {
  const unitPath = systemdUnitPath();
  console.log(`unit 文件：${existsSync(unitPath) ? unitPath : "（未安装）"}`);
  if (hasCommand("systemctl")) {
    const enabled = run("systemctl", ["--user", "is-enabled", SERVICE_NAME]);
    const active = run("systemctl", ["--user", "is-active", SERVICE_NAME]);
    console.log(`开机自启：${enabled.stdout.trim() || enabled.stderr.trim() || "unknown"}`);
    console.log(`当前状态：${active.stdout.trim() || active.stderr.trim() || "unknown"}`);
  }
  return 0;
}

function statusMacos(): number {
  const plistPath = launchdPlistPath();
  console.log(`plist 文件：${existsSync(plistPath) ? plistPath : "（未安装）"}`);
  const list = run("launchctl", ["list"]);
  const line = list.stdout.split(/\r?\n/).find((l) => l.includes(LAUNCHD_LABEL));
  console.log(`launchd 登记：${line ? line.trim() : "（未加载）"}`);
  return 0;
}

function statusWindows(): number {
  const r = run("reg", ["query", WINDOWS_RUN_KEY, "/v", WINDOWS_RUN_VALUE_NAME]);
  if (r.code !== 0) {
    console.log(`登录自启项「${WINDOWS_RUN_VALUE_NAME}」：未安装。`);
    return 0;
  }
  console.log(r.stdout.trim());
  return 0;
}

function dispatch(
  platform: NodeJS.Platform,
  handlers: { linux: () => number; darwin: () => number; win32: () => number },
): number {
  if (platform === "linux") return handlers.linux();
  if (platform === "darwin") return handlers.darwin();
  if (platform === "win32") return handlers.win32();
  console.error(`错误：不支持的平台 ${platform}（service 仅支持 linux / macOS / Windows）。`);
  return 1;
}

export function registerServiceCommands(program: Command): void {
  const service = program
    .command("service")
    .description("把 daemon 注册为系统级开机自启服务（无人值守 runner）");

  service
    .command("install")
    .description("安装并启用开机自启（Linux systemd / macOS launchd / Windows HKCU Run 登录自启）")
    .option("--dry-run", "只打印将写入的文件路径 / 内容 / 将执行的命令，不实际改动系统")
    .action((opts: { dryRun?: boolean }) => {
      const dryRun = opts.dryRun ?? false;
      if (!isStandaloneBinary()) {
        console.log("提示：当前为 dev 模式，服务将指向本机 bun + 源码路径。");
        console.log("  给最终用户分发时建议用编译单文件（bun run build:exe）后再 install。");
      }
      const code = dispatch(process.platform, {
        linux: () => installLinux(dryRun),
        darwin: () => installMacos(dryRun),
        win32: () => installWindows(dryRun),
      });
      process.exit(code);
    });

  service
    .command("uninstall")
    .description("停用并移除开机自启服务")
    .action(() => {
      const code = dispatch(process.platform, {
        linux: uninstallLinux,
        darwin: uninstallMacos,
        win32: uninstallWindows,
      });
      process.exit(code);
    });

  service
    .command("status")
    .description("查看开机自启服务的安装 / 启用状态")
    .action(() => {
      const code = dispatch(process.platform, {
        linux: statusLinux,
        darwin: statusMacos,
        win32: statusWindows,
      });
      process.exit(code);
    });
}
