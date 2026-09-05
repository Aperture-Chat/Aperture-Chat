import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { initPwaInstallCapture } from "./lib/pwa";
import { applyCachedBrandBoot } from "./lib/brandTheme";
import "./styles.css";
import "./workspace-refresh.css";

/* Capture the browser's install prompt before first render — Chromium can
 * fire beforeinstallprompt before React mounts. */
initPwaInstallCapture();

/* Paint the last-known tenant branding (title, favicon, theme colors) before
 * React mounts so white-labeled installs never flash the default brand. */
applyCachedBrandBoot();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
