import { Link, useLocation } from "react-router-dom";
import { MessageSquare } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * 右下角浮动按钮 — 直接跳 /chat 页面。
 *
 * 之前版本是个 sheet wrapper，点开只显示"打开全屏 chat"按钮，等于多一次点击没
 * 任何价值。改为 Link 直跳，符合用户对"浮动 chat 按钮"的通用心智。
 */
export function FloatingChat() {
  const location = useLocation();

  // 在 /chat 页面本身不显示浮动按钮（用户已经在 chat 里了）
  if (location.pathname.startsWith("/chat")) return null;

  return (
    <Link
      to="/chat"
      aria-label="打开 Chat"
      className={cn(
        "fixed bottom-6 right-6 z-40 flex h-12 w-12 items-center justify-center",
        "border border-border bg-card text-foreground shadow-lg rounded-md",
        "hover:border-accent hover:text-accent transition-colors",
      )}
    >
      <MessageSquare className="h-5 w-5" />
    </Link>
  );
}
