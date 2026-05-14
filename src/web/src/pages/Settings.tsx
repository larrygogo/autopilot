import React, { useEffect, useMemo, useState } from "react";
import { RefreshCw, Search, ExternalLink } from "lucide-react";
import { api } from "@/hooks/useApi";
import { useToast } from "@/components/Toast";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { PageHero } from "@/components/PageHero";
import { TimezoneSelect } from "@/components/TimezoneSelect";

// 保留 embedded 参数签名以兼容旧调用
export function Settings(_props: { embedded?: boolean } = {}) {
  const toast = useToast();

  const [defaultsTz, setDefaultsTz] = useState<string | null>(null);
  const [systemTz, setSystemTz] = useState<string>("");
  const [defaultsLoading, setDefaultsLoading] = useState(true);
  const [defaultsSaving, setDefaultsSaving] = useState(false);

  const [status, setStatus] = useState<any>(null);
  const [configPath, setConfigPath] = useState<string | null>(null);

  useEffect(() => {
    api.getDefaults()
      .then((res) => {
        setDefaultsTz(res.timezone);
        setSystemTz(res.system_timezone);
      })
      .catch((e) => toast.error("加载默认偏好失败", e?.message ?? String(e)))
      .finally(() => setDefaultsLoading(false));
  }, []);

  const saveDefaults = async (tz: string | null) => {
    setDefaultsSaving(true);
    try {
      const res = await api.saveDefaults({ timezone: tz });
      setDefaultsTz(res.timezone);
      toast.success("默认偏好已保存");
    } catch (e: any) {
      toast.error("保存失败", e?.message ?? String(e));
    } finally {
      setDefaultsSaving(false);
    }
  };

  useEffect(() => {
    api.getStatus().then(setStatus).catch(() => {});
  }, []);

  useEffect(() => {
    // 用 getConfig 触发后端返回 yaml，间接拿到当前用的 config 路径
    // 实际上 daemon status 已含 config 路径，先用一个简单兜底
    api.getConfig().then((res) => {
      // getConfig 不返路径，但能确认 daemon 拿到了 config；显示固定提示
      setConfigPath("~/.autopilot/config.yaml");
    }).catch(() => {
      setConfigPath("~/.autopilot/config.yaml");
    });
  }, []);

  return (
    <div className="mx-auto w-full max-w-4xl px-5 py-6">
      <PageHero
        eyebrow="SHEET · SETTINGS · GLOBAL"
        title="通用设置"
        subtitle="常规偏好 · 高级 YAML"
        description="改后立即写入 AUTOPILOT_HOME/config.yaml；涉及 daemon 重启的项需自行重启。"
      />

      {/* 常规偏好 */}
      <Card className="mb-4 p-4">
        <div className="mb-3">
          <h3 className="text-sm font-semibold">常规偏好</h3>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            影响新建定时任务时的默认值；已创建的任务不受影响。
          </p>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
          <div className="space-y-1.5">
            <Label>默认时区</Label>
            {defaultsLoading ? (
              <p className="text-sm text-muted-foreground">加载中…</p>
            ) : (
              <TimezoneSelect
                value={defaultsTz}
                onChange={(tz) => {
                  setDefaultsTz(tz);
                  saveDefaults(tz);
                }}
                systemTz={systemTz}
                disabled={defaultsSaving}
              />
            )}
            <p className="text-[11px] text-muted-foreground">
              当前生效：
              <span className="font-mono">{defaultsTz || systemTz || "—"}</span>
              {!defaultsTz && systemTz && <span className="ml-1">（跟随系统）</span>}
            </p>
          </div>
        </div>
      </Card>

      {/* 桌面通知 */}
      <DesktopNotifyCard />


      {status && (
        <Card className="mb-4 p-4">
          <h3 className="mb-3 text-sm font-semibold">Daemon 信息</h3>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
            <InfoField label="版本" value={status.version} />
            <InfoField label="PID" value={String(status.pid)} mono />
            <InfoField label="运行时间" value={formatUptime(status.uptime)} />
            <InfoField label="端口" value={location.port || "80"} mono />
          </dl>
        </Card>
      )}

      <DaemonLogCard />

      {/* 编辑配置文件提示 */}
      <Card className="mb-4 p-4">
        <div className="mb-2">
          <h3 className="text-sm font-semibold">编辑配置文件</h3>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            日常配置请用上方的提供商 / 智能体 / 工作流 / 定时任务 Tab；
            原始 YAML 请用 IDE 直接编辑文件，daemon 即时读到改动（providers / agents 无需重启）。
          </p>
        </div>
        <dl className="grid grid-cols-1 gap-y-2 font-mono text-xs sm:grid-cols-[auto_1fr] sm:gap-x-4">
          <dt className="text-muted-foreground">全局配置</dt>
          <dd>{configPath ?? "~/.autopilot/config.yaml"}</dd>
          <dt className="text-muted-foreground">工作流目录</dt>
          <dd>~/.autopilot/workflows/&lt;name&gt;/workflow.yaml</dd>
          <dt className="text-muted-foreground">CLI 查看</dt>
          <dd>
            <code className="bg-muted/40 px-1.5 py-0.5">autopilot config path</code>
            <span className="mx-1 text-muted-foreground">·</span>
            <code className="bg-muted/40 px-1.5 py-0.5">autopilot config show</code>
          </dd>
          <dt className="text-muted-foreground">检查配置</dt>
          <dd>
            <code className="bg-muted/40 px-1.5 py-0.5">autopilot config doctor</code>
          </dd>
        </dl>
      </Card>
    </div>
  );
}

