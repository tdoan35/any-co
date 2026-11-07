import { Outlet, useRevalidator } from "react-router";
import { useEffect, useRef } from "react";
import { AppShell } from "@/components/shell/app-shell";
import { api, httpMode, streamUrl } from "@/lib/api";
import { setRegistry, setWorkData } from "@/lib/registry";
import { setWeaveSnapshot } from "@/lib/weave-store";
import { AppEventSchema } from "@fabric/contracts";
import { publishSessionDesktop, publishSessionMessage, publishStreamConnected } from "@/lib/chat/events";

export async function rootLoader() {
  const [registry, tasks, runs, weave] = await Promise.all([
    api.getRegistry(), api.listTasks(), api.listRuns(), api.getWeave(),
  ]);
  setRegistry(registry);
  setWorkData(tasks, runs);
  setWeaveSnapshot(weave);
  return null;
}

export function RootLayout() {
  const revalidator = useRevalidator();
  const revalidateRef = useRef(revalidator.revalidate);
  useEffect(() => { revalidateRef.current = revalidator.revalidate; }, [revalidator.revalidate]);
  useEffect(() => {
    if (!httpMode) return;
    let stopped = false;
    let source: EventSource | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
      if (stopped) return;
      source = new EventSource(streamUrl("/stream"));
      source.onopen = publishStreamConnected;
      source.addEventListener("app", (message) => {
        try {
          const parsed = AppEventSchema.safeParse(JSON.parse((message as MessageEvent).data));
          if (!parsed.success) { console.warn("[app stream] invalid event", parsed.error.issues); return; }
          const event = parsed.data;
          if (event.type === "registry.changed") {
            void api.getRegistry().then(setRegistry).catch((err) => console.warn("[app stream] registry refresh failed", err));
            revalidateRef.current();
          } else if (event.type === "weave.changed") {
            void api.getWeave().then(setWeaveSnapshot).catch((err) => console.warn("[app stream] weave refresh failed", err));
          } else if (event.type === "task.changed" || event.type === "run.changed" || event.type === "schedule.changed") {
            revalidateRef.current();
          } else if (event.type === "session.message") {
            // The open thread appends it (CHAT-14); the sidebar row's status comes with the registry.
            publishSessionMessage(event);
            void api.getRegistry().then(setRegistry).catch((err) => console.warn("[app stream] registry refresh failed", err));
          } else if (event.type === "session.desktop") {
            publishSessionDesktop(event);
          }
        } catch (err) { console.warn("[app stream] parse failed", err); }
      });
      source.onerror = () => {
        source?.close();
        if (!stopped) retry = setTimeout(connect, 1000);
      };
    };
    connect();
    return () => { stopped = true; source?.close(); if (retry) clearTimeout(retry); };
  }, []);
  return <AppShell><Outlet /></AppShell>;
}
