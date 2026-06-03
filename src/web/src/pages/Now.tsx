import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useNowCards } from "@/hooks/useNowCards";
import { NowCard } from "@/components/NowCard";
import { NowEmptyGuide } from "@/components/NowEmptyGuide";
import { PageHero } from "@/components/PageHero";
import { Loader2, RefreshCw, ListChecks } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api, type DoctorReportWithDismiss } from "@/hooks/useApi";

export function Now() {
  const { cards, loading, error, refresh } = useNowCards();
  const [now, setNow] = useState(Date.now());
  const [setupReport, setSetupReport] = useState<DoctorReportWithDismiss | null>(null);

  // 每秒更新 now，让卡片"等候 Xs"实时滚动
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    api.setupStatus().then(setSetupReport).catch(() => {});
  }, []);

  const showSetupBanner = !!setupReport && setupReport.status === "error" && !setupReport.setupDismissed;

  return (
    <div className="mx-auto max-w-4xl px-4 py-6 md:px-6 md:py-8">
      {showSetupBanner && (
        <div className="mb-4 border border-border rounded-md p-3 text-sm">
          ⚠ 未完成首跑配置
          <Link to="/setup" className="ml-2 underline">开始 ▸</Link>
        </div>
      )}
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
            className="text-[11px]"
          >
            <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${loading ? "animate-spin" : ""}`} />
            刷新
          </Button>
        }
      />

      {error && (
        <div className="mt-4 border border-l-4 border-border border-l-destructive bg-card px-4 py-3 rounded-lg">
          <p className="text-[10px] text-destructive mb-1">
            ERROR
          </p>
          <p className="text-sm text-foreground">{error}</p>
        </div>
      )}

      {loading && cards.length === 0 && (
        <div className="mt-12 flex flex-col items-center text-muted-foreground">
          <Loader2 className="h-6 w-6 animate-spin" />
          <p className="mt-2 text-xs">加载快照...</p>
        </div>
      )}

      {!loading && !error && cards.length === 0 && <NowEmptyGuide />}

      <div className="mt-4 flex flex-col gap-2">
        {cards.map((card) => (
          <NowCard key={card.id} card={card} now={now} />
        ))}
      </div>

      {/* 跳转任务看板看完整任务列表（在跑 / 完成 / 失败 都在那里） */}
      {cards.length > 0 && (
        <div className="mt-8 flex justify-center border-t border-dashed border-border pt-4">
          <Link
            to="/tasks"
            className="inline-flex items-center gap-2 text-[11px] text-muted-foreground hover:text-foreground"
          >
            <ListChecks className="h-3.5 w-3.5" />
            看所有任务（进行中 / 完成 / 失败）→
          </Link>
        </div>
      )}
    </div>
  );
}
