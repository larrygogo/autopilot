import { useState, useEffect, useCallback } from "react";

export interface AuthUser {
  id: number;
  email: string;
  created_at: string;
}

interface AuthState {
  user: AuthUser | null;
  loading: boolean;
  /** auth 是否启用（users 表有记录才算启用） */
  authEnabled: boolean;
}

interface UseAuthReturn extends AuthState {
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}

export function useAuth(): UseAuthReturn {
  const [state, setState] = useState<AuthState>({
    user: null,
    loading: true,
    authEnabled: false,
  });

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/auth/me");
      const data = (await res.json()) as {
        auth_enabled?: boolean;
        user?: AuthUser | null;
        code?: string;
      };

      if (res.ok) {
        setState({
          user: data.user ?? null,
          loading: false,
          authEnabled: data.auth_enabled ?? false,
        });
      } else if (res.status === 401) {
        setState({
          user: null,
          loading: false,
          authEnabled: data.auth_enabled ?? true,
        });
      } else {
        // 网络或服务器错误：假设 auth 未启用，不卡住界面
        setState({ user: null, loading: false, authEnabled: false });
      }
    } catch {
      setState({ user: null, loading: false, authEnabled: false });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const logout = useCallback(async () => {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch { /* ignore */ }
    setState((s) => ({ ...s, user: null }));
    // 重新检查以刷新 authEnabled 状态
    await refresh();
  }, [refresh]);

  return { ...state, refresh, logout };
}
