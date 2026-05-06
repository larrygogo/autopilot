import React, { useCallback, useEffect, useRef, useState } from "react";
import { ChevronUp, Folder, Loader2 } from "lucide-react";
import { api, type FsListResult } from "@/hooks/useApi";
import { useToast } from "@/components/Toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

export interface FolderPickerProps {
  open: boolean;
  initialPath?: string;
  onSelect: (path: string) => void;
  onCancel: () => void;
}

export function FolderPicker({ open, initialPath, onSelect, onCancel }: FolderPickerProps) {
  const toast = useToast();

  const [result, setResult] = useState<FsListResult | null>(null);
  const [loading, setLoading] = useState(false);
  // 当前展示路径（可编辑 input 绑定的 state）
  const [inputPath, setInputPath] = useState<string>("");
  const [showHidden, setShowHidden] = useState(false);

  // 用 ref 跟踪最新请求序号，避免慢请求覆盖新结果
  const seqRef = useRef(0);

  const navigate = useCallback(
    async (targetPath: string | undefined, hidden: boolean) => {
      const seq = ++seqRef.current;
      setLoading(true);
      try {
        const res = await api.browseFs(targetPath, hidden);
        if (seq !== seqRef.current) return; // 过期请求，丢弃
        setResult(res);
        setInputPath(res.current_path);
      } catch (e: unknown) {
        if (seq !== seqRef.current) return;
        toast.error("目录加载失败", (e as Error)?.message ?? String(e));
      } finally {
        if (seq === seqRef.current) setLoading(false);
      }
    },
    [toast],
  );

  // Dialog 打开时加载初始路径
  useEffect(() => {
    if (!open) return;
    navigate(initialPath || undefined, showHidden);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // showHidden 切换时刷新当前路径
  const handleShowHiddenChange = (checked: boolean) => {
    setShowHidden(checked);
    navigate((result?.current_path ?? inputPath) || undefined, checked);
  };

  // 用户直接输入路径后按 Enter
  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      navigate(inputPath || undefined, showHidden);
    }
  };

  const goUp = () => {
    if (!result?.parent_path) return;
    navigate(result.parent_path, showHidden);
  };

  const enterDir = (name: string) => {
    const sep = result!.current_path.includes("\\") ? "\\" : "/";
    const newPath = result!.current_path.replace(/[/\\]$/, "") + sep + name;
    navigate(newPath, showHidden);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onCancel(); }}>
      <DialogContent className="sm:max-w-lg" hideClose>
        <DialogHeader>
          <DialogTitle>选择文件夹</DialogTitle>
        </DialogHeader>

        {/* 路径输入栏 */}
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8 shrink-0"
            onClick={goUp}
            disabled={loading || !result?.parent_path}
            title="上一级"
          >
            <ChevronUp className="h-4 w-4" />
          </Button>
          <Input
            className="font-mono text-xs h-8"
            value={inputPath}
            onChange={(e) => setInputPath(e.target.value)}
            onKeyDown={handleInputKeyDown}
            placeholder="输入路径后按 Enter 跳转"
          />
        </div>

        {/* 文件夹列表 */}
        <div className="relative min-h-[220px] max-h-[340px] overflow-y-auto rounded-md border bg-muted/20">
          {loading && (
            <div className="absolute inset-0 flex items-center justify-center bg-background/60 z-10">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          )}
          {!loading && result?.entries.filter((e) => e.is_dir).length === 0 && (
            <p className="p-4 text-sm text-muted-foreground text-center">当前目录下没有子文件夹</p>
          )}
          <ul className="py-1">
            {result?.entries
              .filter((e) => e.is_dir)
              .map((entry) => (
                <li key={entry.name}>
                  <button
                    className={cn(
                      "flex w-full items-center gap-2 px-3 py-1.5 text-sm text-left",
                      "hover:bg-accent hover:text-accent-foreground rounded transition-colors",
                    )}
                    onDoubleClick={() => enterDir(entry.name)}
                    onClick={() => enterDir(entry.name)}
                    title={`双击进入：${entry.name}`}
                  >
                    <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="font-mono text-xs truncate">{entry.name}</span>
                  </button>
                </li>
              ))}
          </ul>
        </div>

        {/* 显示隐藏文件夹 checkbox */}
        <label className="flex items-center gap-2 text-xs text-muted-foreground select-none cursor-pointer">
          <input
            type="checkbox"
            checked={showHidden}
            onChange={(e) => handleShowHiddenChange(e.target.checked)}
            className="rounded"
          />
          显示隐藏文件夹
        </label>

        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={loading}>
            取消
          </Button>
          <Button
            onClick={() => onSelect(result?.current_path ?? inputPath)}
            disabled={loading || (!result?.current_path && !inputPath)}
          >
            选定当前路径
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
