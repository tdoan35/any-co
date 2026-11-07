# Studio window (lifted from the Fabric web app)

Vite + React Router (data router) single-page app. No server rendering — the backend is the any-co adapter (to be written), not Fabric's server, reached only through `src/lib/api`. Keep it that way so the same build can ship to the web and inside Electron.

Paths below are relative to `apps/web`. Run scripts here with `npm run <script>`, or from the repo root via `npm run window:<dev|build|typecheck|electron>`.

- Routes: `src/router.tsx`; route components live in `src/routes/`.
- Navigation: `Link` / `useLocation` / `useSearchParams` / `useParams` from `react-router`.
- Styles: Tailwind v4 via `@tailwindcss/vite`; theme tokens in `src/styles/globals.css`.
- UI primitives: shadcn (`components.json`), in `src/components/ui/`.
- Desktop: `electron/main.mjs` wraps the same build. `npm run electron:dev` (Vite + HMR inside Electron), `npm run electron:start` (built `dist/` over the `app://` protocol), `npm run electron:dist` (installer into `release/` via electron-builder). Renderer code must not assume Electron; desktop-only APIs go through `electron/preload.cjs`, read via `desktop` from `src/lib/desktop.ts` (undefined on the web). The window is frameless (macOS keeps traffic lights); `src/components/shell/title-bar.tsx` draws the bar, and layout offsets by `--titlebar-height` (0 on the web).
- Storybook: stories sit next to their components (`*.stories.tsx`), with the harness in `.storybook/`. Fabric's `docs/STORYBOOK.md` was not copied.

- Origin: copied from `~/Desktop/projects/fabric` on 2026-11-06 (`apps/web`, `packages/contracts`, `packages/fixtures`). Internal names still say `fabric` (`@fabric/*`, `fabricDesktop`, `app://fabric`); rename only with a reason.
- The window must not contain game content. `packages/fixtures` is Fabric demo data for mock mode only.
- Adapter: `window/server/` is an HTTP server, read-only except chat (`POST /api/sessions[/:id/messages]`, see `chat.ts`: sessions in `runs/chat/`, one `studio-head` runner turn per message, each human message appended to the ledger as an intervention from `STUDIO_EVENT_START`). It maps `runs/` + `agents/` onto the contract the UI reads (`runs.ts` transcript→RunEvents, `registry.ts` specs→agents/teams/org, `weave.ts` presence/pulse). The UI uses it when `VITE_API_MODE=http` (`npm run window:live`). Weave `items` (inbox) is empty until the approval ledger exists. Only localhost and the Electron app origins may call it. `liveChat` (`src/lib/chat/demo.ts`) hides Fabric chat features that don't apply. Tests: `window/server/*.test.ts`; real-data check: `npm run window:check`.
- Branding: product is "any-co game studio" (wordmark "any-co"). Fabric's persona "Dana" is the Studio Head here; visible strings on Studio, Weave and Work are renamed. Still Dana/Fabric: chat, Schedule and browser-card code, mock data, and internal identifiers.
