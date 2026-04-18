import React, { useEffect, useMemo, useState } from "react";
import { RefreshCw, Search } from "lucide-react";
import { api } from "@/hooks/useApi";
import { useToast } from "@/components/Toast";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input, Textarea } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

// 保留 embedded 参数签名以兼容旧调用
export function Settings(_props: { embedded?: boolean } = {}) {
  const toast = useToast();

  const [configYaml, setConfigYaml] = useState("");
  const [configLoading, setConfigLoading] = useState(true);
  const [configSaving, setConfigSaving] = useState(false);

  const [workflows, setWorkflows] = useState<{ name: string; description: string }[]>([]);
  const [selectedWf, setSelectedWf] = useState("");
  const [wfYaml, setWfYaml] = useState("");
  const [wfLoading, setWfLoading] = useState(false);
  const [wfSaving, setWfSaving] = useState(false);

  const [status, setStatus] = useState<any>(null);

  useEffect(() => {
    api.getConfig()
      .then((res) => setConfigYaml(res.yaml))
      .catch((e) => toast.error("加载全局配置失败", e?.message ?? String(e)))
      .finally(() => setConfigLoading(false));
  }, []);

  useEffect(() => {
    api.listWorkflows().then(setWorkflows).catch(() => {});
  }, []);

  useEffect(() => {
    api.getStatus().then(setStatus).catch(() => {});
  }, []);

  useEffect(() => {
    if (!selectedWf) { setWfYaml(""); return; }
    setWfLoading(true);
    api.getWorkflowYaml(selectedWf)
      .then((res) => setWfYaml(res.yaml))
      .catch((e) => toast.error("加载工作流失败", e?.message ?? String(e)))
      .finally(() => setWfLoading(false));
  }, [selectedWf]);

  const saveConfig = async () => {
    setConfigSaving(true);
    try {
      await api.saveConfig(configYaml);
      toast.success("全局配置已保存");
    } catch (e: any) {
      toast.error("保存失败", e?.message ?? String(e));
    } finally {
      setConfigSaving(false);
    }
  };

  const saveWorkflow = async () => {
    if (!selectedWf) return;
    setWfSaving(true);
    try {
      await api.saveWorkflowYaml(selectedWf, wfYaml);
      toast.success(`工作流 ${selectedWf} 已保存并重载`);
    } catch (e: any) {
      toast.error("保存失败", e?.message ?? String(e));
    } finally {
      setWfSaving(false);
    }
  };

  const reloadAll = async () => {
    try {
      const res = await api.reloadWorkflows();
      setWorkflows(res.workflows);
      toast.success("工作流已重载");
    } catch (e: any) {
      toast.error("重载失败", e?.message ?? String(e));
    }
  };

  return (
    <div className="mx-auto w-full max-w-4xl px-5 py-6">
      {/* Header */}
      <div className="mb-5">
        <h2 className="text-xl font-semibold tracking-tight">高级设置</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          优先使用图形化的 提供商 / 智能体 页面；这里是 YAML 直编后门。
        </p>
      </div>

      {status && (
        <Card className="mb-4 p-4">
          <h3 className="mb-3 text-sm font-semibold">Daemon 信息</h3>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
            <InfoField label="版本" value={status.version} />
            <InfoField label="PID" value={String(status.pid)} mono />
            <InfoField label="运行时间" value={formatUptime(status.uptime)} />
            <InfoField label="端口" value={location.port || "80"} mono />
          </dl>
        </Card>
      )}

      <DaemonLogCard />

      {/* 全局配置 */}
      <Card className="mb-4 p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold">全局配置</h3>
            <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">config.yaml</p>
          </div>
        </div>
        {configLoading ? (
          <p className="text-sm text-muted-foreground">加载中…</p>
        ) : (
          <>
            <Textarea
              className="min-h-[320px] font-mono text-xs"
              value={configYaml}
              onChange={(e) => setConfigYaml(e.target.value)}
              placeholder={CONFIG_PLACEHOLDER}
              spellCheck={false}
            />
            <div className="mt-3 flex justify-end">
              <Button onClick={saveConfig} disabled={configSaving}>
                {configSaving ? "保存中…" : "保存"}
              </Button>
            </div>
          </>
        )}
      </Card>

      {/* 工作流 YAML */}
      <Card className="p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">工作流配置</h3>
          <Button variant="secondary" size="sm" onClick={reloadAll}>
            <RefreshCw className="h-3.5 w-3.5" />
            重载全部
          </Button>
        </div>

        <div className="mb-3 space-y-1.5">
          <Label>选择工作流</Label>
          <Select value={selectedWf || "__none__"} onValueChange={(v) => setSelectedWf(v === "__none__" ? "" : v)}>
            <SelectTrigger>
              <SelectValue placeholder="选择工作流…" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">—</SelectItem>
              {workflows.map((wf) => (
                <SelectItem key={wf.name} value={wf.name}>
                  <span className="font-medium">{wf.name}</span>
                  {wf.description ? (
                    <span className="ml-2 text-muted-foreground">— {wf.description}</span>
                  ) : null}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {selectedWf && (
          <>
            {wfLoading ? (
              <p className="text-sm text-muted-foreground">加载中…</p>
            ) : (
              <>
                <Textarea
                  className="min-h-[320px] font-mono text-xs"
                  value={wfYaml}
                  onChange={(e) => setWfYaml(e.target.value)}
                  placeholder="# workflow.yaml"
                  spellCheck={false}
                />
                <div className="mt-3 flex justify-end">
                  <Button onClick={saveWorkflow} disabled={wfSaving}>
                    {wfSaving ? "保存中…" : "保存并重载"}
                  </Button>
                </div>
              </>
            )}
          </>
        )}
      </Card>
    </div>
  );
}

function InfoField({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex flex-col">
      <dt className="text-[11px] text-muted-foreground">{label}</dt>
      <dd className={cn("text-sm", mono && "font-mono")}>{value}</dd>
    </div>
  );
}

function DaemonLogCard(): React.ReactElement {
  const toast = useToast();
  const [content, setContent] = useState("");
  const [path, setPath] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");

  const refresh = async () => {
    setLoading(true);
    try {
      const res = await api.getDaemonLog(1000);
      setContent(res.content);
      setPath(res.path);
    } catch (e: any) {
      toast.error("加载 daemon 日志失败", e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { refresh(); /* eslint-disable-line */ }, []);

  const filtered = useMemo(() => {
    if (!content) return [];
    const lines = content.split("\n");
    const q = query.trim().toLowerCase();
    return q ? lines.filter((l) => l.toLowerCase().includes(q)) : lines;
  }, [content, query]);

  const extractLevel = (line: string): string | null => {
    const m = line.match(/\s\[(INFO|WARN|ERROR|DEBUG)\]\s/);
    return m?.[1] ?? null;
  };

  const levelClass = (lvl: string | null) => {
    switch (lvl) {
      case "ERROR": return "text-destructive";
      case "WARN": return "text-amber-600 dark:text-amber-400";
      case "DEBUG": return "text-muted-foreground";
      default: return "text-foreground";
    }
  };

  return (
    <Card className="mb-4 p-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Daemon 日志</h3>
        <Button variant="secondary" size="sm" onClick={refresh} disabled={loading}>
          <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
          刷新
        </Button>
      </div>

      {path ? (
        <p className="mb-2 text-[11px] text-muted-foreground">
          位置：<code className="rounded bg-muted px-1 py-0.5 font-mono">{path}</code>
          <span className="ml-1">（含上一次滚动的 .1 备份，最后 1000 行）</span>
        </p>
      ) : (
        <p className="mb-2 text-xs text-muted-foreground">daemon 日志未激活或路径未知。</p>
      )}

      <div className="relative mb-2">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="search"
          placeholder="搜索日志…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="pl-8"
        />
      </div>

      {loading && !content ? (
        <p className="text-sm text-muted-foreground">加载中…</p>
      ) : filtered.length === 0 ? (
        <p className="rounded-md border bg-muted/40 px-3 py-4 text-xs text-muted-foreground">
          {content ? "（当前过滤下无匹配）" : "（空）"}
        </p>
      ) : (
        <pre className="scrollbar-thin max-h-[400px] overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-[11px] leading-relaxed">
          {filtered.map((line, i) => {
            const lvl = extractLevel(line);
            return (
              <div key={i} className={cn("whitespace-pre", levelClass(lvl))}>{line}</div>
            );
          })}
        </pre>
      )}
    </Card>
  );
}

function formatUptime(s: number): string {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

const CONFIG_PLACEHOLDER = `# 全局配置。仅存放跨工作流共享的基础设施（providers / agents）；
# 工作流自己的参数请写在该工作流目录下的 workflow.yaml 或
# 其独立配置文件里，不要放在这里。
#
# providers:
#   anthropic:
#     default_model: claude-sonnet-4-6
#     base_url: ""
#     enabled: true
#
# agents:
#   coder:
#     provider: anthropic
#     model: claude-sonnet-4-6
#     max_turns: 10
#     permission_mode: auto
#     system_prompt: |
#       你是通用编码助手。
`;
