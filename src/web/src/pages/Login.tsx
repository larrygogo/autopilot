import React, { useState } from "react";

interface LoginPageProps {
  onLogin: () => Promise<void>;
  /** true 时展示"创建首个账号"表单（/api/auth/setup） */
  isSetup?: boolean;
}

/**
 * 全屏登录/初始化页，延续项目蓝图风格：
 * - 无圆角 (rounded-none)
 * - 1.5px 边框
 * - font-display / font-mono 文字层级
 * - accent 色主操作按钮
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
      <div className="w-full max-w-sm border-[1.5px] border-foreground/30 bg-card">
        {/* Logo header */}
        <div className="flex h-12 items-center gap-2.5 border-b-[1.5px] border-foreground/30 px-4">
          <div className="bp-num-block h-7 w-7 text-sm">A</div>
          <div className="flex flex-col leading-none">
            <span className="font-display text-base font-bold uppercase tracking-wider">
              Autopilot
            </span>
            <span className="font-mono text-[9px] uppercase tracking-[0.25em] text-muted-foreground mt-0.5">
              CTRL · v1.0
            </span>
          </div>
        </div>

        {/* Form */}
        <form onSubmit={(e) => void submit(e)} className="p-6 space-y-4">
          {/* 标题 */}
          <div className="space-y-0.5">
            <h1 className="font-display text-sm font-bold uppercase tracking-wider">
              {isSetup ? "创建管理员账号" : "登录"}
            </h1>
            <p className="font-mono text-[10px] text-muted-foreground">
              {isSetup
                ? "首次使用请创建账号以启用 auth"
                : "请输入你的邮箱和密码继续"}
            </p>
          </div>

          {/* 邮箱 */}
          <div className="space-y-1.5">
            <label className="block font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
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
              className="w-full border-[1.5px] border-foreground/30 bg-background px-3 py-2 font-mono text-sm placeholder:text-muted-foreground/50 focus:border-accent focus:outline-none rounded-none disabled:opacity-50"
            />
          </div>

          {/* 密码 */}
          <div className="space-y-1.5">
            <label className="block font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
              密码{isSetup && <span className="ml-1 normal-case tracking-normal text-muted-foreground/60">（至少 8 位）</span>}
            </label>
            <input
              type="password"
              autoComplete={isSetup ? "new-password" : "current-password"}
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={loading}
              className="w-full border-[1.5px] border-foreground/30 bg-background px-3 py-2 font-mono text-sm placeholder:text-muted-foreground/50 focus:border-accent focus:outline-none rounded-none disabled:opacity-50"
            />
          </div>

          {/* 错误提示 */}
          {errorMsg && (
            <p className="font-mono text-xs text-destructive leading-relaxed">{errorMsg}</p>
          )}

          {/* 提交按钮 */}
          <button
            type="submit"
            disabled={loading}
            className="w-full border-[1.5px] border-foreground bg-foreground px-3 py-2.5 font-display text-xs font-bold uppercase tracking-wider text-background hover:bg-accent hover:border-accent disabled:opacity-50 rounded-none transition-colors"
          >
            {loading ? "处理中…" : isSetup ? "创建账号" : "登录"}
          </button>
        </form>
      </div>
    </div>
  );
}
