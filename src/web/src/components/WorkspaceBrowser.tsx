import React, { useEffect, useState } from "react";
import { api, type WorkspaceEntry } from "../hooks/useApi";
import { CodeViewer } from "./CodeViewer";
import { useToast } from "./Toast";

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

  useEffect(() => { loadTree(""); /* eslint-disable-line */ }, [taskId]);

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

  return (
    <div className="card" style={{ marginTop: "0.75rem" }}>
      <div className="card-header">
        <h3>Workspace 文件</h3>
        <div style={{ display: "flex", gap: "0.4rem", alignItems: "center" }}>
          <button
            className="btn btn-secondary"
            onClick={() => loadTree(cwd)}
            disabled={loading}
            title="刷新"
          >
            刷新
          </button>
          <a
            className="btn btn-primary"
            href={api.workspaceZipUrl(taskId)}
            target="_blank"
            rel="noreferrer"
            style={{ textDecoration: "none", display: "inline-flex", alignItems: "center" }}
          >
            打包下载
          </a>
        </div>
      </div>

      {/* 面包屑 */}
      <div className="ws-crumbs">
        <button type="button" className="ws-crumb" onClick={() => { setFile(null); loadTree(""); }}>
          workspace/
        </button>
        {crumbs.map((seg, i) => (
          <React.Fragment key={i}>
            <span className="muted">/</span>
            <button
              type="button"
              className="ws-crumb"
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

      {err && <p style={{ color: "var(--red)", fontSize: "0.85rem" }}>{err}</p>}

      <div className="ws-layout">
        {/* 左：列表 */}
        <div className="ws-list">
          {loading ? (
            <p className="muted" style={{ padding: "0.5rem" }}>加载中...</p>
          ) : entries.length === 0 && !err ? (
            <p className="muted" style={{ padding: "0.5rem" }}>
              {cwd ? "（空目录）" : "（workspace 为空，任务尚未产生文件）"}
            </p>
          ) : (
            <ul>
              {cwd && (
                <li onClick={parentDir} className="ws-entry ws-entry-up">
                  <span className="ws-icon">↩</span>
                  <span>..</span>
                </li>
              )}
              {entries.map((e) => (
                <li
                  key={e.name}
                  className={`ws-entry ws-entry-${e.type} ${file?.path.endsWith("/" + e.name) || file?.path === e.name ? "active" : ""}`}
                  onClick={() => e.type === "dir" ? enterDir(e.name) : openFile(e)}
                >
                  <span className="ws-icon">{e.type === "dir" ? "📁" : "📄"}</span>
                  <span className="ws-name mono">{e.name}</span>
                  {e.type === "file" && <span className="ws-size muted">{formatSize(e.size)}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* 右：文件预览 */}
        <div className="ws-preview">
          {loadingFile && <p className="muted">加载文件...</p>}
          {!loadingFile && !file && (
            <p className="muted" style={{ padding: "0.5rem" }}>
              点击左侧文件预览内容；点击目录进入
            </p>
          )}
          {!loadingFile && file && (
            <div>
              <div className="ws-preview-head">
                <code className="mono" style={{ fontSize: "0.78rem", wordBreak: "break-all" }}>{file.path}</code>
                <div style={{ display: "flex", gap: "0.4rem", alignItems: "center" }}>
                  <span className="muted" style={{ fontSize: "0.74rem" }}>{formatSize(file.size)}</span>
                  <a
                    className="btn btn-secondary"
                    href={api.workspaceDownloadUrl(taskId, file.path)}
                    target="_blank"
                    rel="noreferrer"
                    style={{ padding: "0.3rem 0.7rem", minHeight: 28, fontSize: "0.76rem" }}
                  >
                    下载
                  </a>
                </div>
              </div>
              {file.truncated ? (
                <p className="muted" style={{ padding: "0.5rem", fontSize: "0.82rem" }}>
                  文件 &gt; 1 MB，未加载预览。点击「下载」保存到本地查看。
                </p>
              ) : file.binary ? (
                <p className="muted" style={{ padding: "0.5rem", fontSize: "0.82rem" }}>
                  二进制文件，无法文本预览。点击「下载」。
                </p>
              ) : (
                <CodeViewer code={file.content} />
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
