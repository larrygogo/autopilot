import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Bot, RotateCcw, PlayCircle } from "lucide-react";
import { api, type InlineAgentConfig, type ProviderModelsResult, type ProviderExtendedInfo } from "../hooks/useApi";
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

const DEFAULT_VALUE = "__default__";

// 能拉模型列表的 provider（model-list 仅支持官方三家；compat 走手动输入模型名）
const MODEL_LIST_PROVIDERS = ["anthropic", "openai", "google"] as const;

// permission_mode：cli（透传 Claude Code --permission-mode）与 api（内置工具执行器分级）
// 两套值合并为一个列表，default / bypassPermissions 两边共有合一，各自独有的标注适用模式。
// 中文 label 仅展示，写回 yaml 用 value 原值。
const PERMISSION_MODES = [
  { value: "default", label: "默认 · 危险操作有防护" },
  { value: "acceptEdits", label: "自动接受编辑（CLI）" },
  { value: "plan", label: "计划模式 · 只读规划（CLI）" },
  { value: "cautious", label: "谨慎 · 禁用 bash（API）" },
  { value: "bypassPermissions", label: "跳过所有确认 · 放开" },
] as const;

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
  if (a.mode === "cli" || a.mode === "api") out.mode = a.mode;
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
  const [providers, setProviders] = useState<ProviderExtendedInfo[]>([]);
  const [dryRunOpen, setDryRunOpen] = useState(false);

  // 切换 phase 时（configured 变化）重置展开态
  useEffect(() => {
    setExpanded(configured);
    // configured 作为依赖即可：phase 切换会带来其 agent 配置有无的变化
    // eslint-disable-line react-hooks/exhaustive-deps
  }, [configured]);

  // 展开时拉可选 provider 列表（官方 + compat 预置 + config 自定义）
  useEffect(() => {
    if (!expanded) return;
    api.listProvidersExtended().then(setProviders).catch(() => setProviders([]));
  }, [expanded]);

  // 展开时拉官方三家 provider 的模型列表（给 ModelCombobox 选项；compat 走手动输入）
  useEffect(() => {
    if (!expanded) return;
    setModelsLoading(true);
    setModelsError(false);
    Promise.all(MODEL_LIST_PROVIDERS.map((n) => api.getProviderModels(n).catch(() => null)))
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

  // 历史/未知值（如老副本写的 auto）：原样显示标「历史值」，不偷改
  const permValues = PERMISSION_MODES.map((o) => o.value) as readonly string[];
  const permIsHistorical = !!draft.permission_mode && !permValues.includes(draft.permission_mode);

  function enableConfig() {
    onChange({});
    setExpanded(true);
  }

  function resetToDefault() {
    onChange(undefined);
    setExpanded(false);
  }

  return (
    <section className="border-t border-border pt-3">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="bp-label flex w-full items-center gap-2 text-[10px] text-muted-foreground hover:text-foreground"
      >
        {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        <Bot className="h-3.5 w-3.5" />
        <span>智能体 · agent</span>
        <span
          className={
            configured
              ? "ml-auto rounded-md border border-accent/40 bg-accent/5 px-1 py-px text-[9px] normal-case tracking-normal text-accent"
              : "ml-auto rounded-md border border-border bg-muted/40 px-1 py-px text-[9px] normal-case tracking-normal text-muted-foreground"
          }
        >
          {configured ? "已自定义" : "默认 agent"}
        </span>
      </button>

      {!configured && !expanded && (
        <p className="mt-1.5 text-[10px] text-muted-foreground">
          用默认 agent（anthropic / claude-sonnet-4-6）。展开可以给这个阶段单独换提供商、模型、提示词。
        </p>
      )}

      {expanded && (
        <div className="mt-2 space-y-3">
          {!configured ? (
            <div className="rounded-lg border border-border bg-muted/30 p-3">
              <p className="text-[11px] text-muted-foreground">
                这个阶段还没单独配 agent，会用默认的（anthropic / claude-sonnet-4-6）。想单独配就点下面。
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
                  <Label className="bp-label text-[10px] text-muted-foreground">提供商</Label>
                  <Select
                    value={draft.provider ?? DEFAULT_VALUE}
                    onValueChange={(v) => update("provider", v === DEFAULT_VALUE ? undefined : v)}
                  >
                    <SelectTrigger className="h-8 text-sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={DEFAULT_VALUE}>默认 · anthropic</SelectItem>
                      {providers.map((p) => (
                        <SelectItem key={p.name} value={p.name}>
                          {p.display_name}
                          {p.api_only ? " · API" : ""}
                          {!p.has_api_key && p.api_only ? "（未配密钥）" : ""}
                        </SelectItem>
                      ))}
                      {/* 当前值不在列表（自定义已删 / 列表未加载完）→ 原样显示，不丢选中态 */}
                      {draft.provider && !providers.some((p) => p.name === draft.provider) && (
                        <SelectItem value={draft.provider}>{draft.provider}</SelectItem>
                      )}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <Label className="bp-label text-[10px] text-muted-foreground">模型</Label>
                  <ModelCombobox
                    value={draft.model}
                    onChange={(v) => update("model", v)}
                    options={draft.provider ? models[draft.provider]?.models ?? [] : []}
                    placeholder={
                      modelsLoading ? "加载模型…" : draft.provider ? "留空用默认模型" : "先选提供商"
                    }
                    clearable
                    disabled={!draft.provider}
                  />
                  {modelsError && (
                    <p className="text-[10px] text-warning">模型列表加载失败，直接手输模型名也行</p>
                  )}
                </div>

                <div className="space-y-1.5">
                  <Label className="bp-label text-[10px] text-muted-foreground">最大轮数</Label>
                  <Input
                    type="number"
                    min={1}
                    placeholder="留空用默认"
                    value={draft.max_turns ?? ""}
                    onChange={(e) =>
                      update("max_turns", e.target.value ? parseInt(e.target.value, 10) : undefined)
                    }
                    className="h-8 font-mono text-sm"
                  />
                </div>

                <div className="space-y-1.5">
                  <Label className="bp-label text-[10px] text-muted-foreground">权限模式</Label>
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
                      <SelectItem value={DEFAULT_VALUE}>默认（不设就用内置）</SelectItem>
                      {PERMISSION_MODES.map((p) => (
                        <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>
                      ))}
                      {permIsHistorical && (
                        <SelectItem value={draft.permission_mode!}>
                          {draft.permission_mode}（历史值）
                        </SelectItem>
                      )}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="space-y-1.5">
                <Label className="bp-label text-[10px] text-muted-foreground">
                  系统提示词 (system_prompt)
                </Label>
                <Textarea
                  className="min-h-[120px] resize-y font-mono text-[11px] leading-relaxed"
                  placeholder="这个阶段专用的提示词。留空就用默认 agent 的。"
                  value={draft.system_prompt ?? ""}
                  onChange={(e) => update("system_prompt", e.target.value || undefined)}
                  spellCheck={false}
                />
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-[10px] text-muted-foreground">
                  改完点流水线底部的「保存修改」。没填的项用默认 agent。
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
