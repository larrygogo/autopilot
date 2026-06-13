import React, { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Eye,
  EyeOff,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import {
  api,
  type ProviderExtendedInfo,
  type ProviderTemplate,
} from "@/hooks/useApi";
import { useToast } from "@/components/Toast";
import { PageShell } from "@/components/pro";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ConfirmDialog } from "@/components/Modal";
import { cn } from "@/lib/utils";

// CLI 子类型 → 默认 login 提示（展示用）
const CLI_SUBTYPES: { value: string; label: string; login: string }[] = [
  { value: "claude", label: "Claude（Anthropic）", login: "claude login" },
  { value: "codex", label: "Codex（OpenAI）", login: "codex login" },
  { value: "gemini", label: "Gemini（Google）", login: "gemini auth login" },
];

/**
 * 统一「提供商」设置页（provider 条目化重构 P1）。
 *
 * provider = 用户自管的单类型实例：CLI / API 各自成条、平级、可增删。
 * CLI 条目检本地可用性（本地不支持也可留着）；API 条目管密钥 + 默认模型。
 */
export function Providers(_props: { embedded?: boolean } = {}) {
  const toast = useToast();
  const [entries, setEntries] = useState<ProviderExtendedInfo[]>([]);
  const [templates, setTemplates] = useState<ProviderTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  // API key 对话框
  const [keyDialogName, setKeyDialogName] = useState<string | null>(null);
  const [keyInput, setKeyInput] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [savingKey, setSavingKey] = useState(false);
  const [deleteKeyTarget, setDeleteKeyTarget] = useState<string | null>(null);

  // 删除条目
  const [deleteTarget, setDeleteTarget] = useState<ProviderExtendedInfo | null>(null);

  // 添加条目对话框
  const [addOpen, setAddOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [list, tpls] = await Promise.all([
        api.listProvidersExtended(),
        api.listProviderTemplates().catch(() => [] as ProviderTemplate[]),
      ]);
      setEntries(list);
      setTemplates(tpls);
    } catch (e: unknown) {
      setLoadError((e as Error)?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const recheckCli = async () => {
    setChecking(true);
    try {
      await Promise.all(
        entries.filter((e) => e.type === "cli" && e.id).map((e) => api.detectProviderCli(e.id!).catch(() => null)),
      );
      await load();
    } finally {
      setChecking(false);
    }
  };

  const toggleEnabled = async (e: ProviderExtendedInfo, enabled: boolean) => {
    if (!e.id) return;
    try {
      await api.updateProvider(e.id, { enabled });
      await load();
    } catch (err: unknown) {
      toast.error("保存失败", (err as Error)?.message ?? String(err));
    }
  };

  const saveModel = async (e: ProviderExtendedInfo, model: string) => {
    if (!e.id) return;
    try {
      await api.updateProvider(e.id, { default_model: model.trim() || null });
      toast.success(`${e.display_name} 默认模型已保存`);
      await load();
    } catch (err: unknown) {
      toast.error("保存失败", (err as Error)?.message ?? String(err));
    }
  };

  // ── API key ──
  const saveKey = async () => {
    if (!keyDialogName || !keyInput.trim()) return;
    setSavingKey(true);
    try {
      await api.setApiKey(keyDialogName, keyInput.trim());
      toast.success(`${keyDialogName} API 密钥已保存`);
      setKeyDialogName(null);
      setKeyInput("");
      await load();
    } catch (e: unknown) {
      toast.error("保存失败", (e as Error)?.message ?? String(e));
    } finally {
      setSavingKey(false);
    }
  };
  const deleteKey = async () => {
    if (!deleteKeyTarget) return;
    try {
      await api.deleteApiKey(deleteKeyTarget);
      toast.success(`${deleteKeyTarget} API 密钥已删除`);
      setDeleteKeyTarget(null);
      await load();
    } catch (e: unknown) {
      toast.error("删除失败", (e as Error)?.message ?? String(e));
    }
  };

  // ── 删除条目 ──
  const confirmDelete = async () => {
    if (!deleteTarget?.id) return;
    try {
      await api.deleteProvider(deleteTarget.id);
      toast.success(`已删除 ${deleteTarget.display_name}`);
      setDeleteTarget(null);
      await load();
    } catch (e: unknown) {
      // 引用守卫：被工作流引用时后端拒删，提示原因（不关弹窗，让用户读到）
      toast.error("无法删除", (e as Error)?.message ?? String(e));
    }
  };

  const cliEntries = entries.filter((e) => e.type === "cli");
  const apiEntries = entries.filter((e) => e.type === "api");

  return (
    <PageShell
      width="form"
      hero={{
        title: "提供商",
        subtitle: "CLI / API 平级 · 自管增删",
        description: "每个供应商是一个独立条目，标 CLI 或 API 类型。CLI 凭本地 CLI 登录、API 凭密钥直连。",
        actions: (
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={recheckCli} disabled={checking}>
              <RefreshCw className={cn("h-3.5 w-3.5", checking && "animate-spin")} />
              {checking ? "检查中…" : "重新检查 CLI"}
            </Button>
            <Button size="sm" onClick={() => setAddOpen(true)}>
              <Plus className="h-3.5 w-3.5" />
              添加供应商
            </Button>
          </div>
        ),
      }}
    >
      {loadError && (
        <Card className="mb-4 border-destructive/40 bg-destructive/5 p-4">
          <p className="text-sm font-medium text-destructive">加载失败：{loadError}</p>
          <p className="mt-1.5 text-xs text-muted-foreground">
            常见原因：daemon 未重启。请在「设置 → Daemon」点「重启 daemon」，或终端{" "}
            <code className="rounded bg-muted px-1 py-0.5 font-mono">autopilot daemon restart</code>。
          </p>
        </Card>
      )}

      {loading ? (
        <p className="text-sm text-muted-foreground">加载中…</p>
      ) : (
        <div className="space-y-6">
          <section className="space-y-3">
            <h3 className="text-xs font-medium text-muted-foreground">CLI 供应商（本地 CLI 子进程，凭证 CLI 自管）</h3>
            {cliEntries.length === 0 && <EmptyHint text="暂无 CLI 供应商，点右上「添加供应商」。" />}
            {cliEntries.map((e) => (
              <CliCard key={e.id ?? e.name} entry={e} onToggle={toggleEnabled} onSaveModel={saveModel} onDelete={setDeleteTarget} />
            ))}
          </section>

          <section className="space-y-3">
            <h3 className="text-xs font-medium text-muted-foreground">API 供应商（直连 HTTP，凭密钥）</h3>
            {apiEntries.length === 0 && <EmptyHint text="暂无 API 供应商，从「添加供应商 → API」选模板或自定义。" />}
            {apiEntries.map((e) => (
              <ApiCard
                key={e.id ?? e.name}
                entry={e}
                onToggle={toggleEnabled}
                onSaveModel={saveModel}
                onSaveBaseUrl={async (model) => { if (e.id) { await api.updateProvider(e.id, { base_url: model.trim() || null }); await load(); } }}
                onAddKey={() => { setKeyDialogName(e.name); setKeyInput(""); setShowKey(false); }}
                onDeleteKey={() => setDeleteKeyTarget(e.name)}
                onDelete={setDeleteTarget}
              />
            ))}
          </section>
        </div>
      )}

      {/* 添加条目 */}
      <AddProviderDialog
        open={addOpen}
        templates={templates}
        existingNames={entries.map((e) => e.name)}
        onClose={() => setAddOpen(false)}
        onCreated={async () => { setAddOpen(false); await load(); }}
      />

      {/* API key 对话框 */}
      <Dialog open={!!keyDialogName} onOpenChange={(v) => !v && setKeyDialogName(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>设置 {keyDialogName} API 密钥</DialogTitle>
            <DialogDescription>密钥 AES-256-GCM 加密存本地数据库；优先级高于环境变量。</DialogDescription>
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
            <Button variant="outline" onClick={() => setKeyDialogName(null)}>取消</Button>
            <Button onClick={saveKey} disabled={savingKey || !keyInput.trim()}>{savingKey ? "保存中…" : "保存"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!deleteKeyTarget}
        title={`删除 ${deleteKeyTarget} 的 API 密钥？`}
        message="删除后需重新录入，或通过环境变量配置。"
        confirmText="删除"
        danger
        onConfirm={deleteKey}
        onCancel={() => setDeleteKeyTarget(null)}
      />

      <ConfirmDialog
        open={!!deleteTarget}
        title={`删除供应商「${deleteTarget?.display_name}」？`}
        message={
          <div className="space-y-2 text-sm">
            <p>将删除该供应商条目。若被工作流引用，删除会被拦截并提示受影响的工作流。</p>
            <p className="text-muted-foreground">删除后重新添加同名供应商可恢复引用它的工作流。</p>
          </div>
        }
        confirmText="删除"
        danger
        onConfirm={confirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </PageShell>
  );
}

function EmptyHint({ text }: { text: string }) {
  return <p className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">{text}</p>;
}

// ── CLI 条目卡 ──
function CliCard({
  entry: e,
  onToggle,
  onSaveModel,
  onDelete,
}: {
  entry: ProviderExtendedInfo;
  onToggle: (e: ProviderExtendedInfo, v: boolean) => void;
  onSaveModel: (e: ProviderExtendedInfo, model: string) => void;
  onDelete: (e: ProviderExtendedInfo) => void;
}) {
  const [model, setModel] = useState(e.default_model ?? "");
  const login = CLI_SUBTYPES.find((s) => s.value === e.subtype)?.login;
  return (
    <Card className="p-5">
      <CardHeader entry={e} onToggle={onToggle} onDelete={onDelete}
        statusBadge={<CliStatusBadge status={e.cli_status} enabled={e.enabled !== false} />} />
      <div className="mt-2 space-y-1 text-xs">
        {e.cli_status === "missing" && (
          <p className="text-warning">本地未安装 <code className="bg-muted px-1 font-mono">{e.subtype}</code> CLI；装上即可用（可留着在别处跑）。</p>
        )}
        {e.cli_version && <div><span className="text-muted-foreground">版本：</span><code className="bg-muted px-1 font-mono text-foreground">{e.cli_version}</code></div>}
        {login && <div><span className="text-muted-foreground">登录：</span><code className="bg-muted px-1 font-mono text-foreground">{login}</code></div>}
      </div>
      <ModelRow value={model} onChange={setModel} onSave={() => onSaveModel(e, model)} dirty={model !== (e.default_model ?? "")} hasCatalog />
    </Card>
  );
}

// ── API 条目卡 ──
function ApiCard({
  entry: e,
  onToggle,
  onSaveModel,
  onSaveBaseUrl,
  onAddKey,
  onDeleteKey,
  onDelete,
}: {
  entry: ProviderExtendedInfo;
  onToggle: (e: ProviderExtendedInfo, v: boolean) => void;
  onSaveModel: (e: ProviderExtendedInfo, model: string) => void;
  onSaveBaseUrl: (url: string) => void;
  onAddKey: () => void;
  onDeleteKey: () => void;
  onDelete: (e: ProviderExtendedInfo) => void;
}) {
  const [model, setModel] = useState(e.default_model ?? "");
  const [baseUrl, setBaseUrl] = useState(e.base_url ?? "");
  const fromEnv = e.key_source === "env";
  const isCompat = e.subtype === "openai-compat";
  return (
    <Card className="p-5">
      <CardHeader entry={e} onToggle={onToggle} onDelete={onDelete}
        statusBadge={<ApiStatusBadge hasKey={e.has_api_key} enabled={e.enabled !== false} />} />

      <div className="mt-2 space-y-1.5 text-xs">
        {/* 密钥 */}
        <div className="flex items-center justify-between gap-2">
          <div>
            <span className="text-muted-foreground">密钥：</span>
            {e.has_api_key ? (
              <span className="text-success">
                {e.key_hint}{fromEnv && <span className="ml-1 text-muted-foreground">（环境变量，shell 中 unset 可移除）</span>}
              </span>
            ) : <span className="text-warning">未配置</span>}
          </div>
          <div className="flex items-center gap-1.5">
            <Button variant="outline" size="sm" className="h-7 text-xs" onClick={onAddKey}>
              <Plus className="mr-1 h-3 w-3" />{e.has_api_key ? "更新密钥" : "添加密钥"}
            </Button>
            {e.has_api_key && e.key_source === "db" && (
              <Button variant="ghost" size="sm" className="h-7 text-xs text-destructive hover:text-destructive" onClick={onDeleteKey}>
                <Trash2 className="h-3 w-3" />
              </Button>
            )}
          </div>
        </div>
        {/* 端点（compat 可编辑） */}
        {isCompat && (
          <div className="flex items-center gap-2 pt-1">
            <Label className="shrink-0 text-[10px] text-muted-foreground">端点</Label>
            <Input value={baseUrl} onChange={(ev) => setBaseUrl(ev.target.value)} placeholder="https://api.example.com/v1" className="h-7 font-mono text-xs" />
            {baseUrl !== (e.base_url ?? "") && (
              <Button size="sm" variant="secondary" className="h-7 text-xs" onClick={() => onSaveBaseUrl(baseUrl)}>保存</Button>
            )}
          </div>
        )}
        {!isCompat && e.base_url && <div><span className="text-muted-foreground">端点：</span><code className="bg-muted px-1 font-mono text-foreground">{e.base_url}</code></div>}
      </div>

      <ModelRow value={model} onChange={setModel} onSave={() => onSaveModel(e, model)} dirty={model !== (e.default_model ?? "")} />
    </Card>
  );
}

function CardHeader({
  entry: e,
  onToggle,
  onDelete,
  statusBadge,
}: {
  entry: ProviderExtendedInfo;
  onToggle: (e: ProviderExtendedInfo, v: boolean) => void;
  onDelete: (e: ProviderExtendedInfo) => void;
  statusBadge: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-base font-semibold">{e.display_name}</h3>
        <Badge variant="outline" className="font-normal text-muted-foreground">{e.type === "cli" ? "CLI" : "API"}</Badge>
        <code className="font-mono text-[10px] text-muted-foreground">{e.name}</code>
        {statusBadge}
      </div>
      <div className="flex items-center gap-2">
        <Switch checked={e.enabled !== false} onCheckedChange={(v) => onToggle(e, v)} />
        <Button variant="ghost" size="sm" className="h-7 text-xs text-destructive hover:text-destructive" onClick={() => onDelete(e)}>
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}

function ModelRow({ value, onChange, onSave, dirty, hasCatalog }: { value: string; onChange: (v: string) => void; onSave: () => void; dirty: boolean; hasCatalog?: boolean }) {
  return (
    <div className="mt-3 flex items-center gap-2 border-t border-border pt-3">
      <Label className="shrink-0 text-[10px] text-muted-foreground">默认模型</Label>
      <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder={hasCatalog ? "留空走内核兜底" : "手动输入模型名"} className="h-7 font-mono text-xs" />
      {dirty && <Button size="sm" className="h-7 text-xs" onClick={onSave}>保存</Button>}
    </div>
  );
}

function CliStatusBadge({ status, enabled }: { status?: string | null; enabled: boolean }) {
  if (!enabled) return <Badge variant="secondary" className="font-normal text-muted-foreground">已禁用</Badge>;
  if (status === "ok") return <Badge variant="success" className="gap-1"><CheckCircle2 className="h-3 w-3" />就绪</Badge>;
  if (status === "missing") return <Badge variant="warning" className="gap-1"><AlertTriangle className="h-3 w-3" />本地不支持</Badge>;
  return <Badge variant="secondary" className="font-normal text-muted-foreground">未检测</Badge>;
}

function ApiStatusBadge({ hasKey, enabled }: { hasKey: boolean; enabled: boolean }) {
  if (!enabled) return <Badge variant="secondary" className="font-normal text-muted-foreground">已禁用</Badge>;
  if (hasKey) return <Badge variant="success" className="gap-1"><CheckCircle2 className="h-3 w-3" />就绪</Badge>;
  return <Badge variant="warning" className="gap-1"><AlertTriangle className="h-3 w-3" />未配置</Badge>;
}

// ── 添加供应商对话框 ──
function AddProviderDialog({
  open,
  templates,
  existingNames,
  onClose,
  onCreated,
}: {
  open: boolean;
  templates: ProviderTemplate[];
  existingNames: string[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const toast = useToast();
  const [type, setType] = useState<"cli" | "api">("cli");
  const [cliSubtype, setCliSubtype] = useState("claude");
  const [templateName, setTemplateName] = useState("__custom__");
  const [name, setName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [defaultModel, setDefaultModel] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setType("cli"); setCliSubtype("claude"); setTemplateName("__custom__");
      setName(""); setDisplayName(""); setBaseUrl(""); setDefaultModel("");
    }
  }, [open]);

  // 选模板 → 预填
  const applyTemplate = (tn: string) => {
    setTemplateName(tn);
    if (tn === "__custom__") { setName(""); setDisplayName(""); setBaseUrl(""); setDefaultModel(""); return; }
    const t = templates.find((x) => x.name === tn);
    if (t) { setName(t.name); setDisplayName(t.display_name); setBaseUrl(t.base_url); setDefaultModel(t.default_model); }
  };

  const effName = type === "cli" ? (name.trim() || cliSubtype) : name.trim();
  const nameTaken = existingNames.includes(effName);

  const create = async () => {
    if (!effName) { toast.error("需要标识名"); return; }
    if (nameTaken) { toast.error(`名称已存在：${effName}`); return; }
    setSaving(true);
    try {
      if (type === "cli") {
        await api.createProvider({
          name: effName,
          display_name: displayName.trim() || CLI_SUBTYPES.find((s) => s.value === cliSubtype)?.label || effName,
          type: "cli",
          subtype: cliSubtype,
          cli_login_cmd: CLI_SUBTYPES.find((s) => s.value === cliSubtype)?.login,
          default_model: defaultModel.trim() || null,
        });
      } else {
        await api.createProvider({
          name: effName,
          display_name: displayName.trim() || effName,
          type: "api",
          subtype: "openai-compat",
          base_url: baseUrl.trim() || null,
          default_model: defaultModel.trim() || null,
          origin: templateName !== "__custom__" ? "template" : "user",
        });
      }
      toast.success(`已添加 ${effName}`);
      onCreated();
    } catch (e: unknown) {
      toast.error("添加失败", (e as Error)?.message ?? String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>添加供应商</DialogTitle>
          <DialogDescription>CLI 用本地 CLI 子进程跑（凭证 CLI 自管）；API 直连 HTTP（需密钥）。</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-1">
          <div className="space-y-1.5">
            <Label>类型</Label>
            <Select value={type} onValueChange={(v) => setType(v as "cli" | "api")}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="cli">CLI · 本地子进程</SelectItem>
                <SelectItem value="api">API · 直连</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {type === "cli" ? (
            <div className="space-y-1.5">
              <Label>CLI</Label>
              <Select value={cliSubtype} onValueChange={setCliSubtype}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {CLI_SUBTYPES.map((s) => <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>)}
                </SelectContent>
              </Select>
              <p className="text-[10px] text-muted-foreground">添加后自动探测本地是否安装；未装会标「本地不支持」。</p>
            </div>
          ) : (
            <div className="space-y-1.5">
              <Label>模板</Label>
              <Select value={templateName} onValueChange={applyTemplate}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__custom__">自定义端点</SelectItem>
                  {templates.map((t) => <SelectItem key={t.name} value={t.name}>{t.display_name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="prov-name">标识名（工作流引用键）</Label>
            <Input id="prov-name" value={name} onChange={(e) => setName(e.target.value)}
              placeholder={type === "cli" ? cliSubtype : "如 deepseek"} className="font-mono" />
            {nameTaken && <p className="text-[10px] text-destructive">名称已存在：{effName}</p>}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="prov-display">显示名（可选）</Label>
            <Input id="prov-display" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="留空用标识/CLI 名" />
          </div>

          {type === "api" && (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="prov-baseurl">Base URL</Label>
                <Input id="prov-baseurl" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.example.com/v1" className="font-mono" />
              </div>
              <p className="text-[10px] text-muted-foreground">保存后在卡片上「添加密钥」。</p>
            </>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="prov-model">默认模型（可选）</Label>
            <Input id="prov-model" value={defaultModel} onChange={(e) => setDefaultModel(e.target.value)} placeholder="留空走兜底" className="font-mono" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>取消</Button>
          <Button onClick={create} disabled={saving || !effName || nameTaken}>{saving ? "添加中…" : "添加"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
