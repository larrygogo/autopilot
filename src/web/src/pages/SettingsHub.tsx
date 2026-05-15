import { lazy, Suspense } from "react";
import { useSearchParams } from "react-router-dom";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { PageLoader } from "@/components/PageLoader";

const Settings = lazy(() => import("./Settings").then((m) => ({ default: m.Settings })));
const ClarifierSettings = lazy(() => import("./ClarifierSettings").then((m) => ({ default: m.ClarifierSettings })));

// 工作流 / 定时任务已提到顶层导航（"编排"分组），不在设置内
const TABS = [
  { key: "general", label: "通用" },
  { key: "clarifier", label: "需求澄清" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

function isValidTab(s: string | null): s is TabKey {
  return s !== null && TABS.some((t) => t.key === s);
}

export function SettingsHub() {
  const [params, setParams] = useSearchParams();

  const raw = params.get("tab");
  const active: TabKey = isValidTab(raw) ? raw : "general";

  const handleChange = (next: string) => {
    const np = new URLSearchParams(params);
    np.set("tab", next);
    setParams(np, { replace: true });
  };

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 md:px-6 md:py-8">
      <header className="mb-4 border-b-[1.5px] border-foreground/30 pb-3">
        <h1 className="font-display text-2xl font-bold uppercase tracking-wider">设置 · SETTINGS</h1>
        <p className="font-mono text-xs uppercase tracking-[0.12em] text-muted-foreground mt-1">
          通用 / 需求澄清
        </p>
      </header>

      <Tabs value={active} onValueChange={handleChange}>
        <TabsList>
          {TABS.map((t) => (
            <TabsTrigger key={t.key} value={t.key}>
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>

        <Suspense fallback={<PageLoader />}>
          <TabsContent value="general">
            <Settings embedded />
          </TabsContent>
          <TabsContent value="clarifier">
            <ClarifierSettings />
          </TabsContent>
        </Suspense>
      </Tabs>
    </div>
  );
}
