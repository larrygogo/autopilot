import { useEffect, useState } from "react";
import {
  Package, Download, ExternalLink, ChevronDown, ChevronRight,
  FileText, Image as ImageIcon, Globe, FileArchive, AlertTriangle, Folder, FolderOpen,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { MarkdownView } from "@/components/MarkdownView";
import { CodeViewer } from "@/components/CodeViewer";
import { SkeletonRows } from "@/components/pro";
import { api, type RequirementDelivery, type DeliveryFileEntry } from "@/hooks/useApi";

// ──────────────────────────────────────────────
// 文件产物验收展示（artifacts 交付）。设计目标：验收=决策时刻，第一眼不下载就看到交付了什么。
// 按类型分派：图片缩略图+内联预览 / md·文本内联渲染 / html demo 隔离新标签 / 二进制纯下载。
// 多轮 = 时间线（最新默认展开、历史折叠可点开）。安全边界见 routes.ts 的 /deliveries/preview。
// ──────────────────────────────────────────────

type FileKind = "image" | "html" | "markdown" | "text" | "binary";

const IMG_EXT = new Set(["png", "jpg", "jpeg", "webp", "gif", "svg"]);
const TEXT_EXT = new Set(["txt", "json", "csv", "yaml", "yml", "log", "js", "ts", "tsx", "jsx", "py", "rs", "go", "java", "c", "cpp", "h", "css", "sh", "toml", "xml"]);

function fileKind(path: string): FileKind {
  const ext = (path.split(".").pop() ?? "").toLowerCase();
  if (IMG_EXT.has(ext)) return "image";
  if (ext === "html" || ext === "htm") return "html";
  if (ext === "md" || ext === "markdown") return "markdown";
  if (TEXT_EXT.has(ext)) return "text";
  return "binary";
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function DeliveriesCard({ reqId, deliveries }: { reqId: string; deliveries: RequirementDelivery[] }) {
  // 最新轮在前
  const rounds = [...deliveries].sort((a, b) => b.round - a.round);
  const latest = rounds[0];
  const [expandedRounds, setExpandedRounds] = useState<Set<number>>(() => new Set(latest ? [latest.round] : []));

  if (!latest) return null;

  return (
    <Card>
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
        <Package className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="text-sm font-medium">交付物</span>
        <span className="ml-auto font-mono text-[10px] text-muted-foreground">
          {rounds.length > 1 ? `共 ${rounds.length} 轮 · 最新第 ${latest.round} 轮` : `第 ${latest.round} 轮`}
        </span>
      </div>
      <div className="p-4">
        <ol className="space-y-3">
          {rounds.map((d) => (
            <RoundRow
              key={d.round}
              reqId={reqId}
              delivery={d}
              isLatest={d.round === latest.round}
              expanded={expandedRounds.has(d.round)}
              onToggle={() =>
                setExpandedRounds((prev) => {
                  const next = new Set(prev);
                  if (next.has(d.round)) next.delete(d.round); else next.add(d.round);
                  return next;
                })
              }
            />
          ))}
        </ol>
      </div>
    </Card>
  );
}

function RoundRow({
  reqId, delivery, isLatest, expanded, onToggle,
}: {
  reqId: string;
  delivery: RequirementDelivery;
  isLatest: boolean;
  expanded: boolean;
  onToggle: () => void;
}) {
  const [files, setFiles] = useState<DeliveryFileEntry[] | "loading" | "error">("loading");

  useEffect(() => {
    if (!expanded) return;
    let cancelled = false;
    setFiles("loading");
    api.listDeliveryFiles(reqId, delivery.round)
      .then((r) => { if (!cancelled) setFiles(r.files); })
      .catch(() => { if (!cancelled) setFiles("error"); });
    return () => { cancelled = true; };
  }, [expanded, reqId, delivery.round]);

  return (
    <li className="relative pl-5">
      {/* 时间线轴节点：中性灰，无彩色左条（实心=最新轮，空心=历史轮） */}
      <span className={`absolute left-1 top-1.5 h-2.5 w-2.5 rounded-full border ${isLatest ? "border-foreground bg-foreground" : "border-border bg-card"}`} />
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-2 text-left"
      >
        {expanded ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
        <span className="text-sm font-medium">第 {delivery.round} 轮</span>
        {isLatest && <Badge variant="secondary">最新</Badge>}
        <span className="ml-auto font-mono text-[10px] text-muted-foreground">
          {new Date(delivery.created_at).toLocaleString()}
        </span>
      </button>

      {expanded && (
        <div className="mt-2 space-y-3">
          {delivery.summary && (
            <div className="rounded-md border border-border bg-muted/30 p-3">
              <div className="mb-1 text-[11px] font-medium text-muted-foreground">Agent 交付说明</div>
              <div className="scrollbar-thin max-h-[240px] overflow-auto">
                <MarkdownView content={delivery.summary} />
              </div>
            </div>
          )}
          {files === "loading" ? (
            <SkeletonRows count={3} />
          ) : files === "error" ? (
            <p className="text-xs text-muted-foreground">
              交付目录暂无可列出的文件——可能已被自动清理（超过保留期）。交付说明仍可查看。
            </p>
          ) : (() => {
            // SUMMARY.md 已作「交付说明」导读，不在文件树里重复
            const shown = files.filter((f) => f.path.toLowerCase() !== "summary.md");
            if (shown.length === 0) return <p className="text-xs text-muted-foreground">本轮无文件。</p>;
            return (
              <div className="rounded-md border border-border">
                <div className="border-b border-border px-3 py-1.5 text-[10px] text-muted-foreground">
                  {shown.length} 个文件
                </div>
                <FileTree files={shown} reqId={reqId} round={delivery.round} />
              </div>
            );
          })()}
        </div>
      )}
    </li>
  );
}

// ── 文件树（按文件夹分组、可折叠）：产物多 / 带嵌套目录时不再一行行平铺 ──
interface TreeNode { name: string; path: string; children: TreeNode[]; file?: DeliveryFileEntry }

function buildTree(files: DeliveryFileEntry[]): TreeNode {
  const root: TreeNode = { name: "", path: "", children: [] };
  for (const f of files) {
    const parts = f.path.split("/");
    let node = root;
    for (let i = 0; i < parts.length; i++) {
      const isLeaf = i === parts.length - 1;
      if (isLeaf) {
        node.children.push({ name: parts[i], path: f.path, children: [], file: f });
      } else {
        let child = node.children.find((c) => c.name === parts[i] && !c.file);
        if (!child) { child = { name: parts[i], path: parts.slice(0, i + 1).join("/"), children: [] }; node.children.push(child); }
        node = child;
      }
    }
  }
  const sort = (n: TreeNode) => {
    n.children.sort((a, b) => (a.file ? 1 : 0) - (b.file ? 1 : 0) || a.name.localeCompare(b.name)); // 文件夹在前
    n.children.forEach(sort);
  };
  sort(root);
  return root;
}

function countLeaves(n: TreeNode): number {
  return n.file ? 1 : n.children.reduce((s, c) => s + countLeaves(c), 0);
}

function FileTree({ files, reqId, round }: { files: DeliveryFileEntry[]; reqId: string; round: number }) {
  const tree = buildTree(files);
  // 顶层文件夹始终展开；嵌套子文件夹仅在文件 ≤30 时自动展开（多则折叠，避免一屏铺满）
  const expandDeep = files.length <= 30;
  return (
    <ul className="py-1">
      {tree.children.map((n) => (
        <TreeRow key={n.path} node={n} depth={0} reqId={reqId} round={round} defaultOpen={true} expandDeep={expandDeep} />
      ))}
    </ul>
  );
}

function TreeRow({
  node, depth, reqId, round, defaultOpen, expandDeep,
}: {
  node: TreeNode; depth: number; reqId: string; round: number; defaultOpen: boolean; expandDeep: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const pad = { paddingLeft: `${depth * 14 + 12}px` };
  if (node.file) {
    return <FileRow reqId={reqId} round={round} file={node.file} name={node.name} indentStyle={pad} />;
  }
  // 文件夹
  return (
    <>
      <li>
        <button type="button" onClick={() => setOpen((v) => !v)} style={pad}
          className="flex w-full items-center gap-1.5 py-1.5 pr-3 text-left text-xs hover:bg-muted/30">
          {open ? <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />}
          {open ? <FolderOpen className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
          <span className="font-mono">{node.name}/</span>
          <span className="ml-1 text-muted-foreground">{countLeaves(node)}</span>
        </button>
      </li>
      {open && node.children.map((c) => (
        <TreeRow key={c.path} node={c} depth={depth + 1} reqId={reqId} round={round} defaultOpen={expandDeep} expandDeep={expandDeep} />
      ))}
    </>
  );
}

function FileRow({ reqId, round, file, name, indentStyle }: { reqId: string; round: number; file: DeliveryFileEntry; name?: string; indentStyle?: React.CSSProperties }) {
  const kind = fileKind(file.path);
  const downloadUrl = api.deliveryDownloadUrl(reqId, round, file.path);
  const previewUrl = api.deliveryPreviewUrl(reqId, round, file.path);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState<string | null>(null);

  // md / text / html 源码 展开时 fetch 文本（download 通道，attachment 不影响 fetch 读 body）
  useEffect(() => {
    if (!open || (kind !== "markdown" && kind !== "text" && kind !== "html") || text !== null) return;
    let cancelled = false;
    fetch(downloadUrl).then((r) => r.text()).then((t) => { if (!cancelled) setText(t); }).catch(() => { if (!cancelled) setText("（读取失败）"); });
    return () => { cancelled = true; };
  }, [open, kind, downloadUrl, text]);

  const Icon = kind === "image" ? ImageIcon : kind === "html" ? Globe : kind === "binary" ? FileArchive : FileText;

  return (
    <li className="text-xs">
      <div className="flex items-center gap-2 py-1.5 pr-3" style={indentStyle ?? { paddingLeft: "12px" }}>
        {kind === "image" ? (
          <img src={previewUrl} alt="" className="h-7 w-7 shrink-0 rounded border border-border bg-[repeating-conic-gradient(#0001_0_25%,transparent_0_50%)_50%/8px_8px] object-contain" />
        ) : (
          <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1 truncate font-mono" title={file.path}>{name ?? file.path}</span>
        {kind === "html" && (
          <span className="inline-flex shrink-0 items-center gap-0.5 rounded border border-warning/40 bg-warning/10 px-1 text-[9px] text-warning" title="agent 生成的不可信内容，在隔离环境打开">
            <AlertTriangle className="h-2.5 w-2.5" />不可信
          </span>
        )}
        <span className="shrink-0 text-muted-foreground">{fmtSize(file.size)}</span>
        {/* 动作：html 既能看源码（内联）又能打开渲染（隔离标签） */}
        {(kind === "image" || kind === "markdown" || kind === "text" || kind === "html") && (
          <button type="button" onClick={() => setOpen((v) => !v)} className="shrink-0 text-accent hover:underline">
            {open ? "收起" : kind === "html" ? "源码" : "预览"}
          </button>
        )}
        {(kind === "image" || kind === "html") && (
          <a href={previewUrl} target="_blank" rel="noreferrer noopener" className="inline-flex shrink-0 items-center gap-0.5 text-accent hover:underline" title={kind === "html" ? "在隔离新标签打开渲染后的 demo" : "新标签看原图"}>
            <ExternalLink className="h-3 w-3" />{kind === "html" ? "打开" : "原图"}
          </a>
        )}
        <a href={downloadUrl} className="inline-flex shrink-0 items-center gap-0.5 text-accent hover:underline" title="下载">
          <Download className="h-3 w-3" />
        </a>
      </div>
      {open && (
        <div className="border-t border-border bg-muted/20 p-3">
          {kind === "image" && (
            <div className="flex justify-center bg-[repeating-conic-gradient(#0001_0_25%,transparent_0_50%)_50%/16px_16px]">
              <img src={previewUrl} alt={file.path} className="max-h-[400px] object-contain" />
            </div>
          )}
          {kind === "markdown" && (text === null ? <SkeletonRows count={3} /> : <MarkdownView content={text} />)}
          {(kind === "text" || kind === "html") && (text === null ? <SkeletonRows count={3} /> : <CodeViewer code={text} filename={file.path} />)}
        </div>
      )}
    </li>
  );
}
