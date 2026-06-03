import React from "react";
import { useAuth } from "../hooks/useAuth";
import { LoginPage } from "../pages/Login";
import { TokenGate } from "./TokenGate";

/**
 * 认证门：
 * - auth 未启用（users 表无记录）→ 退化为 TokenGate（兼容旧 API token 模式）
 * - auth 已启用 + 未登录 → 显示登录页
 * - auth 已启用 + 已登录 → 直接渲染 children（JWT cookie 鉴权，无需 TokenGate）
 */
export function AuthGate({ children }: { children: React.ReactNode }) {
  const { user, loading, authEnabled, refresh } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <span className="text-[11px] text-muted-foreground animate-pulse">
          验证中…
        </span>
      </div>
    );
  }

  // auth 未启用 → 兼容旧 Token Gate 模式
  if (!authEnabled) {
    return <TokenGate>{children}</TokenGate>;
  }

  // auth 已启用但未登录 → 显示登录页
  if (!user) {
    return <LoginPage onLogin={refresh} />;
  }

  // 已登录 → 直接渲染（JWT cookie 由浏览器自动携带，后端已认证）
  return <>{children}</>;
}
