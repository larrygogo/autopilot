import React, { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw, Search, ExternalLink, AlertTriangle, Copy, RotateCw, Trash2 } from "lucide-react";
import { api, type DaemonListenInfo } from "@/hooks/useApi";
import { useToast } from "@/components/Toast";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ConfirmDialog } from "@/components/Modal";
import { cn } from "@/lib/utils";
import { TimezoneSelect } from "@/components/TimezoneSelect";
import { getApiToken, setApiToken, clearApiToken, shouldUseToken } from "@/lib/api-token";
import { getDesktopNotifyEnabled, setDesktopNotifyEnabled } from "@/lib/desktop-notify-pref";
import { setRestarting } from "@/lib/ws-singleton";
import { restartDaemonAndWait } from "@/lib/restart-daemon";
import { LifecycleAgentsCard } from "@/components/LifecycleAgentsCard";

// 保留 embedded 参数签名以兼容旧调用
export function Settings({
  section = "general",
}: {
  section?: "general" | "lifecycle" | "scheduler" | "network" | "extensions" | "daemon";
}) {
  const toast = useToast();

  const [defaultsTz, setDefaultsTz] = useState<string | null>(null);
  const [systemTz, setSystemTz] = useState<string>("");
  const [defaultsLoading, setDefaultsLoading] = useState(true);
  const [defaultsSaving, setDefaultsSaving] = useState(false);

  const [status, setStatus] = useState<any>(null);
  const [extensions, setExtensions] = useState<Array<{ id: string; enabled: boolean; running: boolean; status: Record<string, unknown> | null }>>([]);
  const [confirmRestart, setConfirmRestart] = useState(false);
  const [restartingDaemon, setRestartingDaemon] = useState(false);

  const handleRestartDaemon = async () => {
    setConfirmRestart(false);
    setRestartingDaemon(true);
    try {
      await restartDaemonAndWait(toast);
      // 重启完拉新 status 刷新「Daemon 信息」卡（版本 / PID / 启动时间）
      try { setStatus(await api.getStatus()); } catch { /* 容错 */ }
    } finally {
      setRestartingDaemon(false);
    }
  };

  useEffect(() => {
    if (section !== "general") return;
    api.getDefaults()
      .then((res) => {
        setDefaultsTz(res.timezone);
        setSystemTz(res.system_timezone);
      })
      .catch((e) => toast.error("加载默认偏好失败", (e as Error)?.message ?? String(e)))
      .finally(() => setDefaultsLoading(false));
  }, [section]);

  const saveDefaults = async (tz: string | null) => {
    setDefaultsSaving(true);
    try {
      const res = await api.saveDefaults({ timezone: tz });
      setDefaultsTz(res.timezone);
      toast.success("默认偏好已保存");
    } catch (e: unknown) {
      toast.error("保存失败", (e as Error)?.message ?? String(e));
    } finally {
      setDefaultsSaving(false);
    }
  };

  useEffect(() => {
    if (section === "daemon") {
      api.getStatus().then(setStatus).catch(() => {});
    }
    if (section === "extensions") {
      api.listExtensions().then((r) => setExtensions(r.extensions ?? [])).catch(() => {});
    }
  }, [section]);


  if (section === "lifecycle") {
    return <LifecycleAgentsCard />;
  }

  if (section === "scheduler") {
    return <SchedulerCard />;
  }

  if (section === "network") {
    return <NetworkAccessCard />;
  }

  if (section === "extensions") {
    // 扩展分区：daemon 级扩展及其自报状态（如 reqgenie 连接器的注册/心跳）——
    // 内容 KV 由扩展 status() 自报，此处通用渲染、不含业务知识
    return (
      <div className="w-full">
        {extensions.length === 0 ? (
          <Card className="p-6 text-center text-sm text-muted-foreground">
            没有已注册的 daemon 扩展。
          </Card>
        ) : (
          <Card className="p-4">
            <div className="space-y-4">
              {extensions.map((ext) => (
                <div key={ext.id}>
                  <div className="mb-2 flex items-center gap-2">
                    <span className="font-mono text-xs text-foreground/85">{ext.id}</span>
                    <span className={cn(
                      "rounded-full px-2 py-0.5 text-[10px]",
                      ext.running ? "bg-success/15 text-success" : ext.enabled ? "bg-warning/15 text-warning" : "bg-muted text-muted-foreground",
                    )}>
                      {ext.running ? "运行中" : ext.enabled ? "已启用（未运行）" : "未启用"}
                    </span>
                  </div>
                  {ext.status && (
                    <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
                      {Object.entries(ext.status).map(([k, v]) => (
                        <InfoField key={k} label={k} value={String(v)} mono={k === "实例ID" || k === "控制面"} />
                      ))}
                    </dl>
                  )}
                  {/* 未注册的 reqgenie 连接器 → 内联注册表单（对等 CLI selfhosted register，注册后热启动） */}
                  {ext.id === "reqgenie-connector" && ext.status?.["注册状态"] === "未注册" && (
                    <ReqgenieRegisterForm
                      onDone={() => api.listExtensions().then((r) => setExtensions(r.extensions ?? [])).catch(() => {})}
                    />
                  )}
                  {/* 已注册 → 解除注册（停连接器 + 通知 reqgenie 下线 + 清凭证，对等 CLI selfhosted remove） */}
                  {ext.id === "reqgenie-connector" && ext.status && ext.status["注册状态"] !== "未注册" && (
                    <ReqgenieUnregisterButton
                      onDone={() => api.listExtensions().then((r) => setExtensions(r.extensions ?? [])).catch(() => {})}
                    />
                  )}
                </div>
              ))}
            </div>
          </Card>
        )}
      </div>
    );
  }

  if (section === "daemon") {
    return (
      <div className="w-full">
        {status && (
          <Card className="mb-4 p-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <h3 className="text-sm font-semibold">Daemon 信息</h3>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setConfirmRestart(true)}
                disabled={restartingDaemon}
                title="重启 daemon（应用磁盘上已有的最新代码 / 配置；升级代码需先在终端 git pull）"
              >
                <RotateCw className={cn("h-4 w-4", restartingDaemon && "animate-spin")} />
                {restartingDaemon ? "重启中…" : "重启 daemon"}
              </Button>
            </div>
            <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
              <InfoField label="版本" value={status.version} mono />
              <InfoField
                label="启动于"
                value={status.started_at_iso ? new Date(status.started_at_iso).toLocaleString() : formatUptime(status.uptime)}
              />
              {status.supervisor?.running && (
                <>
                  <InfoField
                    label="Supervisor"
                    value={`崩溃重启 ${status.supervisor.restarts} 次${status.supervisor.crash_loop ? " · 崩溃循环" : ""}`}
                  />
                  {status.supervisor.last_crash_at && (
                    <InfoField
                      label="上次崩溃"
                      value={`${new Date(status.supervisor.last_crash_at).toLocaleString()}（code=${status.supervisor.last_exit_code ?? "?"}）`}
                    />
                  )}
                </>
              )}
            </dl>
            {status.supervisor?.crash_loop && (
              <div className="mt-3 rounded-md bg-destructive/10 px-3 py-2 text-[11px] text-destructive">
                runner 反复崩溃：daemon 已被 supervisor 重启 {status.supervisor.restarts} 次并进入快速崩溃循环。请查 daemon 日志排因（终端 <code className="rounded bg-destructive/15 px-1 py-0.5 font-mono">autopilot daemon logs</code>）。
              </div>
            )}
            {status.update?.status === "behind" && (
              <div className="mt-3 rounded-md bg-warning/10 px-3 py-2 text-[11px] text-warning">
                有更新可用：本地代码落后远端。在项目目录跑 <code className="rounded bg-warning/15 px-1 py-0.5 font-mono">git pull</code>（必要时 <code className="rounded bg-warning/15 px-1 py-0.5 font-mono">bun run build:web</code>）后再重启 daemon。
              </div>
            )}
          </Card>
        )}

        <ConfirmDialog
          open={confirmRestart}
          title="重启 daemon"
          message={
            <div className="space-y-2 text-sm">
              <p>现在重启 daemon。</p>
              <p className="text-muted-foreground">
                重启只会应用本地磁盘上已有的代码——要升级到新版本，得先在终端 <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">git pull</code>（必要时 <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">bun run build:web</code>）再重启。
                正在跑的任务不受影响，但这个页面会断开一两秒再自动连上。
                如果 daemon 不是托管启动的，重启会变成停止，需要你手动再启动一次。
              </p>
            </div>
          }
          confirmText="重启"
          onConfirm={handleRestartDaemon}
          onCancel={() => setConfirmRestart(false)}
        />

        <DaemonLogCard />
      </div>
    );
  }

  // general：常规偏好 + 桌面通知
  return (
    <div className="w-full">
      {/* 常规偏好 */}
      <Card className="mb-4 p-4">
        <div className="mb-3">
          <h3 className="text-sm font-semibold">常规偏好</h3>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            新建定时任务时的默认值，已有的任务不变。
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
          </div>
        </div>
      </Card>

      {/* 桌面通知 */}
      <DesktopNotifyCard />
    </div>
  );
}

