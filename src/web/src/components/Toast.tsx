import React from "react";
import { toast as sonnerToast } from "@/components/ui/sonner";

export type ToastLevel = "success" | "info" | "warning" | "error";

interface ToastItem {
  level: ToastLevel;
  message: string;
  /** 错误信息展开时显示的详情/堆栈 */
  detail?: string;
  /** 持久 toast（不自动消失）。error 默认持久 */
  persistent?: boolean;
}

export interface ToastApi {
  success: (message: string) => void;
  info: (message: string) => void;
  warning: (message: string) => void;
  /** 错误默认持久，必须手动关闭；可传 detail 显示展开区 */
  error: (message: string, detail?: string) => void;
  /** 底层 API */
  show: (item: ToastItem) => string | number;
  dismiss: (id: string | number) => void;
}

function makeAction(message: string, detail?: string) {
  if (!detail) return undefined;
  return {
    label: "复制",
    onClick: () => {
      navigator.clipboard.writeText(`${message}\n\n${detail}`).catch(() => {});
    },
  };
}

const api: ToastApi = {
  success: (m) => {
    sonnerToast.success(m);
  },
  info: (m) => {
    sonnerToast.info(m);
  },
  warning: (m) => {
    sonnerToast.warning(m);
  },
  error: (m, detail) => {
    sonnerToast.error(m, {
      description: detail,
      duration: Infinity,
      closeButton: true,
      action: makeAction(m, detail),
    });
  },
  show: (item) => {
    const persistent = item.persistent ?? item.level === "error";
    const opts = {
      description: item.detail,
      ...(persistent ? { duration: Infinity, closeButton: true } : {}),
      ...(item.detail ? { action: makeAction(item.message, item.detail) } : {}),
    };
    return sonnerToast[item.level](item.message, opts);
  },
  dismiss: (id) => {
    sonnerToast.dismiss(id);
  },
};

/** 兼容旧调用：sonner 是全局的，Provider 只透传 children。 */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

export function useToast(): ToastApi {
  return api;
}

/** 与 useToast 等价；保留接口以防有调用方区分。 */
export const useToastSafe = useToast;
