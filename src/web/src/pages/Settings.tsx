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
import { PageHero } from "@/components/PageHero";
import { TimezoneSelect } from "@/components/TimezoneSelect";
import { getApiToken, setApiToken, clearApiToken, shouldUseToken } from "@/lib/api-token";
import { setRestarting } from "@/lib/ws-singleton";

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
      .catch((e) => toast.error("加载默认偏好失败", (e as Error)?.message ?? String(e)))
      .finally(() => setDefaultsLoading(false));
  }, []);

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

      {/* 网络访问（含 API token + 本浏览器 token 副本） */}
      <NetworkAccessCard />

      {status && (
        <Card className="mb-4 p-4">
          <h3 className="mb-3 text-sm font-semibold">Daemon 信息</h3>
          <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2 md:grid-cols-4">
            <InfoField
              label="版本"
              value={status.git_sha ? `${status.version} · ${status.git_sha}` : status.version}
              mono
            />
            <InfoField label="PID" value={String(status.pid)} mono />
            <InfoField
              label="启动于"
              value={status.started_at_iso ? new Date(status.started_at_iso).toLocaleString() : formatUptime(status.uptime)}
            />
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
  // 「扫码上 token」Dialog 状态 + 渲染好的 dataURL
  const [showQrCode, setShowQrCode] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [qrTargetUrl, setQrTargetUrl] = useState<string>("");
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

  // 「扫码上 token」对话框：打开时拉明文 token + 拼 url + 生成 qrcode
  useEffect(() => {
    if (!showQrCode || !info) return;
    let cancelled = false;
    (async () => {
      try {
        const { token } = await api.revealApiToken();
        if (cancelled || !token) return;
        const ip = info.lan_ips[0];
        if (!ip) {
          toast.error("没有可用的局域网 IP");
          setShowQrCode(false);
          return;
        }
        const target = `http://${ip}:${info.port}/?token=${encodeURIComponent(token)}`;
        const QRCode = (await import("qrcode")).default;
        const dataUrl = await QRCode.toDataURL(target, { width: 240, margin: 1 });
        if (cancelled) return;
        setQrTargetUrl(target);
        setQrDataUrl(dataUrl);
      } catch (e: unknown) {
        if (!cancelled) {
          toast.error("生成二维码失败", (e as Error)?.message ?? String(e));
          setShowQrCode(false);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [showQrCode, info, toast]);

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
      // 重启前先记下旧 git_sha，重启完拿新 sha 对比展示「代码切换」可视化
      let prevSha: string | undefined;
      try { prevSha = (await api.getStatus()).git_sha; } catch { /* 容错 */ }
      try {
        await api.restartDaemon();
      } catch (e: unknown) {
        // restart 调用本身失败（如 daemon 已退出未起完）— 提示手动 restart 兜底
        toast.error("自动重启失败，请手动执行 `autopilot daemon restart`", (e as Error)?.message ?? String(e));
        await refresh();
        return res;
      }
      // restart RPC 已发出，daemon 150ms 后 exit。锁定 WS RPC 防用户在重启
      // 窗口期发出的 mutation 卡 5s 才反馈。轮询 getDaemonListen 走 HTTP 不
      // 受此锁影响。
      setRestarting(true);
      // 轮询 getDaemonListen 等 WS 重连 + 新 daemon 起来；超时回退到刷新页面
      const deadline = Date.now() + 15_000;
      let recovered = false;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 600));
        try {
          const fresh = await api.getDaemonListen();
          setInfo(fresh);
          setPortDraft(String(fresh.port));
          // 拿新 daemon 的 git_sha，跟旧 sha 对比给一个明确的「切换信号」
          let shaSuffix = "";
          try {
            const newStatus = await api.getStatus();
            const newSha = newStatus.git_sha;
            if (newSha && prevSha && newSha !== prevSha) {
              shaSuffix = ` · git ${prevSha} → ${newSha}`;
            } else if (newSha) {
              shaSuffix = ` · git ${newSha}`;
            }
          } catch { /* 容错：拿不到 sha 不影响主流程 */ }
          toast.success(`daemon 已重启，当前监听 ${fresh.host}:${fresh.port}${shaSuffix}`);
          if (next.host === "0.0.0.0" && fresh.lan_ips.length > 0) {
            toast.success(`局域网访问：${fresh.lan_ips.map((ip) => `http://${ip}:${fresh.port}`).join(" / ")}`);
          }
          recovered = true;
          break;
        } catch { /* 还在重启，继续等 */ }
      }
      if (!recovered) {
        toast.error("daemon 重启等待超时，刷新页面尝试…");
        setTimeout(() => location.reload(), 1000);
      }
      // 解锁 mutation：daemon 已稳定（或决定 reload 兜底）
      setRestarting(false);
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
      <div className="mb-3">
        <h3 className="text-sm font-semibold">网络访问</h3>
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          控制 daemon 监听范围。改后需在终端跑 <code className="bg-muted/40 px-1.5">autopilot daemon restart</code> 生效。
        </p>
      </div>

      {/* Toggle: 仅本机 / 局域网 */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-4 border border-foreground/15 bg-card px-3 py-2.5">
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium">
            {isExposed ? "局域网开放" : "仅本机访问"}
          </div>
          <div className="mt-0.5 text-[11px] text-muted-foreground">
            {isExposed
              ? `监听 ${info.host}:${info.port}，同网段的机器都能访问`
              : `监听 127.0.0.1:${info.port}，仅本机`}
          </div>
        </div>
        <Switch
          checked={isExposed}
          onCheckedChange={handleToggleExposed}
          disabled={saving}
        />
      </div>

      {/* Port + LAN IP */}
      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-[8rem_1fr] sm:items-end">
        <div className="space-y-1.5">
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
        {isExposed && info.lan_ips.length > 0 && (
          <div className="space-y-1">
            <Label className="text-[11px] text-muted-foreground">同网段访问地址</Label>
            <div className="flex flex-wrap items-center gap-2">
              {info.lan_ips.map((ip) => (
                <code
                  key={ip}
                  className="border border-foreground/20 bg-muted/40 px-1.5 py-0.5 font-mono text-xs"
                >
                  http://{ip}:{info.port}
                </code>
              ))}
              {info.token.is_set && (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-[11px]"
                  onClick={() => setShowQrCode(true)}
                  title="本机生成二维码，手机扫一下自动落 token + reload"
                >
                  扫码上 token
                </Button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Token 区：服务端 token + 本浏览器副本 */}
      <div className="border border-foreground/15 bg-card px-3 py-2.5">
        <div className="mb-2 flex items-center justify-between">
          <div className="text-sm font-medium">API 安全令牌</div>
          {tokenLocked && (
            <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
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
              {!tokenLocked && <div>仅本机来源免 token，外部访问必须带</div>}
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
          <div className="mt-3 border-t border-dashed border-foreground/15 pt-3">
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

        <p className="mt-2 text-[10px] text-muted-foreground">
          注：MCP <code className="font-mono">/mcp</code> 路由走独立 token（mcp-config 管理），不受此控制
        </p>
      </div>

      {/* 弹：切局域网前强制生成 token */}
      <Dialog open={pendingExpose} onOpenChange={(open) => !open && setPendingExpose(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              <span className="inline-flex flex-col leading-tight">
                <span>开启局域网访问</span>
                <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                  expose to 0.0.0.0
                </span>
              </span>
            </DialogTitle>
            <DialogDescription>
              对外暴露前必须先设置 API 安全令牌。生成后会立即切到"局域网开放"。
            </DialogDescription>
          </DialogHeader>
          <div className="border-l-[2px] border-warning bg-warning/5 px-3 py-2 text-xs text-muted-foreground">
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
                <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
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
              <code className="block break-all border border-foreground/30 bg-muted/40 p-2 font-mono text-xs">
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

      {/* 扫码上 token：手机/平板首次访问，扫一下省去手贴 */}
      <Dialog
        open={showQrCode}
        onOpenChange={(open) => {
          if (!open) {
            setShowQrCode(false);
            setQrDataUrl(null);
            setQrTargetUrl("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>扫码上 token</DialogTitle>
            <DialogDescription>
              在手机/平板上扫这个码：自动落 token 到该设备的浏览器 localStorage，然后跳进 web 主页。
              每台设备各扫一次。
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col items-center gap-3 py-2">
            {qrDataUrl ? (
              <img src={qrDataUrl} alt="qrcode" className="border-[1.5px] border-foreground/20 bg-white p-2" />
            ) : (
              <div className="flex h-[240px] w-[240px] items-center justify-center text-xs text-muted-foreground">
                生成中…
              </div>
            )}
            {qrTargetUrl && (
              <code className="break-all border border-foreground/15 bg-muted/40 px-2 py-1 font-mono text-[10px]">
                {qrTargetUrl}
              </code>
            )}
            <p className="text-[11px] text-muted-foreground leading-relaxed">
              ⚠ 二维码内含明文 token，请只在可信局域网展示，扫完关闭。
            </p>
          </div>
        </DialogContent>
      </Dialog>
    </Card>
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

