import React, { useState } from "react";

interface LoginPageProps {
  onLogin: () => Promise<void>;
  /** true 时展示"创建首个账号"表单（/api/auth/setup） */
  isSetup?: boolean;
}

/**
 * 全屏登录/初始化页。
 */
export function LoginPage({ onLogin, isSetup = false }: LoginPageProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErrorMsg(null);

    const trimEmail = email.trim();
    const trimPwd = password;

    if (!trimEmail || !trimPwd) {
      setErrorMsg("请填写邮箱和密码");
      return;
    }
    if (isSetup && trimPwd.length < 8) {
      setErrorMsg("密码至少 8 位");
      return;
    }

    setLoading(true);
    try {
      const endpoint = isSetup ? "/api/auth/setup" : "/api/auth/login";
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: trimEmail, password: trimPwd }),
      });

      const data = (await res.json()) as { error?: string };

      if (!res.ok) {
        setErrorMsg(data.error ?? "操作失败，请重试");
        return;
      }

      // 登录成功 → 通知父组件刷新 auth 状态
      await onLogin();
    } catch {
      setErrorMsg("网络错误，请检查 daemon 是否运行");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-6">
      <div className="w-full max-w-sm border border-border bg-card rounded-lg">
        {/* Logo header */}
        <div className="flex h-12 items-center gap-2.5 border-b border-border px-4">
          <div className="bp-num-block h-7 w-7 text-sm">A</div>
          <div className="flex flex-col leading-none">
            <span className="text-base font-bold">
              Autopilot
            </span>
            <span className="bp-label text-muted-foreground mt-0.5">
              CTRL · v1.0
            </span>
          </div>
        </div>

        {/* Form */}
        <form onSubmit={(e) => void submit(e)} className="p-6 space-y-4">
          {/* 标题 */}
          <div className="space-y-0.5">
            <h1 className="text-sm font-bold">
              {isSetup ? "创建管理员账号" : "登录"}
            </h1>
            <p className="text-[10px] text-muted-foreground">
              {isSetup
                ? "首次使用请创建账号以启用 auth"
                : "请输入你的邮箱和密码继续"}
            </p>
          </div>

          {/* 邮箱 */}
          <div className="space-y-1.5">
            <label className="block bp-label text-muted-foreground">
              邮箱
            </label>
            <input
              type="email"
              autoFocus
              autoComplete="email"
              placeholder="user@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={loading}
              className="w-full border border-border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground/50 focus:border-accent focus:outline-none rounded-md disabled:opacity-50"
            />
          </div>

          {/* 密码 */}
          <div className="space-y-1.5">
            <label className="block bp-label text-muted-foreground">
              密码{isSetup && <span className="ml-1 text-muted-foreground/60">（至少 8 位）</span>}
            </label>
            <input
              type="password"
              autoComplete={isSetup ? "new-password" : "current-password"}
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={loading}
              className="w-full border border-border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground/50 focus:border-accent focus:outline-none rounded-md disabled:opacity-50"
            />
          </div>

          {/* 错误提示 */}
          {errorMsg && (
            <p className="text-xs text-destructive leading-relaxed">{errorMsg}</p>
          )}

          {/* 提交按钮 */}
          <button
            type="submit"
            disabled={loading}
            className="w-full border border-foreground bg-foreground px-3 py-2.5 text-xs font-bold text-background hover:bg-accent hover:border-accent disabled:opacity-50 rounded-md transition-colors"
          >
            {loading ? "处理中…" : isSetup ? "创建账号" : "登录"}
          </button>
        </form>
      </div>
    </div>
  );
}
