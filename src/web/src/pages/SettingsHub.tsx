import { lazy, Suspense } from "react";
import { PageLoader } from "@/components/PageLoader";

const Settings = lazy(() => import("./Settings").then((m) => ({ default: m.Settings })));
const Providers = lazy(() => import("./Providers").then((m) => ({ default: m.Providers })));

/** 设置分区（Supabase 式：侧栏设置菜单切换，路由 /settings[/:section]） */
export type SettingsSection = "general" | "providers" | "scheduler" | "network" | "daemon";

const SECTION_HEADER: Record<Exclude<SettingsSection, "providers">, { title: string; desc: string }> = {
  general: { title: "通用", desc: "默认偏好与桌面通知" },
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
    <div className="mx-auto w-full max-w-4xl px-5 py-6">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold leading-tight tracking-tight">{header.title}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{header.desc}</p>
      </header>
      <Suspense fallback={<PageLoader />}>
        <Settings section={section} />
      </Suspense>
    </div>
  );
}
