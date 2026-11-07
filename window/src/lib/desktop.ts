// The Electron preload's API (electron/preload.cjs). Undefined on the web, so
// always feature-check: `desktop?.window.minimize()`.
export type AppCommand = "reload" | "zoom-in" | "zoom-out" | "zoom-reset" | "toggle-fullscreen" | "toggle-devtools" | "quit";

export interface FabricDesktop {
  platform: NodeJS.Platform;
  app: {
    command: (command: AppCommand) => void;
    zoom: () => Promise<{ factor: number; min: number; max: number }>;
  };
  window: {
    minimize: () => void;
    toggleMaximize: () => void;
    close: () => void;
    isMaximized: () => Promise<boolean>;
    onMaximizedChange: (cb: (maximized: boolean) => void) => () => void;
  };
}

declare global {
  interface Window { fabricDesktop?: FabricDesktop }
}

export const desktop = typeof window === "undefined" ? undefined : window.fabricDesktop;
