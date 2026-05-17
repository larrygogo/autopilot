import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import { ThemeProvider } from "./lib/theme";
import { TokenGate } from "./components/TokenGate";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ThemeProvider>
      <BrowserRouter>
        <TokenGate>
          <App />
        </TokenGate>
      </BrowserRouter>
    </ThemeProvider>
  </React.StrictMode>
);
