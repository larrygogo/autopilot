import React, { useEffect, useState } from "react";
import { api, type ProviderModelsResult } from "../hooks/useApi";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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

export interface WorkflowAgentDraft {
  name: string;
  extends?: string;
  provider?: string;
  model?: string;
  max_turns?: number;
  permission_mode?: string;
  system_prompt?: string;
}

const NAME_RE = /^[\w.\-]+$/;
const PROVIDERS = ["anthropic", "openai", "google"] as const;
const PERMISSION_MODES = ["auto", "ask", "readonly", "deny"] as const;

const INHERIT_VALUE = "__inherit__";

interface Props {
  open: boolean;
  onClose: () => void;
  onSubmit: (value: WorkflowAgentDraft) => void | Promise<void>;
  /** 编辑时传入原值；新建时不传 */
  initial?: WorkflowAgentDraft;
  /** 全局 agent 名称列表，extends 下拉用 */
  globalAgentNames: string[];
  /** 当前工作流其他 agent 的 name（用于重名校验） */
  existingOtherNames: string[];
}

export function WorkflowAgentDialog({
  open,
  onClose,
  onSubmit,
  initial,
  globalAgentNames,
  existingOtherNames,
}: Props) {
  const [draft, setDraft] = useState<WorkflowAgentDraft>(initial ?? { name: "" });
  const [busy, setBusy] = useState(false);
  const [models, setModels] = useState<Record<string, ProviderModelsResult>>({});

  useEffect(() => {
    if (open) setDraft(initial ?? { name: "" });
  }, [open, initial]);

  useEffect(() => {
    if (!open) return;
    const names = ["anthropic", "openai", "google"];
    Promise.all(names.map((n) => api.getProviderModels(n).catch(() => null))).then((list) => {
      const map: Record<string, ProviderModelsResult> = {};
      for (const r of list) if (r) map[r.name] = r;
      setModels(map);
    });
  }, [open]);

  const nameValid = NAME_RE.test(draft.name);
  const nameUnique = !existingOtherNames.includes(draft.name);
  const canSubmit = nameValid && nameUnique && !busy;

  const update = <K extends keyof WorkflowAgentDraft>(key: K, value: WorkflowAgentDraft[K]) => {
    setDraft((d) => ({ ...d, [key]: value }));
  };

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    try {
      // 清空字符串字段以便忽略
      const cleaned: WorkflowAgentDraft = { name: draft.name };
      if (draft.extends) cleaned.extends = draft.extends;
      if (draft.provider) cleaned.provider = draft.provider;
      if (draft.model) cleaned.model = draft.model;
      if (typeof draft.max_turns === "number" && draft.max_turns > 0)
        cleaned.max_turns = draft.max_turns;
      if (draft.permission_mode) cleaned.permission_mode = draft.permission_mode;
      if (draft.system_prompt) cleaned.system_prompt = draft.system_prompt;
      await onSubmit(cleaned);
    } finally {
      setBusy(false);
    }
  };

  const extendsDescribed = draft.extends
    ? `继承全局 agent "${draft.extends}"，未填字段走该基底`
    : draft.name && globalAgentNames.includes(draft.name)
      ? `默认继承同名全局 agent "${draft.name}"（可在下方填 extends 指定别的基底）`
      : "无继承基底，必须填 provider（否则运行时报错）";

  const nameError =
    draft.name && !nameValid && !initial
      ? "仅允许字母、数字、._-"
      : draft.name && nameValid && !nameUnique && !initial
        ? "该名称已在当前工作流中使用"
        : null;

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v && !busy) onClose();
      }}
    >
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{initial ? `编辑智能体：${initial.name}` : "添加智能体"}</DialogTitle>
          <DialogDescription>
            工作流内对全局 agent 的覆盖；未填字段沿用基底定义。
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[65vh] space-y-4 overflow-y-auto py-1 pr-1">
          <div className="space-y-1.5">
            <Label htmlFor="wfa-name">
              名称 <span className="text-destructive">*</span>
            </Label>
            <Input
              id="wfa-name"
              className={
                nameError
                  ? "font-mono border-destructive focus-visible:ring-destructive"
                  : "font-mono"
              }
              placeholder="coder"
              value={draft.name}
              onChange={(e) => update("name", e.target.value)}
              disabled={!!initial}
              autoFocus={!initial}
            />
            {initial ? (
              <p className="text-xs text-muted-foreground">改名请删除后重建</p>
            ) : nameError ? (
              <p className="text-xs text-destructive">{nameError}</p>
            ) : null}
          </div>

          <div className="space-y-1.5">
            <Label>继承自（extends）</Label>
            <Select
              value={draft.extends ?? INHERIT_VALUE}
              onValueChange={(v) => update("extends", v === INHERIT_VALUE ? undefined : v)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={INHERIT_VALUE}>（默认同名继承 / 留空）</SelectItem>
                {globalAgentNames.map((n) => (
                  <SelectItem key={n} value={n}>
                    {n}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{extendsDescribed}</p>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>提供商（仅在无继承时必填）</Label>
              <Select
                value={draft.provider ?? INHERIT_VALUE}
                onValueChange={(v) => update("provider", v === INHERIT_VALUE ? undefined : v)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={INHERIT_VALUE}>（继承）</SelectItem>
                  {PROVIDERS.map((p) => (
                    <SelectItem key={p} value={p}>
                      {p}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="wfa-turns">最大轮数</Label>
              <Input
                id="wfa-turns"
                type="number"
                min={1}
                placeholder="留空继承"
                value={draft.max_turns ?? ""}
                onChange={(e) =>
                  update("max_turns", e.target.value ? parseInt(e.target.value, 10) : undefined)
                }
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="wfa-model">模型（留空继承）</Label>
              <Input
                id="wfa-model"
                className="font-mono"
                placeholder="claude-sonnet-4-6"
                list={draft.provider ? `wf-agent-models-${draft.provider}` : undefined}
                value={draft.model ?? ""}
                onChange={(e) => update("model", e.target.value || undefined)}
              />
              {draft.provider && models[draft.provider] && (
                <datalist id={`wf-agent-models-${draft.provider}`}>
                  {models[draft.provider].models.map((m) => (
                    <option key={m} value={m} />
                  ))}
                </datalist>
              )}
            </div>

            <div className="space-y-1.5">
              <Label>权限模式</Label>
              <Select
                value={draft.permission_mode ?? INHERIT_VALUE}
                onValueChange={(v) =>
                  update("permission_mode", v === INHERIT_VALUE ? undefined : v)
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={INHERIT_VALUE}>（继承）</SelectItem>
                  {PERMISSION_MODES.map((p) => (
                    <SelectItem key={p} value={p}>
                      {p}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="wfa-prompt">系统提示词（留空继承）</Label>
            <Textarea
              id="wfa-prompt"
              className="min-h-[160px] font-mono text-xs"
              placeholder="工作流内特化提示词。留空则沿用全局同名 agent 的 system_prompt。"
              value={draft.system_prompt ?? ""}
              onChange={(e) => update("system_prompt", e.target.value || undefined)}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button onClick={submit} disabled={!canSubmit}>
            {busy ? "保存中…" : "保存"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
