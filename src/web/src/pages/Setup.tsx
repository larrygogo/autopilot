import { useEffect, useState } from "react";
import { PageShell } from "@/components/pro";
import { useNavigate } from "react-router-dom";
import { api, type DoctorReportWithDismiss } from "@/hooks/useApi";
import { useToast } from "@/components/Toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { SetupProgress } from "@/components/SetupProgress";
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

  // 命名复用 agent 删除后，首跑向导从 3 步简化为 2 步：Provider → 代码库。
  // agent 配置不再在向导里单独配，改由每个工作流的 phase 内联编辑（默认 agent 兜底）。
  const [step, setStep] = useState<1 | 2>(1);
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

  const [cbName, setCbName] = useState("");
  const [cbRemoteUrl, setCbRemoteUrl] = useState("");
  const [cbSubmitting, setCbSubmitting] = useState(false);

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
      toast.error("至少选一个提供商", "");
      return;
    }
    try {
      const { report } = await api.setupProviders(payload);
      setReport(report);
      setStep(2);
    } catch (e: unknown) {
      toast.error("保存失败", (e as Error)?.message ?? String(e));
    }
  }

  async function submitStep2OrSkip(skip: boolean) {
    if (!skip) {
      if (!cbName.trim() || !cbRemoteUrl.trim()) { toast.error("名称 / 远程仓库地址不能为空", ""); return; }
      setCbSubmitting(true);
      try {
        // 后端写库前会 git ls-remote 验证可达性（可能耗时数秒）
        await api.setupWorkspace({ name: cbName.trim(), remote_url: cbRemoteUrl.trim() });
      } catch (e: unknown) {
        toast.error("创建代码库失败", (e as Error)?.message ?? String(e));
        return;
      } finally {
        setCbSubmitting(false);
      }
    }
    await api.setupDismiss().catch(() => {});
    navigate("/tasks");
  }

  // 核心就绪 = 至少启用了一个 provider（命名 agent 检查已移除）
  const minimumReady = report && report.checks.find((c) => c.id === "providers.has-enabled")?.status === "ok";

  return (
    <PageShell width="focus" hero={{ title: "首跑向导", subtitle: "完成 2 步即可开始使用 autopilot" }}>

      <SetupProgress current={step} labels={["提供商", "代码库"]} />

      {step === 2 && minimumReady && (
        <div className="mb-4 rounded-md border border-border px-3 py-2 text-xs">
          ✓ 必填的都好了 · 第 2 步可选
        </div>
      )}

      {step === 1 && (
        <section className="space-y-4">
          <h2 className="text-sm font-bold">1/2 · 选择提供商</h2>
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
            还要在终端登录一下：
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
          <h2 className="text-sm font-bold">2/2 · 添加代码库（可选）</h2>
          <div>
            <Label htmlFor="cb-name">名称</Label>
            <Input id="cb-name" value={cbName} onChange={(e) => setCbName(e.target.value)} placeholder="my-project" />
          </div>
          <div>
            <Label htmlFor="cb-remote">远程仓库地址</Label>
            <Input
              id="cb-remote"
              value={cbRemoteUrl}
              onChange={(e) => setCbRemoteUrl(e.target.value)}
              placeholder="https://github.com/owner/repo 或 git@host:owner/repo.git"
            />
            <p className="text-xs text-muted-foreground mt-1">
              不用先 clone 到本地，跑任务时会自动从远程拉。点「完成」时先帮你检查能不能连上。
            </p>
          </div>
          <div className="flex justify-end gap-2 pt-4">
            <Button variant="ghost" onClick={() => setStep(1)} disabled={cbSubmitting}>← 上一步</Button>
            <Button variant="outline" onClick={() => submitStep2OrSkip(true)} disabled={cbSubmitting}>跳过</Button>
            <Button onClick={() => submitStep2OrSkip(false)} disabled={cbSubmitting}>
              {cbSubmitting ? "检查仓库中…" : "完成"}
            </Button>
          </div>
        </section>
      )}
    </PageShell>
  );
}
