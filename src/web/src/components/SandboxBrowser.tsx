import React, { useEffect, useState } from "react";
import {
  RefreshCw,
  Download,
  Trash2,
  Folder,
  FileText,
  CornerLeftUp,
  ChevronRight,
} from "lucide-react";
import { api, type SandboxEntry } from "../hooks/useApi";
import { CodeViewer } from "./CodeViewer";
import { useToast } from "./Toast";
import { ConfirmDialog } from "./Modal";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

interface Props {
  taskId: string;
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

export function SandboxBrowser({ taskId }: Props) {
  const toast = useToast();
  const [cwd, setCwd] = useState<string>("");
  const [entries, setEntries] = useState<SandboxEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [file, setFile] = useState<FileView | null>(null);
  const [loadingFile, setLoadingFile] = useState(false);
  const [confirmRelease, setConfirmRelease] = useState(false);

  const loadTree = async (path: string) => {
    setLoading(true);
    setErr(null);
    try {
      const res = await api.getSandboxTree(taskId, path);
      setEntries(res.entries);
      setCwd(res.path);
    } catch (e: unknown) {
      setErr((e as Error)?.message ?? String(e));
      setEntries([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadTree("");
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [taskId]);

  const openFile = async (entry: SandboxEntry) => {
    const fullPath = cwd ? `${cwd}/${entry.name}` : entry.name;
    setLoadingFile(true);
    try {
      const res = await api.getSandboxFile(taskId, fullPath);
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
        <span className="bp-label">沙盒 · 产物文件</span>
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
          <Button
            variant="destructive"
            size="sm"
            onClick={() => setConfirmRelease(true)}
            title="删除沙盒产物目录（不影响任务记录与日志）"
          >
            <Trash2 className="h-3.5 w-3.5" />
            释放
          </Button>
        </div>
      </div>

      <div className="p-4">
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
            产物
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
                {cwd ? "（空目录）" : "（暂无产物，任务尚未产出文档）"}
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
                          "flex w-full items-center gap-2 border-l-2 border-transparent px-2.5 py-1.5 text-left transition-colors hover:bg-secondary",
                          active && "border-accent bg-accent/12 text-foreground hover:bg-accent/15",
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

      <ConfirmDialog
        open={confirmRelease}
        title="释放沙盒产物"
        message={
          <div className="space-y-2">
            <p>将删除此任务的沙盒产物目录（产物文件 + 累积代码 patch + 即焚副本残留）：</p>
            <pre className="overflow-x-auto border border-border bg-muted/40 px-2 py-1.5 font-mono text-[11px]">
              {`~/.autopilot/runtime/tasks/${taskId}/artifacts`}
            </pre>
            <p className="text-xs text-muted-foreground">
              任务记录、状态日志、阶段日志、Agent 调用记录都保留。任务运行中无法释放。此操作不可恢复。
            </p>
          </div>
        }
        confirmText="释放"
        danger
        onConfirm={async () => {
          try {
            const res = await api.deleteSandbox(taskId);
            if (res.removed) toast.success("已释放沙盒产物");
            else toast.info("沙盒产物不存在或已清理");
            setFile(null);
            loadTree("");
          } catch (e: unknown) {
            toast.error("释放失败", (e as Error)?.message ?? String(e));
          } finally {
            setConfirmRelease(false);
          }
        }}
        onCancel={() => setConfirmRelease(false)}
      />
    </Card>
  );
}
