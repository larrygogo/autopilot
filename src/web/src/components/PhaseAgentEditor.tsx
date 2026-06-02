import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Bot, RotateCcw, PlayCircle } from "lucide-react";
import { api, type InlineAgentConfig, type ProviderModelsResult } from "../hooks/useApi";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ModelCombobox } from "@/components/ModelCombobox";
import { AgentDryRunDialog } from "@/components/AgentDryRunDialog";

// ──────────────────────────────────────────────
// Phase 内联 agent 配置编辑器
//
// 命名复用 agent 删除后，每个 phase 直接挂一个内联 agent 对象（provider/model/
// system_prompt/max_turns/permission_mode）。省略整段 = phase 没有 `agent` 字段
// → 运行时走 DEFAULT_AGENT 兜底。
//
// markup / 样式沿用原 WorkflowAgentDialog 的表单，保持视觉一致。
// ──────────────────────────────────────────────

const PROVIDERS = ["anthropic", "openai", "google"] as const;
const PERMISSION_MODES = ["auto", "ask", "readonly", "deny"] as const;
const DEFAULT_VALUE = "__default__";

interface Props {
  /** 当前 phase 上的内联 agent 配置；无则 undefined（= 用默认 agent） */
  agent: InlineAgentConfig | undefined;
  /** 写回 phase.agent；传 undefined 表示清空该字段（回到默认 agent） */
  onChange: (next: InlineAgentConfig | undefined) => void;
  /** 试跑对话框标题里展示的 phase 名（可选） */
  phaseName?: string;
}

/** 把 phase.agent 原始值规整成 InlineAgentConfig（兼容历史里 agent 是字符串名的旧数据 → 丢弃，回到默认） */
function normalizeInline(raw: unknown): InlineAgentConfig | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const a = raw as Record<string, unknown>;
  const out: InlineAgentConfig = {};
  if (typeof a.provider === "string") out.provider = a.provider;
  if (typeof a.model === "string") out.model = a.model;
  if (typeof a.max_turns === "number") out.max_turns = a.max_turns;
  if (typeof a.permission_mode === "string") out.permission_mode = a.permission_mode;
  if (typeof a.system_prompt === "string") out.system_prompt = a.system_prompt;
  return Object.keys(out).length > 0 ? out : {};
}

