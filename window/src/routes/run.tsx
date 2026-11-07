import { data, redirect, type LoaderFunctionArgs } from "react-router";
import { api } from "@/lib/api";

/** Old run links (`/runs/:id`) land on their task, on the same loop, keeping `?live=1`. */
export async function runRedirectLoader({ params, request }: LoaderFunctionArgs) {
  const run = await api.getRun(params.id!);
  if (!run) throw data(null, { status: 404 });
  const task = await api.getTask(run.taskId);
  const next = new URLSearchParams(new URL(request.url).search);
  if (task && task.runIds[task.runIds.length - 1] !== run.id) next.set("loop", String(run.n));
  const qs = next.toString();
  return redirect(`/work/${run.taskId}${qs ? `?${qs}` : ""}`);
}
