import React, { useCallback, useEffect, useState } from "react";
import { Key, Trash2, Plus, Eye, EyeOff, RefreshCw, Shield, Globe } from "lucide-react";
import { api, type ApiKeyInfo, type ProviderExtendedInfo } from "@/hooks/useApi";
import { useToast } from "@/components/Toast";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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

export function ApiKeysPage() {
  const toast = useToast();
  const [providers, setProviders] = useState<ProviderExtendedInfo[]>([]);
  const [loading, setLoading] = useState(true);

  // 添加/编辑对话框
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editProvider, setEditProvider] = useState("");
  const [keyInput, setKeyInput] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);

  // 删除确认
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.listProvidersExtended();
      setProviders(data);
    } catch (e: unknown) {
      toast.error("加载失败", (e as Error)?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const handleAdd = (providerName: string) => {
    setEditProvider(providerName);
    setKeyInput("");
    setShowKey(false);
    setDialogOpen(true);
  };

  const handleSave = async () => {
    if (!keyInput.trim()) {
      toast.error("API key 不能为空");
      return;
    }
    setSaving(true);
    try {
      await api.setApiKey(editProvider, keyInput.trim());
      toast.success(`${editProvider} API key 已保存`);
      setDialogOpen(false);
      setKeyInput("");
      await refresh();
    } catch (e: unknown) {
      toast.error("保存失败", (e as Error)?.message ?? String(e));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await api.deleteApiKey(deleteTarget);
      toast.success(`${deleteTarget} API key 已删除`);
      setDeleteTarget(null);
      await refresh();
    } catch (e: unknown) {
      toast.error("删除失败", (e as Error)?.message ?? String(e));
    }
  };

  // 分组：官方 provider + compat provider
  const officialProviders = providers.filter((p) => !p.api_only);
  const compatProviders = providers.filter((p) => p.api_only);

  return (
    <div className="space-y-6">
      {/* 页面标题由 SettingsHub 的 PageHero 提供（「API 密钥」分区头），这里只留刷新动作行 */}
      <div className="flex items-center justify-end">
        <Button variant="ghost" size="sm" onClick={refresh} disabled={loading}>
          <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
          刷新
        </Button>
      </div>

      {/* 官方 Provider */}
      <Card className="p-4">
        <h3 className="flex items-center gap-2 text-sm font-semibold mb-3">
          <Shield className="h-4 w-4 text-muted-foreground" />
          官方供应商（支持 CLI + API 双模式）
        </h3>
        <div className="space-y-3">
          {officialProviders.map((p) => (
            <ProviderRow
              key={p.name}
              provider={p}
              onAdd={handleAdd}
              onDelete={setDeleteTarget}
            />
          ))}
        </div>
      </Card>

      {/* Compat Provider */}
      {compatProviders.length > 0 && (
        <Card className="p-4">
          <h3 className="flex items-center gap-2 text-sm font-semibold mb-3">
            <Globe className="h-4 w-4 text-muted-foreground" />
            兼容供应商（仅 API 模式）
          </h3>
          <div className="space-y-3">
            {compatProviders.map((p) => (
              <ProviderRow
                key={p.name}
                provider={p}
                onAdd={handleAdd}
                onDelete={setDeleteTarget}
              />
            ))}
          </div>
        </Card>
      )}

      {/* 提示信息 */}
      <Card className="p-4 bg-muted/30">
        <p className="text-xs text-muted-foreground">
          <strong>优先级</strong>：数据库存储的密钥优先于环境变量。
          <br />
          <strong>环境变量</strong>：设置对应的环境变量（如 ANTHROPIC_API_KEY）也可作为回落。
          <br />
          <strong>CLI 命令</strong>：也可使用 <code className="text-xs bg-muted px-1 rounded">autopilot key set &lt;provider&gt;</code> 管理密钥。
        </p>
      </Card>

      {/* 添加/编辑对话框 */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {editProvider ? `设置 ${editProvider} API Key` : "添加 API Key"}
            </DialogTitle>
            <DialogDescription>
              输入 API 密钥。密钥将使用 AES-256-GCM 加密后存储在本地数据库中。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div>
              <Label htmlFor="api-key">API Key</Label>
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
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              取消
            </Button>
            <Button onClick={handleSave} disabled={saving || !keyInput.trim()}>
              {saving ? "保存中..." : "保存"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除确认对话框 */}
      <ConfirmDialog
        open={!!deleteTarget}
        title={`删除 ${deleteTarget} 的 API Key？`}
        message="删除后需重新录入密钥，或通过环境变量配置。此操作不可撤销。"
        confirmText="删除"
        danger
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}

// ── 行组件 ──

function ProviderRow({
  provider: p,
  onAdd,
  onDelete,
}: {
  provider: ProviderExtendedInfo;
  onAdd: (name: string) => void;
  onDelete: (name: string) => void;
}) {
  return (
    <div className="flex items-center justify-between py-2 px-3 rounded-lg border border-border/50 hover:border-border transition-colors">
      <div className="flex items-center gap-3 min-w-0">
        <Key className="h-4 w-4 text-muted-foreground flex-shrink-0" />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">{p.display_name}</span>
            {p.api_only && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                API Only
              </span>
            )}
          </div>
          <div className="text-xs text-muted-foreground mt-0.5">
            {p.has_api_key ? (
              <span className="flex items-center gap-1">
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-green-500" />
                {p.key_hint}
                {p.key_source === "env" && " (环境变量)"}
              </span>
            ) : (
              <span className="flex items-center gap-1">
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-yellow-500" />
                未配置
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-1.5">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onAdd(p.name)}
          className="h-7 text-xs"
        >
          <Plus className="h-3 w-3 mr-1" />
          {p.has_api_key ? "更新" : "添加"}
        </Button>
        {p.has_api_key && p.key_source === "db" && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onDelete(p.name)}
            className="h-7 text-xs text-destructive hover:text-destructive"
          >
            <Trash2 className="h-3 w-3" />
          </Button>
        )}
      </div>
    </div>
  );
}
