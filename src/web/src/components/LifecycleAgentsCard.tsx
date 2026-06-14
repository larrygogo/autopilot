import { useEffect, useState } from "react";
import { api, type LifecycleAgentInfo, type ProviderItem } from "@/hooks/useApi";
import { useToast } from "@/components/Toast";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ModelCombobox } from "@/components/ModelCombobox";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";

const PERMISSION_MODES = [
  { value: "default", label: "默认 · 危险操作有防护" },
  { value: "acceptEdits", label: "自动接受编辑（CLI）" },
  { value: "plan", label: "计划模式 · 只读规划（CLI）" },
  { value: "cautious", label: "谨慎 · 禁用 bash（API）" },
  { value: "bypassPermissions", label: "跳过所有确认 · 放开" },
];
const INHERIT = "__inherit__";

/**
 * 生命周期 agent 配置（P1：clarify）。平台固定阶段的 agent 全局默认。
 * 「跟随默认」= 不写 config，走内置兜底；改任一字段即写 lifecycle.clarify override。
 */
export function LifecycleAgentsCard() {
  const toast = useToast();
  const [info, setInfo] = useState<LifecycleAgentInfo | null>(null);
  const [providers, setProviders] = useState<ProviderItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // 草稿（从 effective 起底；空字符串 = 该字段跟随默认）
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [maxTurns, setMaxTurns] = useState("");
  const [permMode, setPermMode] = useState("");
  const [sysPrompt, setSysPrompt] = useState("");

  // 模型目录（按当前生效 provider 拉；compat provider 可能为空，Combobox 仍支持手输）
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const [res, ps] = await Promise.all([
        api.listLifecycleAgents(),
        api.listProviders().catch(() => [] as ProviderItem[]),
      ]);
      const clarify = res.agents.find((a) => a.name === "clarify") ?? null;
      setInfo(clarify);
      setProviders(ps);
      const u = clarify?.userConfig ?? {};
      setProvider(u.provider ?? "");
      setModel(u.model ?? "");
      setMaxTurns(u.max_turns != null ? String(u.max_turns) : "");
      setPermMode(u.permission_mode ?? "");
      setSysPrompt(u.system_prompt ?? "");
    } catch (e: unknown) {
      toast.error("加载失败", (e as Error)?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  // 当前生效 provider：草稿优先，否则用默认（effective）。变化时拉模型目录。
  const activeProvider = provider || info?.effective.provider || "";
  useEffect(() => {
    if (!activeProvider) { setModelOptions([]); return; }
    let cancelled = false;
    setLoadingModels(true);
    api.getProviderModels(activeProvider)
      .then((r) => { if (!cancelled) setModelOptions(r.models ?? []); })
      .catch(() => { if (!cancelled) setModelOptions([]); })
      .finally(() => { if (!cancelled) setLoadingModels(false); });
    return () => { cancelled = true; };
  }, [activeProvider]);

  const save = async () => {
    setSaving(true);
    try {
      const cfg: Record<string, unknown> = {};
      if (provider) cfg.provider = provider;
      if (model.trim()) cfg.model = model.trim();
      if (maxTurns.trim() && Number(maxTurns) > 0) cfg.max_turns = Number(maxTurns);
      if (permMode) cfg.permission_mode = permMode;
      if (sysPrompt.trim()) cfg.system_prompt = sysPrompt;
      await api.setLifecycleAgent("clarify", Object.keys(cfg).length ? cfg : null);
      toast.success("已保存，下次澄清生效");
      await load();
    } catch (e: unknown) {
      toast.error("保存失败", (e as Error)?.message ?? String(e));
    } finally {
      setSaving(false);
    }
  };

  const reset = async () => {
    setSaving(true);
    try {
      await api.setLifecycleAgent("clarify", null);
      toast.success("已恢复默认");
      await load();
    } catch (e: unknown) {
      toast.error("重置失败", (e as Error)?.message ?? String(e));
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <p className="text-sm text-muted-foreground">加载中…</p>;
  const eff = info?.effective ?? {};

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <div className="mb-3">
          <h3 className="text-sm font-semibold">需求澄清 <span className="font-mono text-[10px] font-normal text-muted-foreground">clarify</span></h3>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            开始做需求前，AI 会先读你的代码、跟你对话把需求理清。这里决定它用哪个模型、怎么跑；没填的项走默认。
          </p>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">提供商<span className="ml-1 text-[10px]">（默认 {eff.provider}）</span></Label>
            <Select value={provider || INHERIT} onValueChange={(v) => setProvider(v === INHERIT ? "" : v)}>
              <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={INHERIT}>跟随默认（{eff.provider}）</SelectItem>
                {providers.map((p) => <SelectItem key={p.name} value={p.name}>{p.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">模型</Label>
            <ModelCombobox
              value={model || undefined}
              onChange={(v) => setModel(v ?? "")}
              options={modelOptions}
              clearable
              placeholder={loadingModels ? "加载模型…" : "留空用默认模型"}
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">最大轮数<span className="ml-1 text-[10px]">（默认 {eff.max_turns}）</span></Label>
            <Input type="number" min={1} value={maxTurns} onChange={(e) => setMaxTurns(e.target.value)} placeholder={String(eff.max_turns ?? "")} className="h-9 font-mono text-sm" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">权限模式<span className="ml-1 text-[10px]">（默认 {eff.permission_mode}）</span></Label>
            <Select value={permMode || INHERIT} onValueChange={(v) => setPermMode(v === INHERIT ? "" : v)}>
              <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={INHERIT}>跟随默认（{eff.permission_mode}）</SelectItem>
                {PERMISSION_MODES.map((m) => <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="mt-3 space-y-1.5">
          <Label className="text-xs text-muted-foreground">系统提示词（留空走内置）</Label>
          <Textarea
            value={sysPrompt}
            onChange={(e) => setSysPrompt(e.target.value)}
            placeholder={eff.system_prompt}
            rows={4}
            className="font-mono text-[11px] leading-relaxed"
          />
          <p className="text-[10px] text-muted-foreground">
            这条只改澄清时的提示词。建需求、生成工作流也用上面的模型，但提示词各自独立。
          </p>
        </div>

        <div className="mt-4 flex items-center justify-between gap-2">
          <p className="text-[10px] text-muted-foreground">保存后下次澄清就生效。</p>
          <div className="flex items-center gap-1.5">
            <Button variant="ghost" size="sm" onClick={reset} disabled={saving}>重置默认</Button>
            <Button size="sm" onClick={save} disabled={saving}>{saving ? "保存中…" : "保存"}</Button>
          </div>
        </div>
      </Card>

      <Card className="bg-muted/30 p-4">
        <p className="text-xs leading-relaxed text-muted-foreground">
          这里管的是平台自带的几个 AI 步骤（澄清、建需求、生成工作流）。工作流里的执行阶段（设计、开发……）
          在「工作流」页按阶段单独配。单个需求也能在它自己的页面临时换个模型，比如澄清失败时重试。
          <br />
          命令行：<code className="rounded bg-muted px-1 py-0.5 font-mono">autopilot lifecycle set clarify --provider …</code>
        </p>
      </Card>
    </div>
  );
}
