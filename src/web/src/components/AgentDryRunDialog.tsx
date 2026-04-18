import React, { useEffect, useState } from "react";
import { Copy } from "lucide-react";
import { api, type AgentItem, type ProviderModelsResult } from "../hooks/useApi";
import { useToast } from "./Toast";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input, Textarea } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface Props {
  open: boolean;
  onClose: () => void;
  agent: AgentItem | null;
}

interface RunResult {
  elapsed_ms: number;
  text: string;
  usage?: { input_tokens?: number; output_tokens?: number; total_cost_usd?: number };
}

export function AgentDryRunDialog({ open, onClose, agent }: Props) {
  const toast = useToast();
  const [prompt, setPrompt] = useState("");
  const [additionalSystem, setAdditionalSystem] = useState("");
  const [modelOverride, setModelOverride] = useState("");
  const [maxTurns, setMaxTurns] = useState<string>("");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<RunResult | null>(null);
  const [models, setModels] = useState<ProviderModelsResult | null>(null);

  // 打开时重置
  useEffect(() => {
    if (open) {
      setPrompt("");
      setAdditionalSystem("");
      setModelOverride("");
      setMaxTurns("");
      setResult(null);
    }
  }, [open, agent?.name]);

  // 加载 provider 对应的模型列表（只在有 provider 时）
  useEffect(() => {
    if (!open || !agent?.provider) {
      setModels(null);
      return;
    }
    api.getProviderModels(agent.provider).then(setModels).catch(() => setModels(null));
  }, [open, agent?.provider]);

  if (!agent) return null;

  const canRun = prompt.trim().length > 0 && !running;

  const run = async () => {
    if (!canRun) return;
    setRunning(true);
    setResult(null);
    try {
      const turns = maxTurns ? parseInt(maxTurns, 10) : undefined;
      const body = {
        prompt,
        ...(additionalSystem ? { additional_system: additionalSystem } : {}),
        ...(modelOverride ? { model: modelOverride } : {}),
        ...(typeof turns === "number" && turns > 0 ? { max_turns: turns } : {}),
      };
      const res = await api.dryRunAgent(agent.name, body);
      setResult({
        elapsed_ms: res.elapsed_ms,
        text: res.result.text,
        usage: res.result.usage,
      });
    } catch (e: any) {
      toast.error("试跑失败", e?.message ?? String(e));
    } finally {
      setRunning(false);
    }
  };

  const copyResult = async () => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.text);
      toast.success("已复制到剪贴板");
    } catch {
      /* ignore */
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) run();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v && !running) onClose();
      }}
    >
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>试跑智能体：{agent.name}</DialogTitle>
          <DialogDescription>
            试跑不创建任务、不走工作流；失败不会影响任何运行中的任务。
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[70vh] space-y-4 overflow-y-auto py-1 pr-1">
          {/* agent 基础信息摘要 */}
          <Card className="bg-muted/40 px-3 py-2.5 text-sm">
            <div className="font-mono text-xs text-primary">
              {agent.provider ?? "—"}
              {agent.model ? ` / ${agent.model}` : ""}
              {agent.max_turns !== undefined && (
                <span className="text-muted-foreground"> · {agent.max_turns} turns</span>
              )}
            </div>
            {agent.system_prompt && (
              <p className="mt-1.5 whitespace-pre-wrap text-xs text-muted-foreground">
                {agent.system_prompt.length > 200
                  ? agent.system_prompt.slice(0, 200) + "…"
                  : agent.system_prompt}
              </p>
            )}
          </Card>

          <div className="space-y-4" onKeyDown={onKeyDown}>
            <div className="space-y-1.5">
              <Label htmlFor="dry-run-prompt">
                Prompt <span className="text-destructive">*</span>
              </Label>
              <Textarea
                id="dry-run-prompt"
                className="min-h-[140px] font-mono text-xs"
                placeholder="输入要测试的 prompt；Ctrl/Cmd + Enter 快速运行"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                autoFocus
              />
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="dry-run-model">临时覆盖模型（可选）</Label>
                <Input
                  id="dry-run-model"
                  className="font-mono"
                  placeholder={agent.model ?? "使用 agent 配置的模型"}
                  list={models ? "dry-run-models" : undefined}
                  value={modelOverride}
                  onChange={(e) => setModelOverride(e.target.value)}
                />
                {models && (
                  <datalist id="dry-run-models">
                    {models.models.map((m) => (
                      <option key={m} value={m} />
                    ))}
                  </datalist>
                )}
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="dry-run-turns">最大轮数（可选）</Label>
                <Input
                  id="dry-run-turns"
                  type="number"
                  min={1}
                  placeholder={String(agent.max_turns ?? 10)}
                  value={maxTurns}
                  onChange={(e) => setMaxTurns(e.target.value)}
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="dry-run-system">追加 system prompt（可选）</Label>
              <Textarea
                id="dry-run-system"
                className="min-h-[80px] font-mono text-xs"
                placeholder="例如：仅用中文回答 / 严格按 JSON 格式返回"
                value={additionalSystem}
                onChange={(e) => setAdditionalSystem(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                叠加到 agent 的 system_prompt 之后。
              </p>
            </div>
          </div>

          {running && (
            <Card className="bg-muted/40 px-4 py-5 text-center">
              <p className="text-sm text-muted-foreground">运行中… CLI 可能会弹出权限确认</p>
            </Card>
          )}

          {result && (
            <Card className="overflow-hidden">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2.5">
                <h3 className="text-sm font-semibold">结果</h3>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs text-muted-foreground">
                    耗时 {Math.round(result.elapsed_ms / 100) / 10}s
                    {result.usage?.input_tokens != null && ` · in ${result.usage.input_tokens}t`}
                    {result.usage?.output_tokens != null &&
                      ` · out ${result.usage.output_tokens}t`}
                    {result.usage?.total_cost_usd != null &&
                      ` · $${result.usage.total_cost_usd.toFixed(4)}`}
                  </span>
                  <Button size="sm" variant="secondary" onClick={copyResult}>
                    <Copy className="h-3.5 w-3.5" />
                    复制
                  </Button>
                </div>
              </div>
              <pre className="scrollbar-thin max-h-[40vh] overflow-auto whitespace-pre-wrap break-words bg-muted/30 px-4 py-3 font-mono text-xs leading-relaxed text-foreground">
                {result.text || "（空输出）"}
              </pre>
            </Card>
          )}
        </div>

        <DialogFooter>
          <Button variant="secondary" onClick={onClose} disabled={running}>
            {result ? "关闭" : "取消"}
          </Button>
          <Button onClick={run} disabled={!canRun}>
            {running ? "运行中…" : result ? "重新运行" : "运行"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
