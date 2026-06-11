import React, { useEffect, useState } from "react";
import {
  RefreshCw,
  Download,
  Folder,
  FileText,
  CornerLeftUp,
  ChevronRight,
} from "lucide-react";
import { api, type SandboxEntry } from "../hooks/useApi";
import { CodeViewer } from "./CodeViewer";
import { useToast } from "./Toast";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

interface Props {
  taskId: string;
  /** task.status：非终态时在产物列表头显示「运行中阶段完成后才归档」说明，
   *  消除「开发在跑为什么没有 02-develop」的困惑（产物目录 = 已完成阶段的归档） */
  taskStatus?: string;
}

interface FileView {
  path: string;
  content: string;
  binary: boolean;
  size: number;
  truncated: boolean;
}

function formatSize(bytes?: number): string {
  if (!bytes && bytes !== 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

type SandboxRoot = "artifacts" | "workspace";

export function SandboxBrowser({ taskId, taskStatus }: Props) {
  const toast = useToast();
  const taskActive = !!taskStatus && (taskStatus.startsWith("running_") || taskStatus.startsWith("pending_") || taskStatus.startsWith("awaiting_") || taskStatus.startsWith("waiting_"));
  // 两个根：产物（artifacts/，阶段完成后归档）/ 代码（workspace/，agent 实际改代码的 clone 工作树）
  const [root, setRoot] = useState<SandboxRoot>("artifacts");
  const [cwd, setCwd] = useState<string>("");
  const [entries, setEntries] = useState<SandboxEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [file, setFile] = useState<FileView | null>(null);
  const [loadingFile, setLoadingFile] = useState(false);

  const loadTree = async (path: string, rootOverride?: SandboxRoot) => {
    setLoading(true);
    setErr(null);
    try {
      const res = await api.getSandboxTree(taskId, path, rootOverride ?? root);
      setEntries(res.entries);
      setCwd(res.path);
    } catch (e: unknown) {
      setErr((e as Error)?.message ?? String(e));
      setEntries([]);
    } finally {
      setLoading(false);
    }
  };

  const switchRoot = (next: SandboxRoot) => {
    if (next === root) return;
    setRoot(next);
    setFile(null);
    loadTree("", next);
  };

  useEffect(() => {
    loadTree("");
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [taskId]);

  const openFile = async (entry: SandboxEntry) => {
    const fullPath = cwd ? `${cwd}/${entry.name}` : entry.name;
    setLoadingFile(true);
    try {
      const res = await api.getSandboxFile(taskId, fullPath, root);
      setFile({ path: fullPath, ...res });
    } catch (e: unknown) {
      toast.error("打开失败", (e as Error)?.message ?? String(e));
    } finally {
      setLoadingFile(false);
    }
  };

  const enterDir = (name: string) => {
    const next = cwd ? `${cwd}/${name}` : name;
    setFile(null);
    loadTree(next);
  };

  const parentDir = () => {
    if (!cwd) return;
    const parts = cwd.split("/").filter(Boolean);
    parts.pop();
    setFile(null);
    loadTree(parts.join("/"));
  };

  const crumbs = cwd.split("/").filter(Boolean);
  const isFileActive = (name: string): boolean => {
    if (!file) return false;
    return file.path === name || file.path.endsWith("/" + name);
  };

  return (
    <Card>
      {/* Header */}
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2.5">
        <div className="flex items-center gap-3">
          <span className="bp-label">沙盒</span>
          {/* 根切换：产物（阶段归档）/ 代码（clone 工作树） */}
          <div className="flex items-center overflow-hidden rounded-md border border-border">
            {([["artifacts", "产物"], ["workspace", "代码"]] as Array<[SandboxRoot, string]>).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => switchRoot(key)}
                aria-pressed={root === key}
                title={key === "artifacts" ? "阶段产物归档（artifacts/）" : "代码沙盒：从你仓库 clone 的工作树，agent 实际改代码的地方（workspace/）"}
                className={cn(
                  "border-r border-border px-2.5 py-1 font-mono text-[10px] transition-colors last:border-r-0",
                  root === key ? "bg-foreground/8 text-foreground" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => loadTree(cwd)}
            disabled={loading}
            title="刷新"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
            刷新
          </Button>
          <Button asChild size="sm" variant="secondary">
            <a
              href={api.sandboxZipUrl(taskId)}
              target="_blank"
              rel="noreferrer"
            >
              <Download className="h-3.5 w-3.5" />
              打包下载
            </a>
          </Button>
          {/* 不提供手动「释放」：沙盒清理交给保留策略（workspace_retention）和删除需求级联，
              避免误删正在验收/回看的产物 */}
        </div>
      </div>

      <div className="p-4">
        {/* 运行期说明：产物目录 = 已完成阶段的归档，正在跑的阶段（如 02-develop）
            要等该阶段结束才出现在这里 —— 实时输出在上方执行时间线；代码改动切「代码」根看 */}
        {taskActive && root === "artifacts" && (
          <p className="mb-3 rounded-lg bg-muted/40 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
            任务执行中：这里只列<span className="text-foreground/80">已完成阶段</span>的归档产物（日志 / 报告），
            正在运行的阶段要等它结束后才会出现。实时输出看上方执行时间线；正在写的代码切「代码」根看。
          </p>
        )}
        {/* 面包屑 */}
        <div className="scrollbar-thin mb-3 flex flex-nowrap items-center gap-1 overflow-x-auto border border-border bg-muted/40 px-2 py-1.5 font-mono text-xs">
          <button
            type="button"
            className="shrink-0 px-1.5 py-0.5 text-muted-foreground transition-colors hover:text-accent"
            onClick={() => {
              setFile(null);
              loadTree("");
            }}
          >
            {root === "workspace" ? "代码" : "产物"}
          </button>
          {crumbs.map((seg, i) => (
            <React.Fragment key={i}>
              <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
              <button
                type="button"
                className={cn(
                  "shrink-0 px-1.5 py-0.5 transition-colors hover:text-accent",
                  i === crumbs.length - 1 ? "text-foreground" : "text-muted-foreground",
                )}
                onClick={() => {
                  setFile(null);
                  loadTree(crumbs.slice(0, i + 1).join("/"));
                }}
              >
                {seg}
              </button>
            </React.Fragment>
          ))}
        </div>

        {err && (
          <p className="mb-2 border border-destructive bg-destructive/10 px-3 py-2 font-mono text-xs text-destructive">
            {err}
          </p>
        )}

        <div className="grid grid-cols-1 gap-3 md:grid-cols-[minmax(0,260px)_minmax(0,1fr)]">
          {/* 左：列表 */}
          <div className="scrollbar-thin max-h-[28rem] overflow-auto border border-border bg-card">
            {loading ? (
              <p className="p-3 font-mono text-xs text-muted-foreground">
                加载中…
              </p>
            ) : entries.length === 0 && !err ? (
              <p className="p-3 font-mono text-xs text-muted-foreground">
                {cwd
                  ? "（空目录）"
                  : root === "workspace"
                    ? "（代码沙盒不存在：任务尚未 clone，或终态后已释放）"
                    : "（暂无产物，任务尚未产出文档）"}
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {cwd && (
                  <li>
                    <button
                      type="button"
                      onClick={parentDir}
                      className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                    >
                      <CornerLeftUp className="h-3.5 w-3.5 shrink-0" />
                      <span className="font-mono text-xs">..</span>
                    </button>
                  </li>
                )}
                {entries.map((e) => {
                  const active = e.type === "file" && isFileActive(e.name);
                  return (
                    <li key={e.name}>
                      <button
                        type="button"
                        onClick={() => (e.type === "dir" ? enterDir(e.name) : openFile(e))}
                        className={cn(
                          "flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors hover:bg-secondary",
                          active && "bg-accent/12 text-foreground hover:bg-accent/15",
                        )}
                      >
                        {e.type === "dir" ? (
                          <Folder className="h-3.5 w-3.5 shrink-0 text-info" />
                        ) : (
                          <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        )}
                        <span className="min-w-0 flex-1 truncate font-mono text-xs">{e.name}</span>
                        {e.type === "file" && (
                          <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                            {formatSize(e.size)}
                          </span>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {/* 右：文件预览 */}
          <div className="min-w-0 border border-border bg-card">
            {loadingFile && (
              <p className="p-3 font-mono text-xs text-muted-foreground">
                加载文件…
              </p>
            )}
            {!loadingFile && !file && (
              <p className="p-3 font-mono text-xs text-muted-foreground">
                点击左侧文件预览内容；点击目录进入
              </p>
            )}
            {!loadingFile && file && (
              <div className="flex min-w-0 flex-col">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-muted/30 px-3 py-2">
                  <code className="min-w-0 break-all font-mono text-[11px] text-foreground">
                    {file.path}
                  </code>
                  <div className="flex shrink-0 items-center gap-2">
                    <span className="font-mono text-[10px] text-muted-foreground">
                      {formatSize(file.size)}
                    </span>
                    <Button asChild size="sm" variant="ghost">
                      <a
                        href={api.sandboxDownloadUrl(taskId, file.path)}
                        target="_blank"
                        rel="noreferrer"
                      >
                        <Download className="h-3 w-3" />
                        下载
                      </a>
                    </Button>
                  </div>
                </div>
                <div className="min-w-0 p-3">
                  {file.truncated ? (
                    <p className="text-xs text-muted-foreground">
                      文件 &gt; 1 MB，未加载预览。点击「下载」保存到本地查看。
                    </p>
                  ) : file.binary ? (
                    <p className="text-xs text-muted-foreground">
                      二进制文件，无法文本预览。点击「下载」。
                    </p>
                  ) : (
                    <CodeViewer code={file.content} />
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

    </Card>
  );
}
