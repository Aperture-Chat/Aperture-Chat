import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: {
    // mammoth's node build cannot read the { arrayBuffer } uploads the
    // browser sends; tests must run the same browser bundle Vite serves.
    alias: [{ find: /^mammoth$/, replacement: "mammoth/mammoth.browser.js" }],
  },
  test: {
    environment: "jsdom",
    setupFiles: "./src/test-setup.ts",
  },
});
