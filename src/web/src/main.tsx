import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import { ThemeProvider } from "./lib/theme";
import { AuthGate } from "./components/AuthGate";
import { setApiToken } from "./lib/api-token";
import "./index.css";

// 二维码 onboarding：URL 里带 ?token=xxx 时自动落 localStorage 并把 token
// 从地址栏抹掉（避免历史记录 / 分享链接泄露）。本机 daemon 生成 qrcode 时
// 把 token 塞 URL，手机扫码 → 第一次进入 → 直接登入，省去手贴流程。
try {
  const params = new URLSearchParams(window.location.search);
  const t = params.get("token");
  if (t) {
    setApiToken(t);
    params.delete("token");
    const newSearch = params.toString();
    const newUrl = window.location.pathname + (newSearch ? "?" + newSearch : "") + window.location.hash;
    window.history.replaceState({}, "", newUrl);
  }
} catch { /* ignore */ }

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ThemeProvider>
      <BrowserRouter>
        <AuthGate>
          <App />
        </AuthGate>
      </BrowserRouter>
    </ThemeProvider>
  </React.StrictMode>
);
