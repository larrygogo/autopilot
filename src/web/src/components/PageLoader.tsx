import { Loader2 } from "lucide-react";

export function PageLoader() {
  return (
    <div className="flex h-full w-full items-center justify-center p-8 text-muted-foreground">
      <div className="flex items-center gap-2 text-sm">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span>加载中…</span>
      </div>
    </div>
  );
}
