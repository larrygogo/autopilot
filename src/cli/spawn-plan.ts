/**
 * 计算后台 daemon/supervisor 进程的 spawn 目标（纯函数，便于测试）。
 *
 * - 编译单文件模式（standalone=true）：走 process.execPath 子命令（无 bun / .ts 文件）
 * - dev 模式（standalone=false）：走 bun run <script.ts>
 */
export function daemonSpawnPlan(opts: {
  standalone: boolean;
  supervise: boolean;
  execPath: string;
  scriptDir: string;
  port?: number;
  host?: string;
}): { cmd: string; args: string[] } {
  const extra: string[] = [];
  if (opts.port) extra.push("--port", String(opts.port));
  if (opts.host) extra.push("--host", opts.host);

  if (opts.standalone) {
    // 编译模式：重入自身二进制，走 daemon run [--supervise]
    const sub = opts.supervise
      ? ["daemon", "run", "--supervise"]
      : ["daemon", "run"];
    return { cmd: opts.execPath, args: [...sub, ...extra] };
  }

  // dev 模式：bun run <script.ts>
  const script = opts.supervise
    ? `${opts.scriptDir}/../daemon/supervisor.ts`
    : `${opts.scriptDir}/../daemon/index.ts`;
  return { cmd: "bun", args: ["run", script, ...extra] };
}
