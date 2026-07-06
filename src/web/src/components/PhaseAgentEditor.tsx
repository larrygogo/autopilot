import { useEffect, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, Bot, PlayCircle } from "lucide-react";
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
// Phase 智能体卡：把「模型 + 任务 + 角色 + 高级」合成一张卡。
//
// 用户决策（2026-06）：每个 phase 一定有一个智能体（不存在「不配 agent」的状态），
// 人设与任务是同一个智能体的两面，应在一张卡里就近配置，不再拆成两个相隔的模块。
// 卡内顺序：模型 → 角色设定 → 任务 → 高级 → 试跑（先定人设，再写任务）。
//   - 模型 / 提供商「常驻显示」当前生效值（默认也明确亮出来，不留空隐式），放在最前；
//     且彻底显式——defaultAgent 加载后把默认 model/provider 固化进 draft，保存即写进 spec。
//   - 角色设定（system_prompt）独立折叠，放在任务之上；
//   - 任务（taskSlot：写提示词 / 写执行函数）由外部构建后嵌入，紧跟角色设定；
//   - 高级（权限 / 最大轮数）折叠。
// ──────────────────────────────────────────────

const DEFAULT_VALUE = "__default__";

// 能拉模型列表的 provider（model-list 仅支持官方三家；compat 走手动输入模型名）
const MODEL_LIST_PROVIDERS = ["anthropic", "openai", "google"] as const;

// permission_mode：cli（透传 Claude Code --permission-mode）与 api（内置工具执行器分级）
// 两套值合并为一个列表，default / bypassPermissions 两边共有合一，各自独有的标注适用模式。
const PERMISSION_MODES = [
  { value: "default", label: "默认 · 危险操作有防护" },
  { value: "acceptEdits", label: "自动接受编辑（CLI）" },
  { value: "plan", label: "计划模式 · 只读规划（CLI）" },
  { value: "cautious", label: "谨慎 · 禁用 bash（API）" },
  { value: "bypassPermissions", label: "跳过所有确认 · 放开" },
] as const;