// ──────────────────────────────────────────────
// 任务调度设置
//   - 全局最大并发任务数（scheduler.max_concurrent_tasks，默认 1）
//   - 写入 config.json 后即热生效（调度器每次 tick 现读，无需重启）
// ──────────────────────────────────────────────
function SchedulerCard(): React.ReactElement {
  const toast = useToast();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [effective, setEffective] = useState<number>(1);
  const [configured, setConfigured] = useState<number | null>(null);
  const [draft, setDraft] = useState<string>("");

  useEffect(() => {
    api.getSchedulerConfig()
      .then((res) => {
        setConfigured(res.max_concurrent_tasks);
        setEffective(res.effective_max_concurrent_tasks);
        setDraft(String(res.effective_max_concurrent_tasks));
      })
      .catch((e) => toast.error("加载调度配置失败", (e as Error)?.message ?? String(e)))
      .finally(() => setLoading(false));
  }, []);

  const handleBlur = async () => {
    const n = parseInt(draft, 10);
    if (!Number.isInteger(n) || n < 1 || String(n) !== draft.trim()) {
      toast.error("并发数无效", "请填 ≥1 的整数");
      setDraft(String(effective));
      return;
    }
    if (n === effective) return;
    setSaving(true);
    try {
      const res = await api.saveSchedulerConfig({ max_concurrent_tasks: n });
      setConfigured(res.max_concurrent_tasks);
      setEffective(res.effective_max_concurrent_tasks);
      setDraft(String(res.effective_max_concurrent_tasks));
      toast.success(`最大并发任务数已设为 ${res.effective_max_concurrent_tasks}，即时生效`);
    } catch (e: unknown) {
      toast.error("保存失败", (e as Error)?.message ?? String(e));
      setDraft(String(effective));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="mb-4 p-4">
      <p className="mb-3 text-[11px] text-muted-foreground">
        最多允许多少个任务同时跑（所有代码库合计）。改完马上生效。
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[10rem_1fr] sm:items-end">
        <div className="space-y-1.5">
          <Label>最大并发任务数</Label>
          {loading ? (
            <p className="text-sm text-muted-foreground">加载中…</p>
          ) : (
            <Input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={handleBlur}
              inputMode="numeric"
              className="font-mono"
              disabled={saving}
            />
          )}
        </div>
        <p className="text-[11px] text-muted-foreground">
          对应 <code className="font-mono bg-muted/40 px-1.5 py-0.5">scheduler.max_concurrent_tasks</code>
          {configured === null && !loading && <span className="ml-1">（没设置时默认 1）</span>}
        </p>
      </div>
    </Card>
  );
}

// ──────────────────────────────────────────────
// 网络访问设置
//   - Toggle: 仅本机 (127.0.0.1) / 局域网开放 (0.0.0.0)
//   - 端口可改
//   - 切局域网前强制生成 API token —— 否则同网段裸奔
//   - host/port/token 都需 daemon restart 才生效（启动时读 config 一次）
// ──────────────────────────────────────────────
function NetworkAccessCard(): React.ReactElement {
  const toast = useToast();
  const [info, setInfo] = useState<DaemonListenInfo | null>(null);
  const [portDraft, setPortDraft] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [showNewToken, setShowNewToken] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // 切到局域网时如果还没 token，先弹这个 dialog 强制生成
  const [pendingExpose, setPendingExpose] = useState(false);
  // 点「显示明文」后从 daemon.revealToken 拿到的真实 token，再点收起
  const [revealedToken, setRevealedToken] = useState<string | null>(null);
  // 本浏览器 localStorage 里给局域网访问用的 token 副本
  const [clientStored, setClientStored] = useState<string>(() => getApiToken());
  const [clientDraft, setClientDraft] = useState<string>("");
  const isLanBrowser = shouldUseToken();

  const refresh = useCallback(async () => {
    try {
      const res = await api.getDaemonListen();
      setInfo(res);
      setPortDraft(String(res.port));
    } catch (e: unknown) {
      toast.error("加载网络配置失败", (e as Error)?.message ?? String(e));
    }
  }, [toast]);

  useEffect(() => { refresh(); }, [refresh]);

  if (!info) {
    return (
      <Card className="mb-4 p-4">
        <div className="text-sm text-muted-foreground">加载网络配置中…</div>
      </Card>
    );
  }

  const isExposed = info.host !== "127.0.0.1" && info.host !== "localhost";
  const tokenLocked = info.token.source === "env";

  const persistListen = async (next: { host?: string; port?: number }) => {
    setSaving(true);
    try {
      const res = await api.saveDaemonListen(next);
      // 切回 127 时如果当前从局域网 IP 访问，restart 后此页面会失联
      // 给用户机会取消（如果坚持切就走 reload 兜底）
      if (
        next.host === "127.0.0.1" &&
        location.hostname !== "127.0.0.1" &&
        location.hostname !== "localhost"
      ) {
        if (!confirm(
          `你当前从 ${location.hostname} 访问。daemon 切回 127.0.0.1 后此页面将无法继续使用，` +
          `需要改在装 daemon 的本机用 127.0.0.1 打开。\n\n仍要继续吗？`,
        )) {
          await refresh();
          return null;
        }
      }
      toast.success("已保存，正在重启 daemon…");
      const fresh = await restartDaemonAndWait(toast);
      if (fresh) {
        setInfo(fresh);
        setPortDraft(String(fresh.port));
        if (next.host === "0.0.0.0" && fresh.lan_ips.length > 0) {
          toast.success(`局域网访问：${fresh.lan_ips.map((ip) => `http://${ip}:${fresh.port}`).join(" / ")}`);
        }
      }
      return res;
    } catch (e: unknown) {
      toast.error("保存失败", (e as Error)?.message ?? String(e));
      await refresh();  // 回滚 UI 到服务端状态
      return null;
    } finally {
      // 防御性：意外 throw 路径也要解锁，避免 mutation 永久卡死
      setRestarting(false);
      setSaving(false);
    }
  };

  const handleToggleExposed = async (checked: boolean) => {
    if (checked) {
      // 切到局域网：必须先有 token
      if (!info.token.is_set) {
        setPendingExpose(true);
        return;
      }
      await persistListen({ host: "0.0.0.0" });
    } else {
      await persistListen({ host: "127.0.0.1" });
    }
  };

  const handleRotateToken = async () => {
    if (tokenLocked) {
      toast.error("无法修改", "Token 来自环境变量 AUTOPILOT_API_TOKEN");
      return;
    }
    try {
      const res = await api.rotateApiToken();
      setShowNewToken(res.token);
      await refresh();
    } catch (e: unknown) {
      toast.error("生成 token 失败", (e as Error)?.message ?? String(e));
    }
  };

  // 局域网开关被拦截后，从对话框生成 token 并继续切换
  const handleGenerateAndExpose = async () => {
    try {
      const res = await api.rotateApiToken();
      setShowNewToken(res.token);
      setPendingExpose(false);
      // 生成成功后真正切到局域网
      await persistListen({ host: "0.0.0.0" });
    } catch (e: unknown) {
      toast.error("生成 token 失败", (e as Error)?.message ?? String(e));
      setPendingExpose(false);
    }
  };

  const handleDeleteToken = async () => {
    if (tokenLocked) {
      toast.error("无法删除", "Token 来自环境变量 AUTOPILOT_API_TOKEN");
      return;
    }
    try {
      await api.deleteApiToken();
      toast.success("Token 已删除");
      await refresh();
    } catch (e: unknown) {
      toast.error("删除失败", (e as Error)?.message ?? String(e));
    } finally {
      setConfirmDelete(false);
    }
  };

  const handlePortBlur = async () => {
    const n = parseInt(portDraft, 10);
    if (!Number.isInteger(n) || n <= 0 || n >= 65536) {
      toast.error("端口无效", "请填 1~65535 的整数");
      setPortDraft(String(info.port));
      return;
    }
    if (n === info.port) return;
    await persistListen({ port: n });
  };

  const copyToken = async (token: string) => {
    try {
      await navigator.clipboard.writeText(token);
      toast.success("已复制到剪贴板");
    } catch {
      toast.error("复制失败", "请手动选中复制");
    }
  };

  return (
    <Card className="mb-4 p-4">
      {/* Toggle: 仅本机 / 局域网 */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-4 rounded-md border border-border bg-card px-3 py-2.5">
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium">
            {isExposed ? "局域网开放" : "仅本机访问"}
          </div>
          <div className="mt-0.5 text-[11px] text-muted-foreground">
            {isExposed
              ? `同一网络里的机器都能打开（${info.host}:${info.port}）`
              : `只有这台机器能打开（127.0.0.1:${info.port}）`}
          </div>
        </div>
        <Switch
          checked={isExposed}
          onCheckedChange={handleToggleExposed}
          disabled={saving}
        />
      </div>

      {/* Port */}
      <div className="mb-4 max-w-[8rem] space-y-1.5">
        <Label>端口</Label>
        <Input
          value={portDraft}
          onChange={(e) => setPortDraft(e.target.value)}
          onBlur={handlePortBlur}
          inputMode="numeric"
          className="font-mono"
          disabled={saving}
        />
      </div>

      {/* Token 区：服务端 token + 本浏览器副本 */}
      <div className="rounded-md border border-border bg-card px-3 py-2.5">
        <div className="mb-2 flex items-center justify-between">
          <div className="text-sm font-medium">API 安全令牌</div>
          {tokenLocked && (
            <span className="font-mono text-[10px] text-muted-foreground">
              来自环境变量
            </span>
          )}
        </div>
        <div className="mb-2 text-[11px] text-muted-foreground">
          {info.token.is_set ? (
            <div className="space-y-1.5">
              <div className="flex flex-wrap items-center gap-2">
                <span>已设置：</span>
                <code className="font-mono bg-muted/40 px-1.5 py-0.5">
                  {revealedToken ?? info.token.preview}
                </code>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-6 px-2 text-[10px]"
                  onClick={async () => {
                    if (revealedToken) { setRevealedToken(null); return; }
                    try {
                      const res = await api.revealApiToken();
                      setRevealedToken(res.token);
                    } catch (e: unknown) {
                      toast.error("拿明文 token 失败", (e as Error)?.message ?? String(e));
                    }
                  }}
                >
                  {revealedToken ? "隐藏" : "显示明文"}
                </Button>
                {revealedToken && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-6 px-2 text-[10px]"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(revealedToken);
                        toast.success("已复制 token 到剪贴板");
                      } catch {
                        toast.error("复制失败", "请手动选中复制");
                      }
                    }}
                  >
                    <Copy className="h-3 w-3" />
                    复制
                  </Button>
                )}
              </div>
              {!tokenLocked && <div>本机访问免令牌，外部机器访问必须带上</div>}
            </div>
          ) : (
            <span className="text-warning">未设置。切到"局域网开放"时必须设置，否则同网段任何人都能访问 daemon。</span>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="secondary"
            onClick={handleRotateToken}
            disabled={tokenLocked || saving}
            title={tokenLocked ? "Token 来自环境变量，请改 AUTOPILOT_API_TOKEN" : undefined}
          >
            <RotateCw className="h-3.5 w-3.5" />
            {info.token.is_set ? "重置令牌" : "生成令牌"}
          </Button>
          {info.token.is_set && !tokenLocked && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setConfirmDelete(true)}
              disabled={saving || isExposed}
              title={isExposed ? "局域网模式下不能删除 token；请先切回仅本机" : undefined}
            >
              <Trash2 className="h-3.5 w-3.5" />
              删除令牌
            </Button>
          )}
        </div>

        {/* 本浏览器 token 副本 —— 仅从局域网 IP 访问时显示。本机回环 daemon 自动豁免，无需配 */}
        {isLanBrowser && (
          <div className="mt-3 border-t border-border pt-3">
            <div className="mb-1 text-xs font-medium">本浏览器副本</div>
            <p className="mb-2 text-[11px] text-muted-foreground">
              你从局域网 <code className="font-mono">{location.host}</code> 访问 daemon，
              请把上方明文 token 贴入此处保存到本浏览器 localStorage。每台设备各自配。
            </p>
            <dl className="mb-2 grid grid-cols-2 gap-x-6 gap-y-1 text-xs">
              <InfoField
                label="已存 token"
                value={
                  clientStored
                    ? clientStored.length > 8 ? `${clientStored.slice(0, 4)}…${clientStored.slice(-4)}` : "********"
                    : "未设置"
                }
                mono
              />
            </dl>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                type="password"
                value={clientDraft}
                onChange={(e) => setClientDraft(e.target.value)}
                placeholder={clientStored ? "贴入新 token 覆盖" : "贴入 token"}
                className="max-w-md font-mono h-8 text-xs"
              />
              <Button
                size="sm"
                disabled={!clientDraft.trim()}
                onClick={() => {
                  const t = clientDraft.trim();
                  setApiToken(t);
                  setClientStored(t);
                  setClientDraft("");
                  toast.success("已保存，正在刷新页面…");
                  setTimeout(() => location.reload(), 500);
                }}
              >
                保存
              </Button>
              {clientStored && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    clearApiToken();
                    setClientStored("");
                    toast.success("已清除");
                    setTimeout(() => location.reload(), 500);
                  }}
                >
                  清除
                </Button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* 弹：切局域网前强制生成 token */}
      <Dialog open={pendingExpose} onOpenChange={(open) => !open && setPendingExpose(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              <span className="inline-flex flex-col leading-tight">
                <span>开启局域网访问</span>
                <span className="font-mono text-[10px] text-muted-foreground">
                  expose to 0.0.0.0
                </span>
              </span>
            </DialogTitle>
            <DialogDescription>
              对外暴露前必须先设置 API 安全令牌。生成后会立即切到"局域网开放"。
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-md bg-warning/5 px-3 py-2 text-xs text-muted-foreground">
            <AlertTriangle className="mb-1 inline h-3.5 w-3.5 text-warning" />{" "}
            同网段的所有人将能尝试访问你的 daemon。本机浏览器和 CLI 不需要令牌；
            其他机器访问时必须在 <code className="font-mono">Authorization: Bearer</code> 头里带令牌。
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingExpose(false)}>取消</Button>
            <Button onClick={handleGenerateAndExpose}>生成令牌并开启</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 弹：显示新 token */}
      <Dialog open={showNewToken !== null} onOpenChange={(open) => !open && setShowNewToken(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              <span className="inline-flex flex-col leading-tight">
                <span>令牌已生成</span>
                <span className="font-mono text-[10px] text-muted-foreground">
                  api token rotated
                </span>
              </span>
            </DialogTitle>
            <DialogDescription>
              这是新令牌的完整明文，仅此一次显示。请复制保存到密码管理器，关闭后无法再看到完整值。
            </DialogDescription>
          </DialogHeader>
          {showNewToken && (
            <div className="space-y-2">
              <code className="block break-all rounded-md border border-border bg-muted/40 p-2 font-mono text-xs">
                {showNewToken}
              </code>
              <Button size="sm" variant="secondary" onClick={() => copyToken(showNewToken)}>
                <Copy className="h-3.5 w-3.5" />
                复制
              </Button>
              <p className="text-[11px] text-muted-foreground">
                外部机器访问时把它放在 HTTP 头：<br />
                <code className="font-mono">Authorization: Bearer {`<token>`}</code>
              </p>
            </div>
          )}
          <DialogFooter>
            <Button onClick={() => setShowNewToken(null)}>我已保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirmDelete}
        title="删除 API 令牌"
        message={`删除后 daemon 将无任何鉴权。仅当 daemon 处于「仅本机」模式时才允许删除。是否继续？`}
        confirmText="删除"
        danger
        onConfirm={handleDeleteToken}
        onCancel={() => setConfirmDelete(false)}
      />
    </Card>
  );
}

