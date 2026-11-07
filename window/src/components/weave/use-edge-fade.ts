import { useEffect, useRef, useState } from "react";

/** Scrollbar stays invisible until you hover that section (same as the sidebar's lists). */
export const quietScroll = "[scrollbar-width:thin] [scrollbar-color:transparent_transparent] hover:[scrollbar-color:var(--border)_transparent]";

const FADE = 40;

/**
 * Fades a scroll container's edges where more content is hidden, so it doesn't cut off hard
 * (the sidebar's Sessions list does the same). Also re-measures when the content grows or is swapped.
 */
export function useEdgeFade<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [edges, setEdges] = useState({ top: false, bottom: false });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const top = el.scrollTop > 4, bottom = el.scrollTop + el.clientHeight < el.scrollHeight - 4;
      setEdges((e) => (e.top === top && e.bottom === bottom ? e : { top, bottom }));
    };
    // ResizeObserver reports once on observe, so the first measurement needs no explicit call.
    const ro = new ResizeObserver(update);
    const watch = () => { ro.observe(el); for (const c of el.children) ro.observe(c); };
    watch();
    const mo = new MutationObserver(watch);
    mo.observe(el, { childList: true });
    el.addEventListener("scroll", update, { passive: true });
    return () => { ro.disconnect(); mo.disconnect(); el.removeEventListener("scroll", update); };
  }, []);
  const mask = `linear-gradient(to bottom, ${edges.top ? `transparent 0, #000 ${FADE}px` : "#000 0"}, ${edges.bottom ? `#000 calc(100% - ${FADE}px), transparent 100%` : "#000 100%"})`;
  return [ref, { maskImage: mask, WebkitMaskImage: mask }] as const;
}
