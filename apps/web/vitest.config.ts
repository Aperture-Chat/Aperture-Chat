import { configDefaults, defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: {
    // mammoth's node build cannot read the { arrayBuffer } uploads the
    // browser sends; tests must run the same browser bundle Vite serves.
    alias: [{ find: /^mammoth$/, replacement: "mammoth/mammoth.browser.js" }],
  },
  test: {
    // Training-generator regressions use node:test and run separately in CI.
    exclude: [...configDefaults.exclude, "scripts/**/*.test.cjs"],
    environment: "jsdom",
    setupFiles: "./src/test-setup.ts",
  },
});
