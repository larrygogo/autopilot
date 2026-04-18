import React, { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, HelpCircle, RefreshCw, XCircle } from "lucide-react";
import { api, type ProviderItem, type ProviderStatus, type ProviderModelsResult } from "@/hooks/useApi";
import { useToast } from "@/components/Toast";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

const PROVIDER_META: Record<string, { label: string; defaultModel: string; loginCmd: string }> = {
  anthropic: { label: "Anthropic (Claude)", defaultModel: "claude-sonnet-4-6", loginCmd: "claude login" },
  openai: { label: "OpenAI (Codex)", defaultModel: "o4-mini", loginCmd: "codex login" },
  google: { label: "Google (Gemini)", defaultModel: "gemini-2.5-pro", loginCmd: "gemini auth login" },
};

// 保留 embedded 参数签名以兼容旧调用
export function Providers(_props: { embedded?: boolean } = {}) {
  const toast = useToast();
  const [providers, setProviders] = useState<ProviderItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [statuses, setStatuses] = useState<Record<string, ProviderStatus>>({});
  const [models, setModels] = useState<Record<string, ProviderModelsResult>>({});
  const [checking, setChecking] = useState(false);

  const refresh = () => {
    setLoading(true);
    setLoadError(null);
    api.listProviders()
      .then(setProviders)
      .catch((e) => setLoadError(e?.message ?? String(e)))
      .finally(() => setLoading(false));
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
    const names = ["anthropic", "openai", "google"];
    const results = await Promise.all(names.map((n) => api.getProviderModels(n).catch(() => null)));
    const map: Record<string, ProviderModelsResult> = {};
    for (const r of results) if (r) map[r.name] = r;
    setModels(map);
  };

  useEffect(() => {
    refresh();
    refreshStatus();
    refreshModels();
  }, []);

  const updateField = (name: string, field: keyof ProviderItem, value: string | boolean | undefined) => {
    setProviders((prev) =>
      prev.map((p) => (p.name === name ? { ...p, [field]: value } : p))
    );
  };

  const save = async (p: ProviderItem) => {
    setSaving(p.name);
    try {
      const { name, ...cfg } = p;
      await api.saveProviderConfig(name, cfg);
      toast.success(`${name} 配置已保存`);
    } catch (e: any) {
      toast.error("保存失败", e?.message ?? String(e));
    } finally {
      setSaving(null);
    }
  };

  return (
    <div className="mx-auto w-full max-w-4xl px-5 py-6">
      {/* Header */}
      <div className="mb-5 flex items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">模型提供商</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">LLM 提供商全局默认</p>
        </div>
        <Button variant="secondary" onClick={refreshStatus} disabled={checking} size="sm">
          <RefreshCw className={cn("h-3.5 w-3.5", checking && "animate-spin")} />
          {checking ? "检查中…" : "重新检查"}
        </Button>
      </div>

      {/* 说明 */}
      <Card className="mb-4 p-4">
        <p className="text-sm text-muted-foreground">
          Autopilot 通过 Claude / Codex / Gemini 各自的 CLI 调用模型，凭证由 CLI 管理。
          如尚未登录，请在终端中运行对应的 <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">login</code> 命令。
        </p>
      </Card>

      {loadError && (
        <Card className="mb-4 border-destructive/40 bg-destructive/5 p-4">
          <p className="text-sm font-medium text-destructive">加载失败：{loadError}</p>
          <p className="mt-1.5 text-xs text-muted-foreground">
            常见原因：daemon 未重启（新 API 未生效）。请执行{" "}
            <code className="rounded bg-muted px-1 py-0.5 font-mono">autopilot daemon stop && autopilot daemon start</code> 后刷新页面。
          </p>
        </Card>
      )}

      {loading ? (
        <p className="text-sm text-muted-foreground">加载中…</p>
      ) : (
        <div className="flex flex-col gap-4">
          {providers.map((p) => {
            const meta = PROVIDER_META[p.name] ?? { label: p.name, defaultModel: "", loginCmd: "" };
            const status = statuses[p.name];
            const modelInfo = models[p.name];
            return (
              <Card key={p.name} className="p-5">
                {/* Card header */}
                <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-base font-semibold">{meta.label}</h3>
                    <ProviderStatusBadge status={status} />
                    <Badge variant="secondary" className="font-normal">
                      {p.agent_count ?? 0} 个智能体
                    </Badge>
                  </div>
                  <div className="flex items-center gap-2 text-sm">
                    <Switch
                      id={`enabled-${p.name}`}
                      checked={p.enabled !== false}
                      onCheckedChange={(v) => updateField(p.name, "enabled", v)}
                    />
                    <Label htmlFor={`enabled-${p.name}`} className="cursor-pointer">
                      {p.enabled !== false ? "启用" : "禁用"}
                    </Label>
                  </div>
                </div>

                {/* 状态详情 */}
                <ProviderStatusDetail status={status} loginCmd={meta.loginCmd} />

                <Separator className="my-4" />

                {/* 配置表单 */}
                <div className="space-y-1.5">
                  <Label htmlFor={`model-${p.name}`} className="flex flex-wrap items-center gap-2">
                    <span>默认模型</span>
                    {modelInfo && (
                      <span className="text-xs font-normal text-muted-foreground">
                        （{modelInfo.source === "api" ? "API 实时列表" : "内置列表"}
                        {modelInfo.error ? ` · 降级：${modelInfo.error}` : ""}）
                      </span>
                    )}
                  </Label>
                  <Input
                    id={`model-${p.name}`}
                    className="font-mono"
                    placeholder={meta.defaultModel}
                    value={p.default_model ?? ""}
                    list={`models-${p.name}`}
                    onChange={(e) => updateField(p.name, "default_model", e.target.value)}
                  />
                  {modelInfo && (
                    <datalist id={`models-${p.name}`}>
                      {modelInfo.models.map((m) => <option key={m} value={m} />)}
                    </datalist>
                  )}
                </div>

                <div className="mt-4 flex justify-end">
                  <Button
                    onClick={() => save(p)}
                    disabled={saving === p.name}
                  >
                    {saving === p.name ? "保存中…" : "保存"}
                  </Button>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ProviderStatusBadge({ status }: { status?: ProviderStatus }) {
  if (!status) {
    return (
      <Badge variant="outline" className="gap-1 font-normal text-muted-foreground">
        <HelpCircle className="h-3 w-3" />
        未检测
      </Badge>
    );
  }
  if (!status.cli_installed) {
    return (
      <Badge variant="destructive" className="gap-1 font-normal">
        <XCircle className="h-3 w-3" />
        CLI 未安装
      </Badge>
    );
  }
  if (status.error) {
    return (
      <Badge variant="outline" className="gap-1 border-amber-500/40 bg-amber-500/10 font-normal text-amber-600 dark:text-amber-400">
        <AlertTriangle className="h-3 w-3" />
        CLI 异常
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="gap-1 border-emerald-500/40 bg-emerald-500/10 font-normal text-emerald-600 dark:text-emerald-400">
      <CheckCircle2 className="h-3 w-3" />
      CLI 就绪
    </Badge>
  );
}

function ProviderStatusDetail({ status, loginCmd }: { status?: ProviderStatus; loginCmd: string }) {
  if (!status) {
    return (
      <p className="text-xs text-muted-foreground">
        登录命令：<code className="rounded bg-muted px-1 py-0.5 font-mono">{loginCmd}</code>
      </p>
    );
  }

  if (!status.cli_installed) {
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs">
        <div className="flex items-center gap-1.5 font-medium text-destructive">
          <AlertTriangle className="h-3.5 w-3.5" />
          {status.error ?? "CLI 未安装"}
        </div>
        {status.install_hint && (
          <div className="mt-1.5 text-muted-foreground">
            安装：<code className="rounded bg-muted px-1 py-0.5 font-mono text-foreground">{status.install_hint}</code>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-1 text-xs">
      <div>
        <span className="text-muted-foreground">CLI：</span>
        <code className="rounded bg-muted px-1 py-0.5 font-mono text-foreground">{status.cli_path}</code>
      </div>
      {status.cli_version && (
        <div>
          <span className="text-muted-foreground">版本：</span>
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-foreground">{status.cli_version}</code>
        </div>
      )}
      {status.error && (
        <div className="flex items-center gap-1 text-amber-600 dark:text-amber-400">
          <AlertTriangle className="h-3 w-3" />
          {status.error}
        </div>
      )}
      <div>
        <span className="text-muted-foreground">登录：</span>
        <code className="rounded bg-muted px-1 py-0.5 font-mono text-foreground">{loginCmd}</code>
      </div>
    </div>
  );
}
