// Title-bar stories (ANY-11 M2). The bar is Electron-only by design: AppMenu commands
// (reload/zoom/devtools/quit), window controls, the drag region and the tab strip all
// reach through `window.fabricDesktop` (src/lib/desktop.ts). Storybook runs as plain
// web — `desktop` is undefined, so the bar renders nothing. Faking a desktop global to
// exercise those paths is explicitly out of bounds for this card, so they are inventoried
// as NOT EXECUTABLE in Storybook rather than simulated:
//   - AppMenu / zoom / window controls (minimize, maximize, close) — need the preload API.
//   - [-webkit-app-region:drag] hit-targets — meaningless outside a window manager.
//   - macOS traffic-light inset (padLeft = 80) — depends on desktop.platform.
//   - The title bar's own sidebar toggle + search — web renders its own in the sidebar
//     header (covered by Shell/AppShell › Sidebar toggle).

import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";
import { TitleBar } from "./title-bar";

const meta = {
  title: "Shell/TitleBar",
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

/** On the web the bar is a no-op — production mounts its own header actions instead. */
export const WebRenderNothing: Story = {
  name: "Web renders nothing",
  render: () => <TitleBar onOpenSettings={() => {}} />,
  play: async ({ canvasElement }) => {
    expect(canvasElement.children).toHaveLength(0);
    expect(canvasElement.querySelector("header")).toBeNull();
  },
};
