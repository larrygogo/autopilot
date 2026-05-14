import { useState, useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { api, type Project, type Codebase } from "@/hooks/useApi";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { useToast } from "@/components/Toast";

const CODEBASE_NONE = "__none__";

export function Start() {
  const navigate = useNavigate();
  const toast = useToast();

  const [projects, setProjects] = useState<Project[]>([]);
  const [allCodebases, setAllCodebases] = useState<Codebase[]>([]);
  const [loadingProjects, setLoadingProjects] = useState(false);
  const [loadingCodebases, setLoadingCodebases] = useState(false);
  const [projectId, setProjectId] = useState("");
  const [codebaseId, setCodebaseId] = useState(CODEBASE_NONE);
  const [rawText, setRawText] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // 进入页面：拉 projects + codebases
  useEffect(() => {
    setLoadingProjects(true);
    api.listProjects()
      .then((ps) => {
        setProjects(ps);
        if (ps.length > 0) setProjectId(ps[0].id);
      })
      .catch((e: unknown) => toast.error("加载项目失败", (e as Error)?.message ?? String(e)))
      .finally(() => setLoadingProjects(false));

    setLoadingCodebases(true);
    api.listCodebases()
      .then((cs) => setAllCodebases(cs))
      .catch(() => setAllCodebases([]))
      .finally(() => setLoadingCodebases(false));
  }, [toast]);

  // project 切换时 reset codebase
  useEffect(() => {
    setCodebaseId(CODEBASE_NONE);
  }, [projectId]);

  // 当前 project 下的 codebases
  const filteredCodebases = useMemo(
    () => allCodebases.filter((c) => c.project_id === projectId),
    [allCodebases, projectId],
  );

  const canSubmit = useMemo(
    () => !submitting && !!projectId && rawText.trim().length > 0,
    [submitting, projectId, rawText],
  );

  async function handleSubmit() {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const cbId = codebaseId === CODEBASE_NONE ? null : codebaseId;
      const { title, spec_md } = await api.extractRequirement({
        raw_text: rawText.trim(),
        project_id: projectId,
        codebase_id: cbId,
      });
      const requirement = await api.createRequirement({
        project_id: projectId,
        codebase_id: cbId,
        title,
        spec_md,
      });
      navigate(`/requirements/${requirement.id}`);
    } catch (e: unknown) {
      toast.error("创建需求失败", (e as Error)?.message ?? String(e));
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <header className="mb-4 border-b-[1.5px] border-foreground/30 pb-3">
        <h1 className="font-display text-2xl font-bold uppercase tracking-wider">开始 · START</h1>
        <p className="font-mono text-xs uppercase tracking-[0.12em] text-muted-foreground mt-1">
          说说你想做什么，AI 帮你整理成需求
        </p>
      </header>

      <div className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="project" className="font-mono text-[10px] uppercase tracking-[0.18em]">项目 *</Label>
          <Select value={projectId} onValueChange={setProjectId} disabled={loadingProjects || projects.length <= 1}>
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
              <SelectValue placeholder={!projectId ? "请先选项目" : loadingCodebases ? "加载中..." : "不绑定代码库"} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={CODEBASE_NONE}>不绑定</SelectItem>
              {filteredCodebases.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.alias} <span className="text-muted-foreground ml-2">{c.path}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label htmlFor="raw" className="font-mono text-[10px] uppercase tracking-[0.18em]">说说你想做什么</Label>
          <textarea
            id="raw"
            value={rawText}
            onChange={(e) => setRawText(e.target.value)}
            rows={12}
            placeholder="例如：给登录页加忘记密码功能。需要邮件重置..."
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
            {submitting ? "AI 整理中..." : "生成需求 →"}
          </Button>
        </div>
      </div>
    </div>
  );
}
