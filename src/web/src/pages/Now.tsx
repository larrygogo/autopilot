import { useEffect, useState } from "react";
import { useNowCards } from "@/hooks/useNowCards";
import { NowCard } from "@/components/NowCard";
import { PageHero } from "@/components/PageHero";
import { Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

export function Now() {
  const { cards, loading, error, refresh } = useNowCards();
  const [now, setNow] = useState(Date.now());

  // 每秒更新 now，让卡片"等候 Xs"实时滚动
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="mx-auto max-w-4xl px-4 py-6 md:px-6 md:py-8">
      <PageHero
        title="现在 · NOW"
        subtitle={
          loading
            ? "加载中..."
            : `共 ${cards.length} 件事需要关注`
        }
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => refresh()}
            disabled={loading}
            className="rounded-none font-mono text-[11px] uppercase tracking-[0.12em]"
          >
            <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${loading ? "animate-spin" : ""}`} />
            刷新
          </Button>
        }
      />

      {error && (
        <div className="mt-4 border-[1.5px] border-l-4 border-foreground/30 border-l-destructive bg-card px-4 py-3 rounded-none">
          <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-destructive mb-1">
            ERROR
          </p>
          <p className="text-sm text-foreground">{error}</p>
        </div>
      )}

      {loading && cards.length === 0 && (
        <div className="mt-12 flex flex-col items-center text-muted-foreground">
          <Loader2 className="h-6 w-6 animate-spin" />
          <p className="mt-2 font-mono text-xs uppercase tracking-[0.12em]">加载快照...</p>
        </div>
      )}

      {!loading && !error && cards.length === 0 && (
        <div className="mt-12 flex flex-col items-center text-muted-foreground">
          <p className="font-display text-lg">🎉 全部清空</p>
          <p className="mt-1 font-mono text-xs uppercase tracking-[0.12em]">
            没有需要关注的事
          </p>
        </div>
      )}

      <div className="mt-4 flex flex-col gap-2">
        {cards.map((card) => (
          <NowCard key={card.id} card={card} now={now} />
        ))}
      </div>
    </div>
  );
}
