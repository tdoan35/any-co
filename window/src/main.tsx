import { StrictMode, useMemo } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router/dom";
import "./lib/fonts";
import "./styles/globals.css";
import { createRouter } from "./router";
import { useStudio } from "./lib/studio";

// Switching studio swaps the API base for every fetch and stream. A fresh, keyed router
// re-runs all loaders and drops every cache and open SSE, so one studio's data never
// paints under another studio's label.
function App() {
  const { studio } = useStudio();
  const router = useMemo(() => createRouter(), [studio?.id]);
  return <RouterProvider key={studio?.id} router={router} />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
