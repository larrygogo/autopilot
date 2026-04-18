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
import { api, type WorkspaceEntry } from "../hooks/useApi";
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

export function WorkspaceBrowser({ taskId }: Props) {
  const toast = useToast();
  const [cwd, setCwd] = useState<string>("");
  const [entries, setEntries] = useState<WorkspaceEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [file, setFile] = useState<FileView | null>(null);
  const [loadingFile, setLoadingFile] = useState(false);
  const [confirmRelease, setConfirmRelease] = useState(false);

  const loadTree = async (path: string) => {
    setLoading(true);
    setErr(null);
    try {
      const res = await api.getWorkspaceTree(taskId, path);
      setEntries(res.entries);
      setCwd(res.path);
    } catch (e: any) {
      setErr(e?.message ?? String(e));
      setEntries([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadTree("");
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [taskId]);

  const openFile = async (entry: WorkspaceEntry) => {
    const fullPath = cwd ? `${cwd}/${entry.name}` : entry.name;
    setLoadingFile(true);
    try {
      const res = await api.getWorkspaceFile(taskId, fullPath);
      setFile({ path: fullPath, ...res });
    } catch (e: any) {
      toast.error("打开失败", e?.message ?? String(e));
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
    <Card className="p-4">
      {/* Header */}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Workspace 文件</h3>
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
              href={api.workspaceZipUrl(taskId)}
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
            title="删除 workspace 目录（不影响任务记录与日志）"
          >
            <Trash2 className="h-3.5 w-3.5" />
            释放
          </Button>
        </div>
      </div>

      {/* 面包屑 */}
      <div className="scrollbar-thin mb-3 flex flex-nowrap items-center gap-1 overflow-x-auto rounded-md border bg-muted/40 px-2 py-1.5 text-xs">
        <button
          type="button"
          className="shrink-0 rounded px-1.5 py-0.5 font-mono text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={() => {
            setFile(null);
            loadTree("");
          }}
        >
          workspace
        </button>
        {crumbs.map((seg, i) => (
          <React.Fragment key={i}>
            <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
            <button
              type="button"
              className={cn(
                "shrink-0 rounded px-1.5 py-0.5 font-mono hover:bg-accent hover:text-foreground",
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
        <p className="mb-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {err}
        </p>
      )}

      <div className="grid grid-cols-1 gap-3 md:grid-cols-[minmax(0,260px)_minmax(0,1fr)]">
        {/* 左：列表 */}
        <div className="scrollbar-thin max-h-[28rem] overflow-auto rounded-md border bg-card">
          {loading ? (
            <p className="p-3 text-xs text-muted-foreground">加载中…</p>
          ) : entries.length === 0 && !err ? (
            <p className="p-3 text-xs text-muted-foreground">
              {cwd ? "（空目录）" : "（workspace 为空，任务尚未产生文件）"}
            </p>
          ) : (
            <ul className="divide-y divide-border text-xs">
              {cwd && (
                <li>
                  <button
                    type="button"
                    onClick={parentDir}
                    className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-muted-foreground hover:bg-accent hover:text-foreground"
                  >
                    <CornerLeftUp className="h-3.5 w-3.5 shrink-0" />
                    <span className="font-mono">..</span>
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
                        "flex w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-accent",
                        active && "bg-primary/10 text-primary hover:bg-primary/15",
                      )}
                    >
                      {e.type === "dir" ? (
                        <Folder className="h-3.5 w-3.5 shrink-0 text-info" />
                      ) : (
                        <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      )}
                      <span className="min-w-0 flex-1 truncate font-mono">{e.name}</span>
                      {e.type === "file" && (
                        <span className="shrink-0 text-[10px] text-muted-foreground">
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
        <div className="min-w-0 rounded-md border bg-card">
          {loadingFile && (
            <p className="p-3 text-xs text-muted-foreground">加载文件…</p>
          )}
          {!loadingFile && !file && (
            <p className="p-3 text-xs text-muted-foreground">
              点击左侧文件预览内容；点击目录进入
            </p>
          )}
          {!loadingFile && file && (
            <div className="flex min-w-0 flex-col">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/30 px-3 py-2">
                <code className="min-w-0 break-all font-mono text-[11px] text-foreground">
                  {file.path}
                </code>
                <div className="flex shrink-0 items-center gap-2">
                  <span className="text-[11px] text-muted-foreground">
                    {formatSize(file.size)}
                  </span>
                  <Button asChild size="sm" variant="ghost">
                    <a
                      href={api.workspaceDownloadUrl(taskId, file.path)}
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

      <ConfirmDialog
        open={confirmRelease}
        title="释放 Workspace"
        message={
          <div className="space-y-2">
            <p>将删除此任务的 workspace 目录：</p>
            <pre className="overflow-x-auto rounded-md border bg-muted/40 px-2 py-1.5 font-mono text-[11px]">
              {`~/.autopilot/runtime/tasks/${taskId}/workspace`}
            </pre>
            <p className="text-xs text-muted-foreground">
              任务记录、状态日志、阶段日志、Agent 调用记录都保留，仅删除产出文件。此操作不可恢复。
            </p>
          </div>
        }
        confirmText="释放"
        danger
        onConfirm={async () => {
          try {
            const res = await api.deleteWorkspace(taskId);
            if (res.removed) toast.success("已释放 workspace");
            else toast.info("workspace 不存在或已被清理");
            setFile(null);
            loadTree("");
          } catch (e: any) {
            toast.error("释放失败", e?.message ?? String(e));
          } finally {
            setConfirmRelease(false);
          }
        }}
        onCancel={() => setConfirmRelease(false)}
      />
    </Card>
  );
}
