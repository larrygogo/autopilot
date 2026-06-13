import React, { useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Eye,
  EyeOff,
  Globe,
  HelpCircle,
  Plus,
  RefreshCw,
  Trash2,
  XCircle,
} from "lucide-react";
import {
  api,
  type ProviderItem,
  type ProviderStatus,
  type ProviderModelsResult,
  type ProviderExtendedInfo,
} from "@/hooks/useApi";
import { useToast } from "@/components/Toast";
import { PageShell } from "@/components/pro";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ConfirmDialog } from "@/components/Modal";
import { ModelCombobox } from "@/components/ModelCombobox";
import { cn } from "@/lib/utils";

const PROVIDER_META: Record<string, { defaultModel: string; loginCmd: string }> = {
  anthropic: { defaultModel: "claude-sonnet-4-6", loginCmd: "claude login" },
  openai: { defaultModel: "o4-mini", loginCmd: "codex login" },
  google: { defaultModel: "gemini-2.5-pro", loginCmd: "gemini auth login" },
};

const MODEL_LIST_PROVIDERS = ["anthropic", "openai", "google"] as const;

/**
 * 统一「提供商」设置页（2026-06-13 合并原「提供商」+「API 密钥」两个分区）。
 *
 * 一个 provider = 一张卡：CLI 模式块（仅 supports_cli）+ API 密钥块（supports_api）
 * 在同卡内并置。官方三家两块都有 + 启用/默认模型可改；兼容供应商仅 API 块 + 只读端点。
 * 顶部综合徽标按 OR 逻辑（CLI 就绪 或 有 API key 即「就绪」），避免只用一种模式时误报红。
 */
