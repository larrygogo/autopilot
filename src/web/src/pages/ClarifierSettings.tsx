import { useEffect, useMemo, useState } from "react";
import { api, type AgentItem, type ProviderItem } from "@/hooks/useApi";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/input";
import { useToast } from "@/components/Toast";
import { Loader2, Save } from "lucide-react";

const AGENT_NAME = "clarifier";

const DEFAULT_PROMPT_PLACEHOLDER = "（留空使用内置默认：'你是一位软件需求分析师...'）";

export function ClarifierSettings() {
  const toast = useToast();
  const [providers, setProviders] = useState<ProviderItem[]>([]);
  const [agent, setAgent] = useState<AgentItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // 表单 state
  const [provider, setProvider] = useState<string>("");
  const [model, setModel] = useState<string>("");
  const [systemPrompt, setSystemPrompt] = useState<string>("");
  const [modelChoices, setModelChoices] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);

  // 初始加载 providers + 尝试拉 clarifier agent
  useEffect(() => {
    (async () => {
      try {
        const [ps, ag] = await Promise.all([
          api.listProviders(),
          api.getAgent(AGENT_NAME).catch(() => null),
        ]);
        setProviders(ps);
        if (ag) {
          setAgent(ag);
          setProvider(ag.provider ?? "");
          setModel(ag.model ?? "");
          setSystemPrompt(ag.system_prompt ?? "");
        }
      } catch (e: unknown) {
        toast.error("加载失败", (e as Error)?.message ?? String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, [toast]);

  // provider 改变时拉对应的 model 列表
  useEffect(() => {
    if (!provider) {
      setModelChoices([]);
      return;
    }
    setLoadingModels(true);
    api.getProviderModels(provider)
      .then((r) => setModelChoices(r.models ?? []))
      .catch(() => setModelChoices([]))
      .finally(() => setLoadingModels(false));
  }, [provider]);

  const canSave = useMemo(
    () => !!provider && !saving && !loading,
    [provider, saving, loading],
  );

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      const body = {
        name: AGENT_NAME,
        provider: provider as "anthropic" | "openai" | "google",
        model: model || undefined,
        system_prompt: systemPrompt.trim() || undefined,
      };
      if (agent) {
        await api.updateAgent(AGENT_NAME, body);
      } else {
        await api.createAgent(body as AgentItem);
        setAgent({ ...body, name: AGENT_NAME } as AgentItem);
      }
      toast.success("已保存。重启 daemon 后生效");
    } catch (e: unknown) {
      toast.error("保存失败", (e as Error)?.message ?? String(e));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-12 text-muted-foreground font-mono text-xs uppercase tracking-[0.12em]">
        <Loader2 className="h-4 w-4 animate-spin" />
        加载中…
      </div>
    );
  }

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h2 className="font-display text-lg font-bold uppercase tracking-wider">需求澄清模型</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          新建需求后，AI 会自动追问并把回答融合进规约。这里选 AI 用什么模型说话。
        </p>
      </div>

      <div className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="cl-provider" className="font-mono text-[10px] uppercase tracking-[0.18em]">
            供应商 *
          </Label>
          <Select value={provider} onValueChange={(v) => { setProvider(v); setModel(""); }}>
            <SelectTrigger id="cl-provider" className="rounded-none">
              <SelectValue placeholder="选择供应商" />
            </SelectTrigger>
            <SelectContent>
              {providers.map((p) => (
                <SelectItem key={p.name} value={p.name}>
                  {p.name}
                  {p.default_model ? <span className="text-muted-foreground ml-2 text-xs">默认 {p.default_model}</span> : null}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="cl-model" className="font-mono text-[10px] uppercase tracking-[0.18em]">
            模型（可选，不填走供应商默认）
          </Label>
          <Select value={model} onValueChange={setModel} disabled={!provider || loadingModels}>
            <SelectTrigger id="cl-model" className="rounded-none">
              <SelectValue placeholder={
                !provider ? "先选供应商" :
                loadingModels ? "加载模型列表…" :
                modelChoices.length === 0 ? "无可用模型（走默认）" :
                "选择模型"
              } />
            </SelectTrigger>
            <SelectContent>
              {modelChoices.map((m) => (
                <SelectItem key={m} value={m}>{m}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="cl-prompt" className="font-mono text-[10px] uppercase tracking-[0.18em]">
            自定义 System Prompt（可选）
          </Label>
          <Textarea
            id="cl-prompt"
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            placeholder={DEFAULT_PROMPT_PLACEHOLDER}
            rows={6}
            className="resize-none font-mono text-sm"
          />
          <p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
            留空时使用内置 prompt（要求 AI 输出 JSON + 一问一答 + 修订 spec_md）。
            高级用户可覆盖角色设定，但 JSON 输出契约不要破坏。
          </p>
        </div>

        <div className="flex justify-end pt-2">
          <Button
            onClick={() => void handleSave()}
            disabled={!canSave}
            className="rounded-none font-mono text-[11px] uppercase tracking-[0.12em]"
          >
            {saving ? <><Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />保存中…</> : <><Save className="h-3.5 w-3.5 mr-1.5" />保存</>}
          </Button>
        </div>
      </div>

      {agent && (
        <div className="border-[1.5px] border-foreground/30 bg-card/40 p-4 font-mono text-xs">
          <p className="text-muted-foreground uppercase tracking-[0.18em] mb-2 text-[10px]">当前配置</p>
          <p>name: <span className="text-foreground">{agent.name}</span></p>
          <p>provider: <span className="text-foreground">{agent.provider ?? "—"}</span></p>
          <p>model: <span className="text-foreground">{agent.model ?? "（默认）"}</span></p>
        </div>
      )}

      <p className="text-xs text-muted-foreground border-t border-dashed border-foreground/25 pt-3">
        💡 保存后需要重启 daemon 让 clarifier 用新配置：
        <code className="font-mono ml-1.5 text-foreground">autopilot daemon restart</code>
      </p>
    </div>
  );
}
