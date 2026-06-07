import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** 取路径最后一段目录名（兼容 Windows \ 和 POSIX /，忽略结尾分隔符） */
export function folderName(p: string): string {
  const trimmed = p.trim().replace(/[\\/]+$/, "");
  return trimmed.split(/[\\/]/).pop() ?? "";
}
