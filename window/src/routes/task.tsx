import { data, useLoaderData, type LoaderFunctionArgs } from "react-router";
import { TaskScreen } from "@/components/work/loop-view";
import { api, httpMode } from "@/lib/api";
import type { ClockStart } from "@/lib/use-run-clock";

/** `?loop=N` picks a loop (the latest by default); `?live=1` plays a recorded loop as the live start. */
export async function taskLoader({ params, request }: LoaderFunctionArgs) {
  const task = await api.getTask(params.taskId!);
  if (!task) throw data(null, { status: 404 });
  const search = new URL(request.url).searchParams;
  const [projects, allRuns] = await Promise.all([api.listProjects(), api.listRuns()]);
  const loops = task.runIds.map((id) => allRuns.find((r) => r.id === id)!).filter(Boolean);
  const run = loops.find((l) => String(l.n) === search.get("loop")) ?? loops[loops.length - 1];
  const [events, snapshots, report] = run
    ? await Promise.all([api.getRunEvents(run.id), api.getSnapshots(run.id), run.reportId ? api.getReport(run.reportId) : undefined])
    : [[], [], undefined];
  const start: ClockStart = !httpMode && run && search.get("live") === "1" && run.recorded ? "sim"
    : run && (run.status === "running" || (!httpMode && run.status === "blocked")) ? "now" : "end";
  return { task, project: projects.find((p) => p.id === task.projectId)!, loops, run, events, snapshots, report, start, liveZoom: search.get("live") === "1" };
}

export function TaskPage() {
  const d = useLoaderData<typeof taskLoader>();
  return <TaskScreen {...d} />;
}
