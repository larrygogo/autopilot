import { useRef, useState } from "react";
import { Upload, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "@/components/Toast";
import { api, type Attachment } from "@/hooks/useApi";

interface AttachmentUploaderProps {
  requirementId: string;
  onUploaded: (newAtts: Attachment[]) => void;
  disabled?: boolean;
}

const ACCEPT = [
  "image/png", "image/jpeg", "image/webp", "image/gif",
  "text/*",
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
].join(",");

export function AttachmentUploader({ requirementId, onUploaded, disabled }: AttachmentUploaderProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const toast = useToast();

  const upload = async (files: File[]) => {
    if (!files.length || uploading || disabled) return;
    setUploading(true);
    try {
      const saved = await api.uploadAttachments(requirementId, files);
      onUploaded(saved);
      toast.success(`已上传 ${saved.length} 个附件`);
    } catch (e: unknown) {
      toast.error("上传失败", (e as Error)?.message ?? String(e));
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    void upload(files);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const files = Array.from(e.dataTransfer.files);
    void upload(files);
  };

  return (
    <div
      className={cn(
        "relative flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-md border border-dashed border-border px-4 py-4 transition-colors",
        dragging && "border-accent bg-accent/5",
        disabled && "pointer-events-none opacity-50",
        !disabled && "hover:border-accent/60 hover:bg-muted/30",
      )}
      onClick={() => inputRef.current?.click()}
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
      role="button"
      tabIndex={disabled ? -1 : 0}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") inputRef.current?.click(); }}
      aria-label="上传附件"
    >
      {uploading ? (
        <Loader2 className="h-5 w-5 animate-spin text-accent" />
      ) : (
        <Upload className="h-5 w-5 text-muted-foreground" />
      )}
      <p className="font-mono text-[11px] text-muted-foreground text-center">
        {uploading ? "上传中…" : "点击或拖拽上传附件（图片 / PDF / Office / 代码文本，最大 200MB）"}
      </p>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={ACCEPT}
        className="sr-only"
        onChange={handleChange}
        disabled={disabled || uploading}
      />
    </div>
  );
}
