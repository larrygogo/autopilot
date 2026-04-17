import React, { useState } from "react";
import { Providers } from "./Providers";
import { Agents } from "./Agents";
import { Settings } from "./Settings";

export type ConfigTab = "providers" | "agents" | "advanced";

const TABS: { key: ConfigTab; label: string }[] = [
  { key: "providers", label: "模型提供商" },
  { key: "agents", label: "智能体" },
  { key: "advanced", label: "高级 (YAML)" },
];

export function Config({ initialTab = "providers" }: { initialTab?: ConfigTab }) {
  const [tab, setTab] = useState<ConfigTab>(initialTab);

  return (
    <div className="container">
      <div className="page-hdr">
        <h2>配置</h2>
      </div>

      <div className="subtabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            className={`subtab ${tab === t.key ? "active" : ""}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="subtab-content">
        {tab === "providers" && <Providers embedded />}
        {tab === "agents" && <Agents embedded />}
        {tab === "advanced" && <Settings embedded />}
      </div>
    </div>
  );
}