interface Props {
  /** 当前 phase 上的内联 agent 配置；无则 undefined（首次加载会被固化默认补齐） */
  agent: InlineAgentConfig | undefined;
  /** 写回 phase.agent */
  onChange: (next: InlineAgentConfig | undefined) => void;
  /** 试跑对话框标题里展示的 phase 名（可选） */
  phaseName?: string;
  /** 任务编辑区（写提示词 / 写执行函数）；由外部构建后嵌入卡片，紧跟模型之后 */
  taskSlot?: ReactNode;
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

export function PhaseAgentEditor({ agent, onChange, phaseName, taskSlot }: Props) {
  const inline = normalizeInline(agent);
  const draft = inline ?? {};

  const [roleOpen, setRoleOpen] = useState(true);
  const [advOpen, setAdvOpen] = useState(false);
  const [models, setModels] = useState<Record<string, ProviderModelsResult>>({});
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState(false);
  const [providers, setProviders] = useState<ProviderExtendedInfo[]>([]);
  const [dryRunOpen, setDryRunOpen] = useState(false);
  // 默认 agent（模型/角色/权限留空时实际生效的值）——常驻拉，用于显示+固化
  const [defaultAgent, setDefaultAgent] = useState<InlineAgentConfig | null>(null);

  // 常驻拉 provider 列表 + 默认 agent（模型/提供商常驻显示需要，不再等展开）
  useEffect(() => {
    api.listProvidersExtended().then(setProviders).catch(() => setProviders([]));
    api.getDefaultAgent().then(setDefaultAgent).catch(() => {});
  }, []);

  // 常驻拉官方三家模型列表（给 ModelCombobox 选项；compat 走手输）
  useEffect(() => {
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
  }, []);

  // 彻底显式：default 加载后，phase 没显式写 model/provider 的，固化默认进 draft（保存即写 spec）。
  // 用户要的「即使默认也写出来」——打开阶段就把生效值固化成显式值，不再有「留空=默认」的隐式态。
  useEffect(() => {
    if (!defaultAgent) return;
    const base: InlineAgentConfig = { ...(inline ?? {}) };
    let changed = false;
    if (!base.provider && defaultAgent.provider) { base.provider = defaultAgent.provider; changed = true; }
    if (!base.model && defaultAgent.model) { base.model = defaultAgent.model; changed = true; }
    if (changed) onChange(base);
    // 仅在 default 到位 / phase 切换时固化
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultAgent, phaseName]);

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

  /** 切换提供商：连带把模型重置为新提供商的默认模型（拿不到则清空，让用户从新列表里选），
   *  避免「改了提供商、模型还停在旧提供商的模型」的错位。 */
  function changeProvider(next: string | undefined) {
    const base: InlineAgentConfig = { ...(inline ?? {}) };
    if (next === undefined) {
      delete base.provider;
      if (defaultAgent?.model) base.model = defaultAgent.model;
      else delete base.model;
    } else {
      base.provider = next;
      const pdm = providers.find((p) => p.name === next)?.default_model;
      if (pdm) base.model = pdm;
      else delete base.model;
    }
    onChange(base);
  }

  const permValues = PERMISSION_MODES.map((o) => o.value) as readonly string[];
  const permIsHistorical = !!draft.permission_mode && !permValues.includes(draft.permission_mode);
  // 生效值（draft 优先，回退默认）——模型/提供商常驻总显示一个具体值
  const effProvider = draft.provider ?? defaultAgent?.provider;
  // 模型生效值：显式 model 优先；否则——用默认提供商时回退全局默认模型，
  // 用显式提供商时回退到「该提供商的 default_model」（避免显示成别的提供商的模型）。
  const providerDefaultModel = providers.find((p) => p.name === effProvider)?.default_model;
  const effModel = draft.model ?? (draft.provider === undefined ? defaultAgent?.model : providerDefaultModel);

  return (
    <section className="space-y-3 rounded-lg border border-border p-3">
      {/* 常驻：提供商 + 模型（提供商在前；切提供商即重置为其默认模型），放在卡片最前 */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label className="bp-label text-[10px] text-muted-foreground">提供商</Label>
          <Select
            value={effProvider ?? DEFAULT_VALUE}
            onValueChange={(v) => changeProvider(v === DEFAULT_VALUE ? undefined : v)}
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
              {effProvider && !providers.some((p) => p.name === effProvider) && (
                <SelectItem value={effProvider}>{effProvider}</SelectItem>
              )}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label className="bp-label flex items-center gap-1.5 text-[10px] text-muted-foreground">
            <Bot className="h-3.5 w-3.5" /> 模型
          </Label>
          <ModelCombobox
            value={effModel}
            onChange={(v) => update("model", v || undefined)}
            options={effProvider ? models[effProvider]?.models ?? [] : []}
            placeholder={modelsLoading ? "加载模型…" : "选模型"}
            disabled={!effProvider}
          />
          {modelsError && (
            <p className="text-[10px] text-warning">模型列表加载失败，直接手输模型名也行</p>
          )}
        </div>
      </div>

      {/* 折叠：角色设定（放在任务之上：先定人设，再写任务） */}
      <div className="border-t border-border pt-2">
        <button
          type="button"
          onClick={() => setRoleOpen((v) => !v)}
          className="bp-label flex w-full items-center gap-2 text-[10px] text-muted-foreground hover:text-foreground"
        >
          {roleOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          <span>角色设定</span>
        </button>
        {roleOpen && (
          <Textarea
            className="mt-2 min-h-[120px] resize-y text-sm leading-relaxed"
            placeholder="AI 扮演谁（如「资深架构师」）。留空就用默认。"
            // 留空时预填默认人设（可编辑黑字）；保存时「值==默认」按留空处理，不把默认烤进 spec
            value={draft.system_prompt ?? defaultAgent?.system_prompt ?? ""}
            onChange={(e) => {
              const v = e.target.value;
              update("system_prompt", v && v !== defaultAgent?.system_prompt ? v : undefined);
            }}
            spellCheck={false}
          />
        )}
      </div>

      {/* 任务（写提示词 / 写执行函数）：放在角色设定之下，由外部构建后嵌入 */}
      {taskSlot}

      {/* 折叠：高级（权限 / 最大轮数） */}
      <div className="border-t border-border pt-2">
        <button
          type="button"
          onClick={() => setAdvOpen((v) => !v)}
          className="bp-label flex w-full items-center gap-2 text-[10px] text-muted-foreground hover:text-foreground"
        >
          {advOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          <span>高级（权限 · 最大轮数）</span>
        </button>
        {advOpen && (
          <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label className="bp-label text-[10px] text-muted-foreground">最大轮数</Label>
              <Input
                type="number"
                min={1}
                placeholder={defaultAgent?.max_turns != null ? `留空用默认（${defaultAgent.max_turns}）` : "留空用默认"}
                value={draft.max_turns ?? ""}
                onChange={(e) => update("max_turns", e.target.value ? parseInt(e.target.value, 10) : undefined)}
                className="h-8 font-mono text-sm"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="bp-label text-[10px] text-muted-foreground">权限模式</Label>
              <Select
                value={draft.permission_mode ?? DEFAULT_VALUE}
                onValueChange={(v) => update("permission_mode", v === DEFAULT_VALUE ? undefined : v)}
              >
                <SelectTrigger className="h-8 text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={DEFAULT_VALUE}>默认（{defaultAgent?.permission_mode ?? "内置"}）</SelectItem>
                  {PERMISSION_MODES.map((p) => (
                    <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>
                  ))}
                  {permIsHistorical && (
                    <SelectItem value={draft.permission_mode!}>{draft.permission_mode}（历史值）</SelectItem>
                  )}
                </SelectContent>
              </Select>
            </div>
          </div>
        )}
      </div>

      <div className="flex items-center justify-end">
        <Button variant="outline" size="sm" className="h-7" onClick={() => setDryRunOpen(true)}>
          <PlayCircle className="h-3.5 w-3.5" />
          试跑
        </Button>
      </div>

      <AgentDryRunDialog
        open={dryRunOpen}
        onClose={() => setDryRunOpen(false)}
        agent={inline}
        title={phaseName}
      />
    </section>
  );
}