export function PhaseAgentEditor({ agent, onChange, phaseName }: Props) {
  const inline = normalizeInline(agent);
  const configured = inline !== undefined;

  // 展开/收起：已配置时默认展开，未配置时默认收起
  const [expanded, setExpanded] = useState(configured);
  const [models, setModels] = useState<Record<string, ProviderModelsResult>>({});
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState(false);
  const [dryRunOpen, setDryRunOpen] = useState(false);

  // 切换 phase 时（configured 变化）重置展开态
  useEffect(() => {
    setExpanded(configured);
    // configured 作为依赖即可：phase 切换会带来其 agent 配置有无的变化
    // eslint-disable-line react-hooks/exhaustive-deps
  }, [configured]);

  // 展开时拉三家 provider 的模型列表（给 ModelCombobox 选项）
  useEffect(() => {
    if (!expanded) return;
    setModelsLoading(true);
    setModelsError(false);
    Promise.all(PROVIDERS.map((n) => api.getProviderModels(n).catch(() => null)))
      .then((list) => {
        const map: Record<string, ProviderModelsResult> = {};
        let any = false;
        for (const r of list) {
          if (r) { map[r.name] = r; any = true; }
        }
        setModels(map);
        if (!any) setModelsError(true);
      })
      .catch(() => setModelsError(true))
      .finally(() => setModelsLoading(false));
  }, [expanded]);

  const draft = inline ?? {};

  /** 改某字段：phase 之前没 agent 字段时，先以空对象起步再写入 */
  function update<K extends keyof InlineAgentConfig>(key: K, value: InlineAgentConfig[K]) {
    const base: InlineAgentConfig = { ...(inline ?? {}) };
    if (value === undefined || value === "" || (typeof value === "number" && Number.isNaN(value))) {
      delete base[key];
    } else {
      base[key] = value;
    }
    onChange(base);
  }

  function enableConfig() {
    onChange({});
    setExpanded(true);
  }

  function resetToDefault() {
    onChange(undefined);
    setExpanded(false);
  }

  return (
    <section className="border-t border-dashed border-foreground/25 pt-3">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground hover:text-foreground"
      >
        {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        <Bot className="h-3.5 w-3.5" />
        <span>智能体 · agent</span>
        <span
          className={
            configured
              ? "ml-auto rounded-none border border-accent/40 bg-accent/5 px-1 py-px text-[9px] normal-case tracking-normal text-accent"
              : "ml-auto rounded-none border border-foreground/25 bg-muted/40 px-1 py-px text-[9px] normal-case tracking-normal text-muted-foreground"
          }
        >
          {configured ? "已自定义" : "默认 agent"}
        </span>
      </button>

      {!configured && !expanded && (
        <p className="mt-1.5 text-[10px] text-muted-foreground">
          使用默认 agent（DEFAULT_AGENT）：anthropic / claude-sonnet-4-6。
          展开可为本阶段单独覆盖 provider / 模型 / 系统提示词等。
        </p>
      )}

      {expanded && (
        <div className="mt-2 space-y-3">
          {!configured ? (
            <div className="border-[1.5px] border-dashed border-foreground/30 bg-muted/30 p-3">
              <p className="text-[11px] text-muted-foreground">
                本阶段未配置内联 agent，运行时使用默认 agent（DEFAULT_AGENT）。
                点下方按钮开始为本阶段单独配置。
              </p>
              <Button variant="outline" size="sm" className="mt-2 h-7" onClick={enableConfig}>
                <Bot className="h-3.5 w-3.5" />
                为本阶段配置 agent
              </Button>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                    提供商 (provider)
                  </Label>
                  <Select
                    value={draft.provider ?? DEFAULT_VALUE}
                    onValueChange={(v) => update("provider", v === DEFAULT_VALUE ? undefined : v)}
                  >
                    <SelectTrigger className="h-8 text-sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={DEFAULT_VALUE}>（默认 · anthropic）</SelectItem>
                      {PROVIDERS.map((p) => (
                        <SelectItem key={p} value={p}>{p}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <Label className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                    最大轮数 (max_turns)
                  </Label>
                  <Input
                    type="number"
                    min={1}
                    placeholder="留空走默认"
                    value={draft.max_turns ?? ""}
                    onChange={(e) =>
                      update("max_turns", e.target.value ? parseInt(e.target.value, 10) : undefined)
                    }
                    className="h-8 font-mono text-sm"
                  />
                </div>

                <div className="space-y-1.5">
                  <Label className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                    模型 (model)
                  </Label>
                  <ModelCombobox
                    value={draft.model}
                    onChange={(v) => update("model", v)}
                    options={draft.provider ? models[draft.provider]?.models ?? [] : []}
                    placeholder={
                      modelsLoading ? "加载模型…" : draft.provider ? "留空走 provider 默认" : "先选 provider"
                    }
                    clearable
                    disabled={!draft.provider}
                  />
                  {modelsError && (
                    <p className="text-[10px] text-warning">模型列表加载失败，可手动输入模型名</p>
                  )}
                </div>

                <div className="space-y-1.5">
                  <Label className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                    权限模式 (permission_mode)
                  </Label>
                  <Select
                    value={draft.permission_mode ?? DEFAULT_VALUE}
                    onValueChange={(v) =>
                      update("permission_mode", v === DEFAULT_VALUE ? undefined : v)
                    }
                  >
                    <SelectTrigger className="h-8 text-sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={DEFAULT_VALUE}>（默认 · auto）</SelectItem>
                      {PERMISSION_MODES.map((p) => (
                        <SelectItem key={p} value={p}>{p}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="space-y-1.5">
                <Label className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                  系统提示词 (system_prompt)
                </Label>
                <Textarea
                  className="min-h-[120px] resize-y font-mono text-[11px] leading-relaxed"
                  placeholder="本阶段特化的 agent 系统提示词。留空则沿用默认 agent 的 system_prompt。"
                  value={draft.system_prompt ?? ""}
                  onChange={(e) => update("system_prompt", e.target.value || undefined)}
                  spellCheck={false}
                />
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-[10px] text-muted-foreground">
                  改完点流水线底部「保存修改」生效。空字段沿用默认 agent。
                </p>
                <div className="flex items-center gap-1.5">
                  <Button variant="outline" size="sm" className="h-7" onClick={() => setDryRunOpen(true)}>
                    <PlayCircle className="h-3.5 w-3.5" />
                    试跑
                  </Button>
                  <Button variant="ghost" size="sm" className="h-7" onClick={resetToDefault}>
                    <RotateCcw className="h-3.5 w-3.5" />
                    恢复默认
                  </Button>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      <AgentDryRunDialog
        open={dryRunOpen}
        onClose={() => setDryRunOpen(false)}
        agent={inline}
        title={phaseName}
      />
    </section>
  );
}
