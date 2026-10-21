import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { initPwaInstallCapture } from "./lib/pwa";
import { applyCachedBrandBoot } from "./lib/brandTheme";
import { installDiagnosticsCapture } from "./lib/diagnostics";
import "./styles.css";
import "./workspace-refresh.css";
import "./console-workspace.css";
import "./library-console.css";
import "./data-protection.css";
import "./draft-editor.css";
import "./branding.css";
import "./support-tickets.css";

/* Capture the browser's install prompt before first render — Chromium can
 * fire beforeinstallprompt before React mounts. */
initPwaInstallCapture();

/* Keep a short in-memory trail of errors so a problem report can include
 * what the person saw (sent only when they choose to include details). */
installDiagnosticsCapture();

/* Paint the last-known tenant branding (title, favicon, theme colors) before
 * React mounts so white-labeled installs never flash the default brand. */
applyCachedBrandBoot();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
