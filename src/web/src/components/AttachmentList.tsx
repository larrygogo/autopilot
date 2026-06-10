import { useState } from "react";
import { FileText, Image, FileSpreadsheet, File, Trash2, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "@/components/Toast";
import { api, type Attachment } from "@/hooks/useApi";

interface AttachmentListProps {
  requirementId: string;
  attachments: Attachment[];
  onDeleted: (attId: string) => void;
  readOnly?: boolean;
}

const CATEGORY_ICON: Record<Attachment["category"], typeof File> = {
  image: Image,
  text: FileText,
  pdf: FileText,
  office: FileSpreadsheet,
};

const CATEGORY_LABEL: Record<Attachment["category"], string> = {
  image: "图片",
  text: "文本",
  pdf: "PDF",
  office: "Office",
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

export function AttachmentList({ requirementId, attachments, onDeleted, readOnly }: AttachmentListProps) {
  const toast = useToast();
  const [deletingId, setDeletingId] = useState<string | null>(null);

  if (attachments.length === 0) return null;

  const handleDelete = async (att: Attachment) => {
    if (deletingId) return;
    setDeletingId(att.id);
    try {
      await api.deleteAttachment(requirementId, att.id);
      onDeleted(att.id);
      toast.success(`已删除附件「${att.original_name}」`);
    } catch (e: unknown) {
      toast.error("删除失败", (e as Error)?.message ?? String(e));
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="space-y-1">
      {attachments.map((att) => {
        const Icon = CATEGORY_ICON[att.category] ?? File;
        const deleting = deletingId === att.id;
        return (
          <div
            key={att.id}
            className="flex items-center gap-2 rounded-md border border-border bg-card px-2.5 py-1.5"
          >
            <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="flex-1 truncate font-mono text-[11px] text-foreground" title={att.original_name}>
              {att.original_name}
            </span>
            <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
              {CATEGORY_LABEL[att.category]} · {formatBytes(att.file_size)}
            </span>
            {!readOnly && (
              <button
                type="button"
                onClick={() => void handleDelete(att)}
                disabled={!!deletingId}
                className={cn(
                  "shrink-0 text-muted-foreground hover:text-destructive transition-colors",
                  deleting && "opacity-50",
                )}
                aria-label={`删除附件 ${att.original_name}`}
              >
                {deleting ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Trash2 className="h-3.5 w-3.5" />
                )}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
