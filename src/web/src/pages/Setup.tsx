import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, type DoctorReportWithDismiss } from "@/hooks/useApi";
import { useToast } from "@/components/Toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { SetupProgress } from "@/components/SetupProgress";
import { FolderPicker } from "@/components/FolderPicker";
import { ModelCombobox } from "@/components/ModelCombobox";

type ProviderName = "anthropic" | "openai" | "google";
const ALL_PROVIDERS: { name: ProviderName; defaultModel: string; loginHint: string }[] = [
  { name: "anthropic", defaultModel: "claude-sonnet-4-6", loginHint: "claude login" },
  { name: "openai",    defaultModel: "gpt-5",             loginHint: "codex login" },
  { name: "google",    defaultModel: "gemini-2.5-pro",    loginHint: "gemini auth login" },
];

export function Setup() {
  const navigate = useNavigate();
  const toast = useToast();

  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [report, setReport] = useState<DoctorReportWithDismiss | null>(null);

  const [enabledProviders, setEnabledProviders] = useState<Record<ProviderName, boolean>>({
    anthropic: true, openai: false, google: false,
  });
  const [models, setModels] = useState<Record<ProviderName, string>>({
    anthropic: "claude-sonnet-4-6", openai: "gpt-5", google: "gemini-2.5-pro",
  });
  // 每个 provider 的可选 model 列表（catalog）
  const [modelCatalogs, setModelCatalogs] = useState<Record<ProviderName, string[]>>({
    anthropic: [], openai: [], google: [],
  });

  const [agentName, setAgentName] = useState("coder");
  const [agentProvider, setAgentProvider] = useState<ProviderName>("anthropic");

  const [cbName, setCbName] = useState("");
  const [cbPath, setCbPath] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);

  useEffect(() => {
    api.setupStatus().then(setReport).catch(() => {});
    // 并发拉 3 个 provider 的 model catalog；失败 → 空列表（用户仍可手输）
    for (const p of ALL_PROVIDERS) {
      api.getProviderModels(p.name)
        .then((r) => setModelCatalogs((m) => ({ ...m, [p.name]: r.models })))
        .catch(() => {});
    }
  }, []);

  async function submitStep1() {
    const payload: Record<string, Record<string, unknown>> = {};
    for (const p of ALL_PROVIDERS) {
      if (enabledProviders[p.name]) {
        payload[p.name] = { enabled: true, default_model: models[p.name] };
      }
    }
    if (Object.keys(payload).length === 0) {
      toast.error("至少选一个 provider", "");
      return;
    }
    try {
      const { report } = await api.setupProviders(payload);
      setReport(report);
      const first = ALL_PROVIDERS.find((p) => enabledProviders[p.name])?.name;
      if (first) setAgentProvider(first);
      setStep(2);
    } catch (e: unknown) {
      toast.error("保存失败", (e as Error)?.message ?? String(e));
    }
  }

  async function submitStep2() {
    if (!agentName.trim()) { toast.error("agent 名不能为空", ""); return; }
    try {
      const { report } = await api.setupAgents({
        [agentName.trim()]: {
          provider: agentProvider,
          model: models[agentProvider],
          max_turns: 10,
          permission_mode: "auto",
        },
      });
      setReport(report);
      setStep(3);
    } catch (e: unknown) {
      toast.error("保存失败", (e as Error)?.message ?? String(e));
    }
  }

  async function submitStep3OrSkip(skip: boolean) {
    if (!skip) {
      if (!cbName.trim() || !cbPath.trim()) { toast.error("name / path 不能为空", ""); return; }
      try {
        await api.setupCodebase({ name: cbName.trim(), path: cbPath.trim() });
      } catch (e: unknown) {
        toast.error("创建 codebase 失败", (e as Error)?.message ?? String(e));
        return;
      }
    }
    await api.setupDismiss().catch(() => {});
    navigate("/now");
  }

  const minimumReady = report && report.checks.find((c) => c.id === "agents.has-any")?.status === "ok";

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <header className="mb-4 border-b-[1.5px] border-foreground/30 pb-3">
        <h1 className="font-display text-2xl font-bold uppercase tracking-wider">首跑向导 · SETUP</h1>
        <p className="font-mono text-xs uppercase tracking-[0.12em] text-muted-foreground mt-1">
          完成 3 步即可开始使用 autopilot
        </p>
      </header>

      <SetupProgress current={step} />

      {step === 3 && minimumReady && (
        <div className="mb-4 border-[1.5px] border-foreground/30 px-3 py-2 font-mono text-xs">
          ✓ 核心配置已就绪 · 第 3 步可选
        </div>
      )}

      {step === 1 && (
        <section className="space-y-4">
          <h2 className="font-mono text-sm font-bold uppercase">1/3 · 启用 Provider</h2>
          {ALL_PROVIDERS.map((p) => (
            <div key={p.name} className="flex items-center gap-3">
              <Checkbox
                checked={enabledProviders[p.name]}
                onChange={(e) => setEnabledProviders((m) => ({ ...m, [p.name]: e.target.checked }))}
                id={`pv-${p.name}`}
              />
              <Label htmlFor={`pv-${p.name}`} className="flex-1 font-mono">{p.name}</Label>
              <ModelCombobox
                className="w-56"
                value={models[p.name]}
                onChange={(v) => setModels((m) => ({ ...m, [p.name]: v ?? "" }))}
                options={modelCatalogs[p.name]}
                placeholder={p.defaultModel}
                disabled={!enabledProviders[p.name]}
              />
            </div>
          ))}
          <p className="text-xs text-muted-foreground">
            ⚠ 凭证需在终端手动登录：
            {ALL_PROVIDERS.filter((p) => enabledProviders[p.name]).map((p) => (
              <code key={p.name} className="mx-1">$ {p.loginHint}</code>
            ))}
          </p>
          <div className="flex justify-end gap-2 pt-4">
            <Button onClick={submitStep1}>下一步 →</Button>
          </div>
        </section>
      )}

      {step === 2 && (
        <section className="space-y-4">
          <h2 className="font-mono text-sm font-bold uppercase">2/3 · 创建 Agent</h2>
          <div>
            <Label htmlFor="agent-name">名字</Label>
            <Input id="agent-name" value={agentName} onChange={(e) => setAgentName(e.target.value)} />
          </div>
          <div>
            <Label>Provider</Label>
            <select
              className="block w-full border-[1.5px] bg-background p-2 font-mono"
              value={agentProvider}
              onChange={(e) => setAgentProvider(e.target.value as ProviderName)}
            >
              {ALL_PROVIDERS.filter((p) => enabledProviders[p.name]).map((p) => (
                <option key={p.name} value={p.name}>{p.name}</option>
              ))}
            </select>
          </div>
          <div className="flex justify-end gap-2 pt-4">
            <Button variant="ghost" onClick={() => setStep(1)}>← 上一步</Button>
            <Button onClick={submitStep2}>下一步 →</Button>
          </div>
        </section>
      )}

      {step === 3 && (
        <section className="space-y-4">
          <h2 className="font-mono text-sm font-bold uppercase">3/3 · 添加 Codebase（可选）</h2>
          <div>
            <Label htmlFor="cb-name">名称</Label>
            <Input id="cb-name" value={cbName} onChange={(e) => setCbName(e.target.value)} placeholder="my-project" />
          </div>
          <div>
            <Label htmlFor="cb-path">本地路径</Label>
            <div className="flex gap-2">
              <Input id="cb-path" value={cbPath} onChange={(e) => setCbPath(e.target.value)} />
              <Button variant="outline" onClick={() => setPickerOpen(true)}>浏览…</Button>
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-4">
            <Button variant="ghost" onClick={() => setStep(2)}>← 上一步</Button>
            <Button variant="outline" onClick={() => submitStep3OrSkip(true)}>跳过</Button>
            <Button onClick={() => submitStep3OrSkip(false)}>完成</Button>
          </div>

          <FolderPicker
            open={pickerOpen}
            initialPath={cbPath || undefined}
            onSelect={(p) => { setCbPath(p); setPickerOpen(false); }}
            onCancel={() => setPickerOpen(false)}
          />
        </section>
      )}
    </div>
  );
}
