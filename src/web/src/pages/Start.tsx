import { useState, useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { MessageSquare, FileText, ArrowRight, Loader2 } from "lucide-react";
import { api, type Project, type Codebase } from "@/hooks/useApi";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { useToast } from "@/components/Toast";

export function Start() {
  const navigate = useNavigate();
  const toast = useToast();

  // Form state
  const [mode, setMode] = useState<"choose" | "form">("choose");
  const [projects, setProjects] = useState<Project[]>([]);
  const [codebases, setCodebases] = useState<Codebase[]>([]);
  const [loadingProjects, setLoadingProjects] = useState(false);
  const [loadingCodebases, setLoadingCodebases] = useState(false);
  const [projectId, setProjectId] = useState("");
  const [codebaseId, setCodebaseId] = useState("");
  const [title, setTitle] = useState("");
  const [specMd, setSpecMd] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Load projects when switching to form mode
  useEffect(() => {
    if (mode !== "form") return;
    setLoadingProjects(true);
    api.listProjects()
      .then((ps) => {
        setProjects(ps);
        if (ps.length === 1) setProjectId(ps[0].id);
      })
      .catch((e) => toast.error(`加载项目失败：${e?.message ?? e}`))
      .finally(() => setLoadingProjects(false));
  }, [mode, toast]);

  // Load codebases when project changes
  useEffect(() => {
    if (!projectId) {
      setCodebases([]);
      setCodebaseId("");
      return;
    }
    setLoadingCodebases(true);
    api.listProjectCodebases(projectId)
      .then((cbs) => {
        setCodebases(cbs);
        if (cbs.length === 1) setCodebaseId(cbs[0].id);
        else setCodebaseId(""); // reset on project change
      })
      .catch((e) => toast.error(`加载代码库失败：${e?.message ?? e}`))
      .finally(() => setLoadingCodebases(false));
  }, [projectId, toast]);

  const canSubmit = useMemo(
    () => !submitting && projectId !== "" && title.trim() !== "",
    [submitting, projectId, title],
  );

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const req = await api.createRequirement({
        project_id: projectId,
        codebase_id: codebaseId || null,
        title: title.trim(),
        spec_md: specMd.trim() || undefined,
      });
      toast.success(`需求已创建：${req.id}`);
      navigate(`/requirements/${req.id}`);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl px-4 py-6 md:px-6 md:py-8">
      <header className="mb-6 border-b-[1.5px] border-foreground/30 pb-3">
        <h1 className="font-display text-2xl font-bold uppercase tracking-wider">开始 · START</h1>
        <p className="font-mono text-xs uppercase tracking-[0.12em] text-muted-foreground mt-1">
          提一个新需求
        </p>
      </header>

      {mode === "choose" && (
        <div className="grid gap-3 md:grid-cols-2">
          <button
            onClick={() => navigate("/chat")}
            className="group flex flex-col items-start gap-3 border-[1.5px] border-foreground/30 bg-card p-5 rounded-none text-left hover:border-accent transition-colors"
          >
            <MessageSquare className="h-6 w-6 text-accent" />
            <div className="flex-1">
              <h3 className="font-display text-base font-bold uppercase tracking-wide mb-1">对话式</h3>
              <p className="text-sm text-muted-foreground">
                "我想做 X" 自然语言描述，AI 帮你理清细节并自动建需求
              </p>
            </div>
            <div className="flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground group-hover:text-accent">
              <span>去 chat</span>
              <ArrowRight className="h-3 w-3" />
            </div>
          </button>

          <button
            onClick={() => setMode("form")}
            className="group flex flex-col items-start gap-3 border-[1.5px] border-foreground/30 bg-card p-5 rounded-none text-left hover:border-accent transition-colors"
          >
            <FileText className="h-6 w-6 text-accent" />
            <div className="flex-1">
              <h3 className="font-display text-base font-bold uppercase tracking-wide mb-1">表单式</h3>
              <p className="text-sm text-muted-foreground">
                选项目、选代码库、写标题和 spec，直接建需求
              </p>
            </div>
            <div className="flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground group-hover:text-accent">
              <span>填表单</span>
              <ArrowRight className="h-3 w-3" />
            </div>
          </button>
        </div>
      )}

      {mode === "form" && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setMode("choose")}
              className="font-mono text-[10px] uppercase tracking-[0.18em]"
            >
              ← 返回
            </Button>
          </div>

          <div className="space-y-2">
            <Label htmlFor="project" className="font-mono text-[10px] uppercase tracking-[0.18em]">项目 *</Label>
            <Select value={projectId} onValueChange={setProjectId} disabled={loadingProjects}>
              <SelectTrigger id="project">
                <SelectValue placeholder={loadingProjects ? "加载中..." : projects.length === 0 ? "暂无项目（请先在 /library 创建）" : "选择项目"} />
              </SelectTrigger>
              <SelectContent>
                {projects.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name} <span className="text-muted-foreground ml-2">{p.id}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="codebase" className="font-mono text-[10px] uppercase tracking-[0.18em]">代码库（可选）</Label>
            <Select value={codebaseId} onValueChange={setCodebaseId} disabled={!projectId || loadingCodebases}>
              <SelectTrigger id="codebase">
                <SelectValue placeholder={!projectId ? "请先选项目" : loadingCodebases ? "加载中..." : codebases.length === 0 ? "暂无代码库（可空）" : "选择代码库"} />
              </SelectTrigger>
              <SelectContent>
                {codebases.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.alias} <span className="text-muted-foreground ml-2">{c.path}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="title" className="font-mono text-[10px] uppercase tracking-[0.18em]">标题 *</Label>
            <Input
              id="title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="例：给登录页加忘记密码功能"
              className="rounded-none"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="spec" className="font-mono text-[10px] uppercase tracking-[0.18em]">规格说明（可选 · Markdown）</Label>
            <textarea
              id="spec"
              value={specMd}
              onChange={(e) => setSpecMd(e.target.value)}
              rows={8}
              placeholder="详细描述需求、约束、验收标准..."
              className="w-full font-mono text-sm border-[1.5px] border-foreground/30 bg-background px-3 py-2 rounded-none focus:outline-none focus:border-accent"
            />
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button
              variant="default"
              size="default"
              disabled={!canSubmit}
              onClick={handleSubmit}
              className="rounded-none font-mono text-[11px] uppercase tracking-[0.12em]"
            >
              {submitting ? <Loader2 className="h-4 w-4 animate-spin mr-1.5" /> : null}
              {submitting ? "创建中..." : "创建需求"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
