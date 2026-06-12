import { lazy, Suspense } from "react";
import { PageShell } from "@/components/pro";
import { PageLoader } from "@/components/PageLoader";

const Settings = lazy(() => import("./Settings").then((m) => ({ default: m.Settings })));
const Providers = lazy(() => import("./Providers").then((m) => ({ default: m.Providers })));
const ApiKeysPage = lazy(() => import("./settings/ApiKeysPage").then((m) => ({ default: m.ApiKeysPage })));

/** 设置分区（Supabase 式：侧栏设置菜单切换，路由 /settings[/:section]） */
export type SettingsSection = "general" | "providers" | "api-keys" | "scheduler" | "network" | "daemon";

const SECTION_HEADER: Record<Exclude<SettingsSection, "providers">, { title: string; desc: string }> = {
  general: { title: "通用", desc: "默认偏好与桌面通知" },
  "api-keys": { title: "API 密钥", desc: "API 直连模式的供应商密钥（本机加密存储，CLI 模式无需配置）" },
  scheduler: { title: "任务调度", desc: "全局最大并发任务数等调度行为" },
  network: { title: "网络访问", desc: "daemon 监听地址与 API token" },
  daemon: { title: "Daemon", desc: "运行状态、日志与配置文件" },
};

export function SettingsHub({ section = "general" }: { section?: SettingsSection }) {
  // 提供商分区自带页头（含「重新检查」操作），不套通用 header
  if (section === "providers") {
    return (
      <Suspense fallback={<PageLoader />}>
        <Providers />
      </Suspense>
    );
  }

  const header = SECTION_HEADER[section];
  return (
    <PageShell width="form" hero={{ title: header.title, subtitle: header.desc }}>
      <Suspense fallback={<PageLoader />}>
        {section === "api-keys" ? <ApiKeysPage /> : <Settings section={section} />}
      </Suspense>
    </PageShell>
  );
}
