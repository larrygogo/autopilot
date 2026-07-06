/**
 * 编译单文件（bun build --compile）运行时探测。
 * 编译后 import.meta.dir 指向 bun 虚拟根：Windows `B:/~BUN/root`、posix `/$bunfs/root`。
 * dev（bun run）下是真实磁盘目录。用于 #4 spawn 在编译模式改走 execPath 子命令。
 */
export function isStandaloneDir(dir: string): boolean {
  return dir.includes("/$bunfs/") || dir.includes("\\$bunfs\\") || /[/\\]~BUN[/\\]/.test(dir);
}

export function isStandaloneBinary(): boolean {
  return isStandaloneDir(import.meta.dir);
}