export function Providers(_props: { embedded?: boolean } = {}) {
  const toast = useToast();
  const [ext, setExt] = useState<ProviderExtendedInfo[]>([]);
  const [items, setItems] = useState<Record<string, ProviderItem>>({});
  const [statuses, setStatuses] = useState<Record<string, ProviderStatus>>({});
  const [models, setModels] = useState<Record<string, ProviderModelsResult>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);

  // API key 添加/更新对话框
  const [keyDialogProvider, setKeyDialogProvider] = useState<string | null>(null);
  const [keyInput, setKeyInput] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [savingKey, setSavingKey] = useState(false);
  const [deleteKeyTarget, setDeleteKeyTarget] = useState<string | null>(null);

  // compat provider 的默认模型草稿（compat 走窄接口 setProviderDefaultModel，与官方的整段保存分开）
  const [compatModelDraft, setCompatModelDraft] = useState<Record<string, string>>({});
  const [savingCompat, setSavingCompat] = useState<string | null>(null);

  const loadAll = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [e, itemList] = await Promise.all([
        api.listProvidersExtended(),
        api.listProviders().catch(() => [] as ProviderItem[]),
      ]);
      setExt(e);
      const im: Record<string, ProviderItem> = {};
      for (const it of itemList) im[it.name] = it;
      setItems(im);
      // 播种 compat 默认模型草稿
      const cm: Record<string, string> = {};
      for (const pe of e) if (pe.api_only) cm[pe.name] = pe.default_model ?? "";
      setCompatModelDraft(cm);
    } catch (e: unknown) {
      setLoadError((e as Error)?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  };

  const refreshStatus = async () => {
    setChecking(true);
    try {
      const list = await api.getProvidersStatus();
      const map: Record<string, ProviderStatus> = {};
      for (const s of list) map[s.name] = s;
      setStatuses(map);
    } catch (e: unknown) {
      console.warn("状态检测失败", e);
    } finally {
      setChecking(false);
    }
  };

  const refreshModels = async () => {
    const results = await Promise.all(
      MODEL_LIST_PROVIDERS.map((n) => api.getProviderModels(n).catch(() => null)),
    );
    const map: Record<string, ProviderModelsResult> = {};
    for (const r of results) if (r) map[r.name] = r;
    setModels(map);
  };

  useEffect(() => {
    loadAll();
    refreshStatus();
    refreshModels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const updateItem = (name: string, field: keyof ProviderItem, value: string | boolean | undefined) => {
    setItems((prev) => ({ ...prev, [name]: { ...prev[name], name, [field]: value } as ProviderItem }));
  };

  const saveConfig = async (name: string) => {
    const item = items[name];
    if (!item) return;
    setSaving(name);
    try {
      const { name: _n, agent_count: _a, ...cfg } = item;
      await api.saveProviderConfig(name, cfg);
      toast.success(`${name} 配置已保存`);
    } catch (e: unknown) {
      toast.error("保存失败", (e as Error)?.message ?? String(e));
    } finally {
      setSaving(null);
    }
  };

  const openKeyDialog = (name: string) => {
    setKeyDialogProvider(name);
    setKeyInput("");
    setShowKey(false);
  };

  const saveKey = async () => {
    if (!keyDialogProvider || !keyInput.trim()) return;
    setSavingKey(true);
    try {
      await api.setApiKey(keyDialogProvider, keyInput.trim());
      toast.success(`${keyDialogProvider} API 密钥已保存`);
      setKeyDialogProvider(null);
      setKeyInput("");
      await loadAll();
    } catch (e: unknown) {
      toast.error("保存失败", (e as Error)?.message ?? String(e));
    } finally {
      setSavingKey(false);
    }
  };

  const saveCompatModel = async (name: string) => {
    setSavingCompat(name);
    try {
      await api.setProviderDefaultModel(name, compatModelDraft[name]?.trim() || undefined);
      toast.success(`${name} 默认模型已保存`);
      await loadAll();
    } catch (e: unknown) {
      toast.error("保存失败", (e as Error)?.message ?? String(e));
    } finally {
      setSavingCompat(null);
    }
  };

  const deleteKey = async () => {
    if (!deleteKeyTarget) return;
    try {
      await api.deleteApiKey(deleteKeyTarget);
      toast.success(`${deleteKeyTarget} API 密钥已删除`);
      setDeleteKeyTarget(null);
      await loadAll();
    } catch (e: unknown) {
      toast.error("删除失败", (e as Error)?.message ?? String(e));
    }
  };

  const official = ext.filter((p) => !p.api_only);
  const compat = ext.filter((p) => p.api_only);

  return (
    <PageShell
      width="form"
      hero={{
        title: "提供商",
        subtitle: "CLI 凭证 · API 密钥 · 默认模型",
        description:
          "配置每个供应商的接入方式。官方供应商可用 CLI 登录或填 API 密钥；兼容供应商仅支持 API 直连。密钥本机 AES-256-GCM 加密存储。",
        actions: (
          <Button variant="secondary" onClick={refreshStatus} disabled={checking} size="sm">
            <RefreshCw className={cn("h-3.5 w-3.5", checking && "animate-spin")} />
            {checking ? "检查中…" : "重新检查"}
          </Button>
        ),
      }}
    >
      {loadError && (
        <Card className="mb-4 border-destructive/40 bg-destructive/5 p-4">
          <p className="text-sm font-medium text-destructive">加载失败：{loadError}</p>
          <p className="mt-1.5 text-xs text-muted-foreground">
            常见原因：daemon 未重启（新 API 未生效）。请在「设置 → Daemon」点「重启 daemon」，或终端执行{" "}
            <code className="rounded bg-muted px-1 py-0.5 font-mono">autopilot daemon restart</code> 后刷新。
          </p>
        </Card>
      )}

      {loading ? (
        <p className="text-sm text-muted-foreground">加载中…</p>
      ) : (
        <div className="space-y-6">
          {/* 官方供应商 */}
          <section className="space-y-3">
            <h3 className="text-xs font-medium text-muted-foreground">官方供应商（CLI + API 双模式）</h3>
            {official.map((p) => (
              <ProviderCard
                key={p.name}
                ext={p}
                item={items[p.name]}
                status={statuses[p.name]}
                models={models[p.name]}
                saving={saving === p.name}
                onUpdateItem={updateItem}
                onSaveConfig={saveConfig}
                onAddKey={openKeyDialog}
                onDeleteKey={setDeleteKeyTarget}
              />
            ))}
          </section>

          {/* 兼容供应商 */}
          {compat.length > 0 && (
            <section className="space-y-3">
              <h3 className="text-xs font-medium text-muted-foreground">
                兼容供应商（仅 API 直连）
              </h3>
              {compat.map((p) => (
                <ProviderCard
                  key={p.name}
                  ext={p}
                  compatModel={compatModelDraft[p.name] ?? ""}
                  onCompatModelChange={(v) => setCompatModelDraft((d) => ({ ...d, [p.name]: v }))}
                  onSaveCompatModel={() => saveCompatModel(p.name)}
                  savingCompat={savingCompat === p.name}
                  onAddKey={openKeyDialog}
                  onDeleteKey={setDeleteKeyTarget}
                />
              ))}
            </section>
          )}

          {/* 说明 */}
          <Card className="bg-muted/30 p-4">
            <p className="text-xs leading-relaxed text-muted-foreground">
              <strong>CLI 模式</strong>：通过 Claude / Codex / Gemini 各自的 CLI 调用，凭证由 CLI 管理（终端跑对应 login 命令）。
              <br />
              <strong>API 模式</strong>：直连 HTTP，需在此填密钥。数据库密钥优先于环境变量（如 ANTHROPIC_API_KEY）。
              <br />
              <strong>CLI 命令</strong>：也可用 <code className="rounded bg-muted px-1 py-0.5 font-mono">autopilot key set &lt;provider&gt;</code> 管理密钥。
              <br />
              <strong>自定义兼容端点</strong>：在 <code className="rounded bg-muted px-1 py-0.5 font-mono">config.yaml</code> 的{" "}
              <code className="rounded bg-muted px-1 py-0.5 font-mono">providers.&lt;名&gt;</code> 下配 base_url + env_key_name，重启 daemon 后出现在列表。
            </p>
          </Card>
        </div>
      )}

      {/* 添加/更新 API 密钥对话框 */}
      <Dialog open={!!keyDialogProvider} onOpenChange={(v) => !v && setKeyDialogProvider(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>设置 {keyDialogProvider} API 密钥</DialogTitle>
            <DialogDescription>
              密钥使用 AES-256-GCM 加密后存储在本地数据库。数据库密钥优先级高于环境变量。
            </DialogDescription>
          </DialogHeader>
          <div className="py-2">
            <Label htmlFor="api-key">API 密钥</Label>
            <div className="relative mt-1.5">
              <Input
                id="api-key"
                type={showKey ? "text" : "password"}
                value={keyInput}
                onChange={(e) => setKeyInput(e.target.value)}
                placeholder="sk-..."
                autoComplete="off"
                className="pr-10"
              />
              <button
                type="button"
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                onClick={() => setShowKey(!showKey)}
              >
                {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setKeyDialogProvider(null)}>
              取消
            </Button>
            <Button onClick={saveKey} disabled={savingKey || !keyInput.trim()}>
              {savingKey ? "保存中…" : "保存"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!deleteKeyTarget}
        title={`删除 ${deleteKeyTarget} 的 API 密钥？`}
        message="删除后需重新录入密钥，或通过环境变量配置。此操作不可撤销。"
        confirmText="删除"
        danger
        onConfirm={deleteKey}
        onCancel={() => setDeleteKeyTarget(null)}
      />
    </PageShell>
  );
}

// ──────────────────────────────────────────────
// 单个 provider 卡
// ──────────────────────────────────────────────

function ProviderCard({
  ext: p,
  item,
  status,
  models,
  saving,
  onUpdateItem,
  onSaveConfig,
  compatModel,
  onCompatModelChange,
  onSaveCompatModel,
  savingCompat,
  onAddKey,
  onDeleteKey,
}: {
  ext: ProviderExtendedInfo;
  item?: ProviderItem;
  status?: ProviderStatus;
  models?: ProviderModelsResult;
  saving?: boolean;
  onUpdateItem?: (name: string, field: keyof ProviderItem, value: string | boolean | undefined) => void;
  onSaveConfig?: (name: string) => void;
  compatModel?: string;
  onCompatModelChange?: (v: string) => void;
  onSaveCompatModel?: () => void;
  savingCompat?: boolean;
  onAddKey: (name: string) => void;
  onDeleteKey: (name: string) => void;
}) {
  const meta = PROVIDER_META[p.name];
  const enabled = item ? item.enabled !== false : true;
  const editable = !p.api_only && !!onUpdateItem; // 仅官方可改启用/默认模型（providers.save 限官方）

  return (
    <Card className="p-5">
      {/* header：名 + 类型徽标 + 综合就绪徽标 + 启用开关（官方） */}
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-base font-semibold">{p.display_name}</h3>
          <Badge variant="outline" className="font-normal text-muted-foreground">
            {p.api_only ? "兼容" : "官方"}
          </Badge>
          <OverallBadge ext={p} status={status} enabled={enabled} />
        </div>
        {editable && (
          <div className="flex items-center gap-2 text-sm">
            <Switch
              id={`enabled-${p.name}`}
              checked={enabled}
              onCheckedChange={(v) => onUpdateItem!(p.name, "enabled", v)}
            />
            <Label htmlFor={`enabled-${p.name}`} className="cursor-pointer">
              {enabled ? "启用" : "禁用"}
            </Label>
          </div>
        )}
      </div>

      {/* CLI 模式块（仅 supports_cli） */}
      {p.supports_cli && (
        <CliBlock status={status} loginCmd={meta?.loginCmd ?? ""} />
      )}

      {/* API 模式块 */}
      {p.supports_cli && <Separator className="my-4" />}
      <ApiKeyBlock ext={p} onAddKey={onAddKey} onDeleteKey={onDeleteKey} />

      {/* 默认模型 + 保存（仅官方可改；兼容只读展示来自预置/配置的模型） */}
      <Separator className="my-4" />
      {editable ? (
        <>
          <div className="space-y-1.5">
            <Label htmlFor={`model-${p.name}`} className="flex flex-wrap items-center gap-2">
              <span>默认模型</span>
              {models && (
                <span className="text-xs font-normal text-muted-foreground">
                  （{models.source === "api" ? "API 实时列表" : "内置列表"}
                  {models.error ? ` · 降级：${models.error}` : ""}）
                </span>
              )}
            </Label>
            <ModelCombobox
              id={`model-${p.name}`}
              value={item?.default_model || undefined}
              onChange={(v) => onUpdateItem!(p.name, "default_model", v ?? "")}
              options={models?.models ?? []}
              placeholder={meta?.defaultModel ?? "provider 默认"}
            />
          </div>
          <div className="mt-4 flex justify-end">
            <Button onClick={() => onSaveConfig!(p.name)} disabled={saving}>
              {saving ? "保存中…" : "保存"}
            </Button>
          </div>
        </>
      ) : (
        <>
          <div className="space-y-1.5">
            <Label htmlFor={`model-${p.name}`}>默认模型</Label>
            <ModelCombobox
              id={`model-${p.name}`}
              value={compatModel || undefined}
              onChange={(v) => onCompatModelChange?.(v ?? "")}
              options={[]}
              placeholder="手动输入模型名（留空走预置默认）"
            />
          </div>
          <div className="mt-4 flex justify-end">
            <Button onClick={() => onSaveCompatModel?.()} disabled={savingCompat}>
              {savingCompat ? "保存中…" : "保存"}
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}

// ── 综合就绪徽标（OR 逻辑） ──

function OverallBadge({
  ext: p,
  status,
  enabled,
}: {
  ext: ProviderExtendedInfo;
  status?: ProviderStatus;
  enabled: boolean;
}) {
  if (!enabled) {
    return (
      <Badge variant="secondary" className="gap-1 font-normal text-muted-foreground">
        已禁用
      </Badge>
    );
  }
  const cliReady = !!status?.cli_installed && !status?.error;
  if (cliReady || p.has_api_key) {
    return (
      <Badge variant="success" className="gap-1">
        <CheckCircle2 className="h-3 w-3" />
        就绪
      </Badge>
    );
  }
  // 未就绪：CLI 装了但报错 → 异常；否则 → 未就绪/未配置
  const label = status?.cli_installed && status?.error ? "异常" : p.api_only ? "未配置" : "未就绪";
  return (
    <Badge variant="warning" className="gap-1">
      <AlertTriangle className="h-3 w-3" />
      {label}
    </Badge>
  );
}

// ── CLI 模式块 ──

function CliBlock({ status, loginCmd }: { status?: ProviderStatus; loginCmd: string }) {
  let stateBadge: React.ReactNode;
  if (!status) {
    stateBadge = (
      <span className="flex items-center gap-1 text-xs text-muted-foreground">
        <HelpCircle className="h-3 w-3" />
        未检测
      </span>
    );
  } else if (!status.cli_installed) {
    stateBadge = (
      <span className="flex items-center gap-1 text-xs text-warning">
        <XCircle className="h-3 w-3" />
        未安装
      </span>
    );
  } else if (status.error) {
    stateBadge = (
      <span className="flex items-center gap-1 text-xs text-warning">
        <AlertTriangle className="h-3 w-3" />
        异常
      </span>
    );
  } else {
    stateBadge = (
      <span className="flex items-center gap-1 text-xs text-success">
        <CheckCircle2 className="h-3 w-3" />
        就绪
      </span>
    );
  }

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-sm font-medium">CLI 模式</span>
        {stateBadge}
      </div>
      <div className="space-y-1 text-xs">
        {status && !status.cli_installed && status.install_hint && (
          <div className="text-muted-foreground">
            安装：
            <code className="border border-border bg-muted px-1 py-0.5 font-mono text-foreground">
              {status.install_hint}
            </code>
          </div>
        )}
        {status?.cli_installed && status.cli_path && (
          <div>
            <span className="text-muted-foreground">路径：</span>
            <code className="border border-border bg-muted px-1 py-0.5 font-mono text-foreground">{status.cli_path}</code>
          </div>
        )}
        {status?.cli_version && (
          <div>
            <span className="text-muted-foreground">版本：</span>
            <code className="border border-border bg-muted px-1 py-0.5 font-mono text-foreground">{status.cli_version}</code>
          </div>
        )}
        {status?.error && (
          <div className="flex items-center gap-1 text-warning">
            <AlertTriangle className="h-3 w-3" />
            {status.error}
          </div>
        )}
        <div>
          <span className="text-muted-foreground">登录：</span>
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-foreground">{loginCmd}</code>
        </div>
      </div>
    </div>
  );
}

// ── API 密钥块 ──

function ApiKeyBlock({
  ext: p,
  onAddKey,
  onDeleteKey,
}: {
  ext: ProviderExtendedInfo;
  onAddKey: (name: string) => void;
  onDeleteKey: (name: string) => void;
}) {
  const fromEnv = p.key_source === "env";
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-sm font-medium">API 模式</span>
        {p.has_api_key ? (
          <span className="flex items-center gap-1 text-xs text-success">
            <CheckCircle2 className="h-3 w-3" />
            {fromEnv ? "已配置 · 来自环境变量" : "已配置 · 本机加密"}
          </span>
        ) : (
          <span className="flex items-center gap-1 text-xs text-warning">
            <AlertTriangle className="h-3 w-3" />
            未配置
          </span>
        )}
      </div>

      <div className="space-y-1 text-xs">
        {p.base_url && (
          <div>
            <span className="text-muted-foreground">端点：</span>
            <code className="border border-border bg-muted px-1 py-0.5 font-mono text-foreground">{p.base_url}</code>
          </div>
        )}
        {p.has_api_key && (
          <div>
            <span className="text-muted-foreground">密钥：</span>
            <code className="border border-border bg-muted px-1 py-0.5 font-mono text-foreground">{p.key_hint}</code>
            {fromEnv && <span className="ml-1 text-muted-foreground">（环境变量，shell 中 unset 可移除）</span>}
          </div>
        )}
      </div>

      <div className="mt-2 flex items-center gap-1.5">
        <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => onAddKey(p.name)}>
          <Plus className="mr-1 h-3 w-3" />
          {p.has_api_key ? "更新密钥" : "添加密钥"}
        </Button>
        {p.has_api_key && p.key_source === "db" && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs text-destructive hover:text-destructive"
            onClick={() => onDeleteKey(p.name)}
          >
            <Trash2 className="h-3 w-3" />
          </Button>
        )}
      </div>
    </div>
  );
}
