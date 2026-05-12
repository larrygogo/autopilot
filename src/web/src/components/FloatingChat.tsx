import { useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { MessageSquare, X, ArrowRight } from "lucide-react";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function FloatingChat() {
  const [open, setOpen] = useState(false);
  const location = useLocation();

  // 在 /chat 页面本身不显示浮动按钮（用户已经在 chat 里了）
  if (location.pathname.startsWith("/chat")) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="打开 Chat"
        className={cn(
          "fixed bottom-6 right-6 z-40 flex h-12 w-12 items-center justify-center",
          "border-[1.5px] border-foreground/40 bg-card text-foreground shadow-lg rounded-none",
          "hover:border-accent hover:text-accent transition-colors",
        )}
      >
        <MessageSquare className="h-5 w-5" />
      </button>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="right" className="w-96 max-w-full p-0 flex flex-col">
          <header className="flex items-center justify-between border-b-[1.5px] border-foreground/30 px-5 py-3.5 shrink-0">
            <div>
              <h2 className="font-display text-base font-bold uppercase tracking-wider">Chat</h2>
              <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground mt-0.5">
                与 agent 对话
              </p>
            </div>
            <button
              onClick={() => setOpen(false)}
              aria-label="关闭"
              className="text-muted-foreground hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          </header>

          <div className="flex-1 flex flex-col items-center justify-center gap-4 px-6 text-center">
            <MessageSquare className="h-10 w-10 text-muted-foreground/60" />
            <div>
              <p className="font-display text-sm font-bold mb-1">快速发起对话</p>
              <p className="text-xs text-muted-foreground">
                想提需求、咨询架构、查看进度，都可以在 chat 里说
              </p>
            </div>
            <Button
              asChild
              variant="default"
              size="default"
              className="rounded-none font-mono text-[11px] uppercase tracking-[0.12em] gap-2"
              onClick={() => setOpen(false)}
            >
              <Link to="/chat">
                打开全屏 chat
                <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            </Button>
          </div>

          <footer className="border-t-[1.5px] border-foreground/30 px-5 py-3 shrink-0">
            <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
              Tip · 可以从任意页面唤起
            </p>
          </footer>
        </SheetContent>
      </Sheet>
    </>
  );
}