function InfoField({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex flex-col">
      <dt className="text-[11px] text-muted-foreground">{label}</dt>
      <dd className={cn("text-sm", mono && "font-mono")}>{value}</dd>
    </div>
  );
}

function DaemonLogCard(): React.ReactElement {
  const toast = useToast();
  const [content, setContent] = useState("");
  const [path, setPath] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");

  const refresh = async () => {
    setLoading(true);
    try {
      const res = await api.getDaemonLog(1000);
      setContent(res.content);
      setPath(res.path);
    } catch (e: any) {
      toast.error("加载 daemon 日志失败", e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { refresh(); /* eslint-disable-line */ }, []);

  const filtered = useMemo(() => {
    if (!content) return [];
    const lines = content.split("\n");
    const q = query.trim().toLowerCase();
    const matched = q ? lines.filter((l) => l.toLowerCase().includes(q)) : lines;
    // 时间倒序：新日志在顶部
    return matched.slice().reverse();
  }, [content, query]);

  const extractLevel = (line: string): string | null => {
    const m = line.match(/\s\[(INFO|WARN|ERROR|DEBUG)\]\s/);
    return m?.[1] ?? null;
  };

  const levelClass = (lvl: string | null) => {
    switch (lvl) {
      case "ERROR": return "text-destructive";
      case "WARN": return "text-warning";
      case "DEBUG": return "text-muted-foreground";
      default: return "text-foreground";
    }
  };

  return (
    <Card className="mb-4 p-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Daemon 日志</h3>
        <Button variant="secondary" size="sm" onClick={refresh} disabled={loading}>
          <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
          刷新
        </Button>
      </div>

      {path ? (
        <p className="mb-2 text-[11px] text-muted-foreground">
          位置：<code className="rounded bg-muted px-1 py-0.5 font-mono">{path}</code>
          <span className="ml-1">（最后 1000 行，时间倒序 · 新在顶）</span>
        </p>
      ) : (
        <p className="mb-2 text-xs text-muted-foreground">daemon 日志未激活或路径未知。</p>
      )}

      <div className="relative mb-2">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="search"
          placeholder="搜索日志…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="pl-8"
        />
      </div>

      {loading && !content ? (
        <p className="text-sm text-muted-foreground">加载中…</p>
      ) : filtered.length === 0 ? (
        <p className="rounded-none border bg-muted/40 px-3 py-4 text-xs text-muted-foreground">
          {content ? "（当前过滤下无匹配）" : "（空）"}
        </p>
      ) : (
        <pre className="scrollbar-thin max-h-[400px] overflow-auto rounded-none border bg-muted/40 p-3 font-mono text-[11px] leading-relaxed">
          {filtered.map((line, i) => {
            const lvl = extractLevel(line);
            return (
              <div key={i} className={cn("whitespace-pre", levelClass(lvl))}>{line}</div>
            );
          })}
        </pre>
      )}
    </Card>
  );
}

function formatUptime(s: number): string {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

/**
 * 桌面通知开关卡。
 * - 检测 Notification.permission 状态（granted / denied / default）
 * - default 时按钮可点击触发 requestPermission()
 * - denied 时提示用户去浏览器设置改
 * - granted 时显示"已启用"
 */
function DesktopNotifyCard(): React.ReactElement {
  const toast = useToast();
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">(
    typeof Notification !== "undefined" ? Notification.permission : "unsupported",
  );

  async function enable() {
    if (typeof Notification === "undefined") return;
    try {
      const result = await Notification.requestPermission();
      setPermission(result);
      if (result === "granted") toast.success("桌面通知已启用");
      else if (result === "denied") toast.error("桌面通知被拒绝", "请在浏览器地址栏权限设置中放行");
    } catch (e: unknown) {
      toast.error("启用失败", (e as Error)?.message ?? String(e));
    }
  }

  return (
    <Card className="mb-4 p-4">
      <div className="mb-3">
        <h3 className="text-sm font-semibold">桌面通知</h3>
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          tab 切到后台时，有新的"待你处理"事项弹桌面通知。仅本机生效。
        </p>
      </div>
      {permission === "unsupported" && (
        <p className="text-sm text-muted-foreground">当前浏览器不支持桌面通知。</p>
      )}
      {permission === "granted" && (
        <p className="font-mono text-xs uppercase tracking-[0.12em] text-success">✓ 已启用</p>
      )}
      {permission === "denied" && (
        <p className="text-sm text-muted-foreground">
          通知已被浏览器拒绝。请在地址栏权限设置中放行，再刷新页面。
        </p>
      )}
      {permission === "default" && (
        <Button size="sm" onClick={enable} className="rounded-none font-mono text-[11px] uppercase tracking-[0.12em]">
          启用桌面通知
        </Button>
      )}
    </Card>
  );
}

