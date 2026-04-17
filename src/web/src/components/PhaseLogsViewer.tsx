import React, { useEffect, useMemo, useState } from "react";
import { api } from "../hooks/useApi";

interface PhaseMeta { phase: string; size: number; mtime: number }

interface Props {
  taskId: string;
}

function formatSize(bytes?: number): string {
  if (!bytes && bytes !== 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

const LEVEL_RE = /\s\[(INFO|WARN|ERROR|DEBUG)\]\s/;

type Level = "INFO" | "WARN" | "ERROR" | "DEBUG";

function extractLevel(line: string): Level | null {
  const m = line.match(LEVEL_RE);
  return (m?.[1] as Level) ?? null;
}

export function PhaseLogsViewer({ taskId }: Props) {
  const [phases, setPhases] = useState<PhaseMeta[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [levels, setLevels] = useState<Set<Level>>(new Set(["INFO", "WARN", "ERROR", "DEBUG"]));

  const refreshList = async () => {
    try {
      const list = await api.getPhaseLogsList(taskId);
      setPhases(list);
      // 初始选中第一个（或保持现有选中）
      if (list.length > 0 && !selected) setSelected(list[0].phase);
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    }
  };

  useEffect(() => { refreshList(); /* eslint-disable-line */ }, [taskId]);

  useEffect(() => {
    if (!selected) { setContent(""); return; }
    let cancelled = false;
    setLoading(true);
    setErr(null);
    api.getPhaseLog(taskId, selected, 2000)
      .then((res) => { if (!cancelled) setContent(res.content); })
      .catch((e) => { if (!cancelled) setErr(e?.message ?? String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [taskId, selected]);

  const filtered = useMemo(() => {
    if (!content) return [];
    const lines = content.split("\n");
    const q = query.trim().toLowerCase();
    return lines.filter((line) => {
      if (!line.trim()) return false;
      const lvl = extractLevel(line);
      if (lvl && !levels.has(lvl)) return false;
      if (q && !line.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [content, query, levels]);

  const toggleLevel = (lvl: Level) => {
    setLevels((prev) => {
      const next = new Set(prev);
      if (next.has(lvl)) next.delete(lvl);
      else next.add(lvl);
      return next;
    });
  };

  return (
    <div className="card" style={{ marginTop: "0.75rem" }}>
      <div className="card-header">
        <h3>阶段日志</h3>
        <button className="btn btn-secondary" onClick={refreshList} title="刷新阶段列表">刷新</button>
      </div>

      {phases.length === 0 ? (
        <p className="muted" style={{ fontSize: "0.82rem" }}>
          尚无阶段日志。任务开始执行阶段后会自动落盘。
        </p>
      ) : (
        <>
          <div className="phase-log-tabs">
            {phases.map((p) => (
              <button
                key={p.phase}
                type="button"
                className={`phase-log-tab ${selected === p.phase ? "active" : ""}`}
                onClick={() => setSelected(p.phase)}
                title={`${formatSize(p.size)} · ${new Date(p.mtime).toLocaleString()}`}
              >
                <span className="mono">{p.phase}</span>
                <span className="muted" style={{ fontSize: "0.7rem", marginLeft: "0.4rem" }}>
                  {formatSize(p.size)}
                </span>
              </button>
            ))}
          </div>

          <div className="phase-log-toolbar">
            <input
              type="search"
              className="text-input"
              placeholder="搜索当前阶段日志..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              style={{ flex: 1, minWidth: 140 }}
            />
            <div className="phase-log-level-filter">
              {(["INFO", "WARN", "ERROR", "DEBUG"] as Level[]).map((lvl) => (
                <label key={lvl} className="phase-log-level-chip">
                  <input
                    type="checkbox"
                    checked={levels.has(lvl)}
                    onChange={() => toggleLevel(lvl)}
                  />
                  <span className={`level-${lvl.toLowerCase()}`}>{lvl}</span>
                </label>
              ))}
            </div>
          </div>

          {err && <p style={{ color: "var(--red)", fontSize: "0.82rem" }}>{err}</p>}
          {loading ? (
            <p className="muted">加载中...</p>
          ) : filtered.length === 0 ? (
            <p className="muted" style={{ padding: "0.5rem" }}>
              {content ? "（当前过滤条件下无匹配日志）" : "（空）"}
            </p>
          ) : (
            <pre className="phase-log-body">
              {filtered.map((line, i) => {
                const lvl = extractLevel(line);
                return (
                  <div key={i} className={`log-row ${lvl ? `log-row-${lvl.toLowerCase()}` : ""}`}>
                    {line}
                  </div>
                );
              })}
            </pre>
          )}
          <p className="muted" style={{ fontSize: "0.72rem", marginTop: "0.3rem" }}>
            显示 {filtered.length} 行 / 总 {content.split("\n").filter((l) => l.trim()).length} 行（最多 2000 行，更早用 <code className="mono">{`~/.autopilot/runtime/tasks/${taskId}/logs/phase-${selected}.log`}</code>）
          </p>
        </>
      )}
    </div>
  );
}
