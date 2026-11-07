# Fabric web

Frontend mockup for Fabric, built with Vite, React 19, React Router and Tailwind v4.

```bash
npm install
npm run dev        # http://localhost:3000
npm run build      # typecheck + production bundle in dist/
npm run preview    # serve dist/ locally
npm run lint
```

`dist/` is a static bundle: host it anywhere that rewrites unknown paths to `index.html`, or load it from an Electron shell.
