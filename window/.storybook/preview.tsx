import type { Preview } from "@storybook/react-vite";
import "../src/styles/globals.css";
import "../src/lib/fonts";

const preview: Preview = {
  parameters: {
    layout: "centered",
    controls: { matchers: { color: /(background|color)$/i, date: /Date$/i } },
    a11y: {
      // Fail browser story tests (vitest project "storybook") on accessibility
      // violations instead of only surfacing them in the addon panel. Do not
      // downgrade to "warning" or disable rules globally — fix the story.
      test: "error",
    },
  },
  globalTypes: {
    theme: {
      description: "Light/dark via the app's `.dark` class on <html>",
      toolbar: {
        title: "Theme",
        icon: "mirror",
        items: [
          { value: "light", icon: "sun", title: "Light" },
          { value: "dark", icon: "moon", title: "Dark" },
        ],
        dynamicTitle: true,
      },
    },
  },
  initialGlobals: { theme: "light" },
  decorators: [
    (Story, context) => {
      document.documentElement.classList.toggle("dark", context.globals.theme === "dark");
      return <Story />;
    },
  ],
};

export default preview;
