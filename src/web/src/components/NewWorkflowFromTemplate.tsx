import { useCallback, useEffect, useRef, useState } from "react";
import { LayoutTemplate } from "lucide-react";
import { api, type WorkflowTemplate } from "@/hooks/useApi";
import { useToast } from "@/components/Toast";
import { EmptyState, ErrorState, FormDialog, FormField, SkeletonRows } from "@/components/pro";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

// 起点（动作）与「选哪个模板」（数据）正交：mode 单值表达互斥，selectedTemplate 仅
// mode==="template" 有意义。不再用一个混用的 selected 字符串塞哨兵值 + 模板名。
type StartMode = "template" | "ai" | "import" | "scratch";

const NAME_RE = /^[\w.\-]+$/;

interface ParsedImport {
  fileName: string;
  yaml: string;
  ts: string | null;
}

interface Props {
  open: boolean;
  onCancel: () => void;
  /** 创建成功（模板 / 导入 / 从零都走这里），传新工作流名；调用方统一 navigate 到详情页 */
  onCreated: (name: string) => void;
  /** 用户选了「✨ 用 AI 创建」，调用方应该 navigate 到 /workflows/new-with-ai */
  onFromAI: () => void;
}

export function NewWorkflowFromTemplate({ open, onCancel, onCreated, onFromAI }: Props) {
  const toast = useToast();

  const [templates, setTemplates] = useState<WorkflowTemplate[]>([]);
  const [loadingTemplates, setLoadingTemplates] = useState(false);
  const [templatesError, setTemplatesError] = useState<string | null>(null);

  const [mode, setMode] = useState<StartMode>("template");
  const [selectedTemplate, setSelectedTemplate] = useState<string>("");
  const [name, setName] = useState("");
  const [nameDirty, setNameDirty] = useState(false);
  const [importFile, setImportFile] = useState<ParsedImport | null>(null);
  const [importError, setImportError] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const loadTemplates = useCallback(() => {
    setLoadingTemplates(true);
    setTemplatesError(null);
    api
      .listWorkflowTemplates()
      .then((list) => {
        setTemplates(list);
        if (list.length > 0) {
          setSelectedTemplate(list[0]!.name);
          // 初次进来默认聚焦模板路径，预填建议名
          setName((cur) => (cur ? cur : `my-${list[0]!.name}`));
        } else {
          setSelectedTemplate("");
        }
      })
      .catch((e: unknown) => setTemplatesError((e as Error)?.message ?? String(e)))
      .finally(() => setLoadingTemplates(false));
  }, []);

  // 每次打开重置为干净起点态 + 拉模板
  useEffect(() => {
    if (!open) return;
    setMode("template");
    setSelectedTemplate("");
    setName("");
    setNameDirty(false);
    setImportFile(null);
    setImportError(null);
    loadTemplates();
  }, [open, loadTemplates]);

  // ── 起点 / 模板选择 ──
  function pickTemplate(t: string) {
    setMode("template");
    setSelectedTemplate(t);
    if (!nameDirty) setName(`my-${t}`);
  }

  function pickMode(m: StartMode) {
    setMode(m);
    if (m === "scratch" && !nameDirty) setName("my-workflow");
    if (m === "import") setImportError(null);
  }

  // ── 导入文件解析（内联收名，取代 window.prompt）──
  async function handleFile(file: File | null) {
    setImportError(null);
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as { name?: string; yaml?: string; ts?: string | null };
      if (typeof parsed.name !== "string" || typeof parsed.yaml !== "string") {
        setImportFile(null);
        setImportError("文件需含 name + yaml 字段");
        return;
      }
      setImportFile({ fileName: file.name, yaml: parsed.yaml, ts: parsed.ts ?? null });
      // 预填文件里的名字，可改
      setName(parsed.name);
      setNameDirty(false);
    } catch {
      setImportFile(null);
      setImportError("不是有效的 JSON 文件");
    }
  }

  // ── 派生校验（实时；空名不报错只禁用提交，非空非法才内联报错）──
  const nameTrimmed = name.trim();
  const nameInvalid = nameTrimmed !== "" && !NAME_RE.test(nameTrimmed);
  const nameError = nameInvalid ? "只能用字母 / 数字 / . _ -" : undefined;
  const needsName = mode !== "ai";

  const submitDisabled =
    mode === "ai"
      ? false
      : (needsName && (!nameTrimmed || nameInvalid)) ||
        (mode === "template" && !selectedTemplate) ||
        (mode === "import" && !importFile);

  const submitText = mode === "ai" ? "用 AI 描述 →" : mode === "import" ? "导入并编辑" : "创建并编辑";

  async function handleSubmit() {
    if (mode === "ai") {
      onFromAI();
      return;
    }
    const finalName = nameTrimmed;
    if (mode === "template") {
      await api.createWorkflowFromTemplate({ template: selectedTemplate, name: finalName });
      toast.success(`已从模板 ${selectedTemplate} 创建 ${finalName}`);
    } else if (mode === "scratch") {
      // 从零 = 建含默认单阶段（后端 firstPhase 缺省 step1）的空工作流，落地后进详情页搭
      await api.createWorkflow({ name: finalName });
      toast.success(`已创建空白工作流 ${finalName}`);
    } else {
      if (!importFile) throw new Error("请先选择 .json 文件");
      await api.importWorkflowBundle({ name: finalName, yaml: importFile.yaml, ts: importFile.ts });
      toast.success(`已导入工作流 ${finalName}`);
    }
    onCreated(finalName);
  }

  return (
    <FormDialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onCancel();
      }}
      title="新建工作流"
      description="从内置模板起步最快；也可以用 AI 描述、导入 JSON，或从零开始搭。"
      contentClassName="sm:max-w-xl"
      submitText={submitText}
      submitDisabled={submitDisabled}
      onSubmit={handleSubmit}
    >
      {/* 主区：从模板开始（默认聚焦区） */}
      <div className="space-y-2">
        <Label className="bp-label">从模板开始</Label>
        {loadingTemplates ? (
          <SkeletonRows count={3} variant="row" />
        ) : templatesError ? (
          <ErrorState
            size="section"
            title="模板加载失败"
            detail={templatesError}
            onRetry={loadTemplates}
          />
        ) : templates.length === 0 ? (
          <EmptyState
            size="section"
            icon={LayoutTemplate}
            title="暂无内置模板"
            hint="可以用下方「AI 描述」或「从零开始」建一个空白工作流"
          />
        ) : (
          <div className="scrollbar-thin max-h-56 space-y-1.5 overflow-y-auto">
            {templates.map((t) => {
              const active = mode === "template" && selectedTemplate === t.name;
              return (
                <button
                  key={t.name}
                  type="button"
                  onClick={() => pickTemplate(t.name)}
                  className={cn(
                    "block w-full rounded-md border px-3 py-2 text-left transition-colors",
                    active ? "border-accent bg-accent/5" : "border-border hover:border-foreground/60",
                  )}
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <div className="flex min-w-0 items-baseline gap-2">
                      <span className="truncate text-sm font-bold">{t.label || t.name}</span>
                      {t.label && (
                        <span className="truncate font-mono text-[10px] text-muted-foreground">{t.name}</span>
                      )}
                    </div>
                    <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                      {t.phase_count} 阶段
                    </span>
                  </div>
                  <p className="mt-0.5 text-xs text-muted-foreground">{t.description || "（无描述）"}</p>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* 分隔：把三个少数派起点收纳到「或换个起点」之下，与模板分层 */}
      <div className="flex items-center gap-3">
        <div className="h-px flex-1 bg-border" />
        <span className="text-[11px] text-muted-foreground">或换个起点</span>
        <div className="h-px flex-1 bg-border" />
      </div>

      {/* 起点条：AI / 导入 / 从零（次要动作，横排小卡） */}
      <div className="grid grid-cols-3 gap-2">
        {([
          ["ai", "✨", "AI 描述"],
          ["import", "📦", "导入 JSON"],
          ["scratch", "⊕", "从零开始"],
        ] as const).map(([m, icon, label]) => (
          <button
            key={m}
            type="button"
            onClick={() => pickMode(m)}
            className={cn(
              "rounded-md border px-2 py-2 text-center transition-colors",
              mode === m ? "border-accent bg-accent/5" : "border-border hover:border-foreground/60",
            )}
          >
            <div className="text-base leading-none">{icon}</div>
            <div className="mt-1 text-xs font-medium">{label}</div>
          </button>
        ))}
      </div>

      {/* AI 起点：不在此填名，给说明条 + CTA 跳路由 */}
      {mode === "ai" && (
        <p className="rounded-md border border-border bg-muted/30 px-3 py-2.5 text-xs text-muted-foreground">
          ✨ 进入 AI 工作流生成页，用自然语言描述你要的流程，AI 生成 yaml + ts。点下方「用 AI 描述 →」继续。
        </p>
      )}

      {/* 导入起点：文件选择器（解析成功后下方出现命名输入） */}
      {mode === "import" && (
        <div className="space-y-1.5">
          <Label className="bp-label">工作流文件</Label>
          <div className="flex items-center gap-2">
            <Button type="button" variant="secondary" size="sm" onClick={() => fileInputRef.current?.click()}>
              {importFile ? "重新选择" : "选择 .json 文件"}
            </Button>
            <span className="min-w-0 truncate text-xs text-muted-foreground">
              {importFile ? `✓ ${importFile.fileName}` : "尚未选择"}
            </span>
            <input
              ref={fileInputRef}
              type="file"
              accept=".json,application/json"
              className="hidden"
              onChange={(e) => {
                void handleFile(e.target.files?.[0] ?? null);
                e.target.value = ""; // 允许重选同一文件再次触发 onChange
              }}
            />
          </div>
          {importError ? (
            <p className="text-xs text-destructive">{importError}</p>
          ) : (
            <p className="text-xs text-muted-foreground">导入别人导出的 .workflow.json（含 yaml + ts）</p>
          )}
        </div>
      )}

      {/* 命名区：模板 / 从零 / 导入（解析成功后）共用同一 FormField + 校验 */}
      {needsName && (mode !== "import" || importFile) && (
        <FormField
          label="新工作流名字"
          htmlFor="wf-name"
          hint="字母 / 数字 / . _ -，将作为工作流目录名"
          error={nameError}
        >
          <Input
            id="wf-name"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setNameDirty(true);
            }}
            placeholder="my-dev"
            className="font-mono"
            aria-invalid={nameInvalid || undefined}
          />
        </FormField>
      )}
    </FormDialog>
  );
}
