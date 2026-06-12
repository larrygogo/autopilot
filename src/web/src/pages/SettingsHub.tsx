import { lazy, Suspense } from "react";
import { useSearchParams } from "react-router-dom";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { PageLoader } from "@/components/PageLoader";

const Settings = lazy(() => import("./Settings").then((m) => ({ default: m.Settings })));
const ApiKeysPage = lazy(() => import("./settings/ApiKeysPage").then((m) => ({ default: m.ApiKeysPage })));

// 工作流 / 定时任务已提到顶层导航（"编排"分组），不在设置内
// 需求澄清模型已移除全局命名 clarifier agent，改由 requirement 维度配置（clarifier_provider/model）
const TABS = [
  { key: "general", label: "通用" },
  { key: "api-keys", label: "API 密钥" },
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
      <header className="mb-4 border-b border-border pb-3">
        <h1 className="font-display text-2xl font-bold">设置 · SETTINGS</h1>
        <p className="text-xs text-muted-foreground mt-1">
          通用 · API 密钥
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
          <TabsContent value="api-keys">
            <ApiKeysPage />
          </TabsContent>
        </Suspense>
      </Tabs>
    </div>
  );
}
