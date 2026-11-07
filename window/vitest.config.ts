import path from "node:path";
import { defineConfig } from "vitest/config";
import { storybookTest } from "@storybook/addon-vitest/vitest-plugin";
import { playwright } from "@vitest/browser-playwright";
import tailwindcss from "@tailwindcss/vite";

// addon-vitest merges the Storybook vite config, but `viteConfigPath` in
// .storybook/main.ts is only honored by builder-vite's own build/dev path, not
// by the vitest server that serves story modules to the browser tester. Mirror
// the app's resolve.alias and Tailwind setup here so stories load and render
// exactly like they do in the app and in the Storybook workbench.
const dirname = path.dirname(import.meta.filename);

export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        plugins: [tailwindcss(), storybookTest({ configDir: path.join(dirname, ".storybook") })],
        resolve: {
          alias: { "@": path.resolve(dirname, "src") },
        },
        test: {
          name: "storybook",
          browser: {
            enabled: true,
            headless: true,
            provider: playwright(),
            instances: [{ browser: "chromium" }],
          },
          setupFiles: [path.resolve(dirname, ".storybook/vitest.setup.ts")],
        },
        // Pre-bundle the a11y addon's preview for the browser tester; without
        // this vitest re-optimizes deps mid-run and reloads (breaking tests).
        optimizeDeps: { include: ["@storybook/addon-a11y/preview"] },
      },
    ],
  },
});
