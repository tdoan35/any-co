import type { StorybookConfig } from "@storybook/react-vite";

const config: StorybookConfig = {
  stories: ["../src/**/*.stories.@(ts|tsx)"],
  staticDirs: ["../public"],
  addons: ["@storybook/addon-a11y", "@storybook/addon-vitest"],
  // Reuse the app's vite config as-is: the `@` alias, @tailwindcss/vite and the react-swc
  // plugin all come from apps/web/vite.config.ts, so stories build exactly like the app.
  framework: {
    name: "@storybook/react-vite",
    options: { builder: { viteConfigPath: "./vite.config.ts" } },
  },
};

export default config;