/** reqgenie 连接器注册表单：控制面 URL + 实例名 + 一次性注册令牌 → extensions.invoke("register")。 */
function ReqgenieRegisterForm({ onDone }: { onDone: () => void }) {
  const toast = useToast();
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      await api.invokeExtension("reqgenie-connector", "register", {
        control_plane_url: url.trim(),
        name: name.trim(),
        token: token.trim(),
      });
      toast.success("注册成功，连接器已启动");
      setToken("");
      onDone();
    } catch (e: unknown) {
      toast.error("注册失败", (e as Error)?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-3 space-y-3 rounded-lg border border-border bg-muted/30 p-3">
      <p className="text-xs text-muted-foreground">
        注册为 reqgenie 自托管实例：在 reqgenie「我的 Runner」生成一次性注册令牌后填入。注册成功即热启动连接器，无需重启 daemon。
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="rg-url" className="text-xs">控制面 URL</Label>
          <Input id="rg-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://reqgenie 地址:3001" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="rg-name" className="text-xs">实例展示名（可选）</Label>
          <Input id="rg-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="默认取主机名" />
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="rg-token" className="text-xs">注册令牌</Label>
        <Input id="rg-token" type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="reqgenie 生成的一次性令牌" />
      </div>
      <Button size="sm" onClick={submit} disabled={busy || !url.trim() || !token.trim()}>
        {busy ? "注册中…" : "注册"}
      </Button>
    </div>
  );
}

