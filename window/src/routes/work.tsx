import { useLoaderData, type ShouldRevalidateFunctionArgs } from "react-router";
import { WorkBoard } from "@/components/work/board";
import { api } from "@/lib/api";
import { setWorkData, setProjects } from "@/lib/registry";

export async function workLoader() {
  const [projects, tasks, runs] = await Promise.all([api.listProjects(), api.listTasks(), api.listRuns()]);
  setProjects(projects);
  setWorkData(tasks, runs);
  return { projects, tasks, runs };
}

/** Switching lens, team or project only changes the search params; the data stays the same. An explicit revalidate (a new project) still reloads. */
export const workShouldRevalidate = ({ currentUrl, nextUrl, defaultShouldRevalidate }: ShouldRevalidateFunctionArgs) =>
  currentUrl.pathname === nextUrl.pathname && currentUrl.search !== nextUrl.search ? false : defaultShouldRevalidate;

export function WorkPage() {
  const data = useLoaderData<typeof workLoader>();
  return <WorkBoard {...data} />;
}
