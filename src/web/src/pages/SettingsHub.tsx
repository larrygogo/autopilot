import { lazy, Suspense } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { useWebSocket } from "@/hooks/useWebSocket";
import { PageLoader } from "@/components/PageLoader";

const Workflows = lazy(() => import("./Workflows").then((m) => ({ default: m.Workflows })));
const Agents = lazy(() => import("./Agents").then((m) => ({ default: m.Agents })));
const Schedules = lazy(() => import("./Schedules").then((m) => ({ default: m.Schedules })));
const Settings = lazy(() => import("./Settings").then((m) => ({ default: m.Settings })));
const ClarifierSettings = lazy(() => import("./ClarifierSettings").then((m) => ({ default: m.ClarifierSettings })));

const TABS = [
  { key: "workflows", label: "工作流" },
  { key: "agents", label: "智能体" },
  { key: "schedules", label: "定时任务" },
  { key: "general", label: "通用" },
  { key: "clarifier", label: "需求澄清" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

function isValidTab(s: string | null): s is TabKey {
  return s !== null && TABS.some((t) => t.key === s);
}

export function SettingsHub() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const { subscribe } = useWebSocket();

  const raw = params.get("tab");
  const active: TabKey = isValidTab(raw) ? raw : "workflows";

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
          工作流 / 智能体 / 定时任务 / 通用 / 需求澄清
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
          <TabsContent value="workflows">
            <Workflows onJumpToAgent={() => handleChange("agents")} />
          </TabsContent>
          <TabsContent value="agents">
            <Agents embedded />
          </TabsContent>
          <TabsContent value="schedules">
            <Schedules
              onSelectTask={(id) => navigate(`/tasks/${id}`)}
              subscribe={subscribe}
            />
          </TabsContent>
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