/** reqgenie 连接器解除注册：停连接器（向 reqgenie 发下线）+ 清本机凭证 + 关 enabled。 */
function ReqgenieUnregisterButton({ onDone }: { onDone: () => void }) {
  const toast = useToast();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const doRemove = async () => {
    setBusy(true);
    try {
      await api.invokeExtension("reqgenie-connector", "remove", {});
      toast.success("已解除注册，连接器已停止");
      onDone();
    } catch (e: unknown) {
      toast.error("解除注册失败", (e as Error)?.message ?? String(e));
    } finally {
      setBusy(false);
      setConfirmOpen(false);
    }
  };

  return (
    <div className="mt-3">
      <Button variant="outline" size="sm" onClick={() => setConfirmOpen(true)} disabled={busy}>
        <Trash2 className="h-3.5 w-3.5" />
        {busy ? "解除中…" : "解除注册（下线）"}
      </Button>
      <ConfirmDialog
        open={confirmOpen}
        title="解除注册"
        message={
          <div className="space-y-2 text-sm">
            <p>停止连接器、通知 reqgenie 下线，并删除本机凭证。</p>
            <p className="text-muted-foreground">
              进行中的镜像同步会中断（reqgenie 侧该实例变为离线）；重新接活需在 reqgenie 生成新的注册令牌后再次注册。
            </p>
          </div>
        }
        confirmText="解除注册"
        onConfirm={doRemove}
        onCancel={() => setConfirmOpen(false)}
      />
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
    } catch (e: unknown) {
      toast.error("加载 daemon 日志失败", (e as Error)?.message ?? String(e));
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
          位置：<code className="rounded bg-muted px-1 py-0.5 font-mono break-all">{path}</code>
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
        <p className="rounded-md border bg-muted/40 px-3 py-4 text-xs text-muted-foreground">
          {content ? "（当前过滤下无匹配）" : "（空）"}
        </p>
      ) : (
        <pre className="scrollbar-thin max-h-[400px] overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-[11px] leading-relaxed">
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
 * - granted 态：Switch 控制应用层开关（localStorage），可随时关闭/重开
 * - default 态：Switch 拨到「开」触发 requestPermission()
 * - denied 态：Switch 显示但 disabled，引导用户去浏览器设置放行
 * - unsupported 态：无 Switch，仅提示不支持
 */
function DesktopNotifyCard(): React.ReactElement {
  const toast = useToast();
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">(
    typeof Notification !== "undefined" ? Notification.permission : "unsupported",
  );
  // 从 localStorage 初始化开关状态（无记录视为开）
  const [enabled, setEnabled] = useState<boolean>(() => getDesktopNotifyEnabled());

  const handleToggle = async (checked: boolean) => {
    if (permission === "default") {
      // 默认未授权：拨到「开」时先触发权限请求
      if (!checked) return; // default 态只能向「开」拨
      try {
        const result = await Notification.requestPermission();
        setPermission(result);
        if (result === "granted") {
          // 用户主动在 default 态拨开关表示「授权并启用」，强制写 true（覆盖旧偏好）
          setDesktopNotifyEnabled(true);
          setEnabled(true);
          toast.success("桌面通知已启用");
        } else if (result === "denied") {
          toast.error("桌面通知被拒绝", "请在浏览器地址栏权限设置中放行");
        } else {
          // 用户关闭了弹窗但未做选择，权限仍为 default
          toast.info("请在弹窗中点击「允许」以启用通知");
        }
      } catch (e: unknown) {
        toast.error("启用失败", (e as Error)?.message ?? String(e));
      }
      return;
    }
    // 非 granted 态不应走到这里（JSX 层已保证），防御性守卫
    if (permission !== "granted") return;
    // granted 态：直接写 localStorage
    setDesktopNotifyEnabled(checked);
    setEnabled(checked);
  };

  return (
    <Card className="mb-4 p-4">
      <div className="mb-3">
        <h3 className="text-sm font-semibold">桌面通知</h3>
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          切到别的标签页时，有需要你处理的事就弹个桌面通知。只在本机有效。
        </p>
      </div>

      {permission === "unsupported" && (
        <p className="text-sm text-muted-foreground">当前浏览器不支持桌面通知。</p>
      )}

      {permission === "denied" && (
        <div className="flex items-center justify-between gap-4">
          <p className="text-sm text-muted-foreground">
            通知已被浏览器拒绝。请在地址栏权限设置中放行，再刷新页面。
          </p>
          <Switch checked={false} disabled />
        </div>
      )}

      {(permission === "granted" || permission === "default") && (
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm">
              {permission === "granted"
                ? (enabled ? "已开启" : "已关闭")
                : "未授权"}
            </p>
            {permission === "default" && (
              <p className="text-[11px] text-muted-foreground mt-0.5">
                拨到「开」以授权并启用桌面通知
              </p>
            )}
          </div>
          <Switch
            checked={permission === "granted" ? enabled : false}
            onCheckedChange={handleToggle}
          />
        </div>
      )}
    </Card>
  );
}

