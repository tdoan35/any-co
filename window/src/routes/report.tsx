import { data, Link, useLoaderData, type LoaderFunctionArgs } from "react-router";
import { PageHeader } from "@/components/shell/app-shell";
import { headerTitle } from "@/components/studio/studio-ui";
import { ReportView } from "@/components/report/report-view";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

export async function reportLoader({ params }: LoaderFunctionArgs) {
  const report = await api.getReport(params.id!);
  if (!report) throw data(null, { status: 404 });
  const run = await api.getRun(report.runId);
  const task = run && await api.getTask(run.taskId);
  const project = task && (await api.listProjects()).find((p) => p.id === task.projectId);
  return { report, run, task, project };
}

export function ReportPage() {
  const { report, run, task, project } = useLoaderData<typeof reportLoader>();
  const crumb = "font-normal text-muted-foreground hover:text-foreground";
  return (
    <div className="flex h-full flex-col">
      <PageHeader>
        <span className={cn(headerTitle, "flex min-w-0 items-center gap-2")}>
          <Link to="/work" className={crumb}>Work</Link><span className="font-normal text-muted-foreground">/</span>
          {project && <><Link to={`/work?project=${project.id}`} className={cn(crumb, "hidden truncate sm:inline")}>{project.name}</Link><span className="hidden font-normal text-muted-foreground sm:inline">/</span></>}
          {task && <><Link to={`/work/${task.id}`} className={cn(crumb, "truncate")}>{task.title}</Link><span className="font-normal text-muted-foreground">/</span></>}
          <span>Report</span>
        </span>
      </PageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto"><ReportView report={report} loopHref={task ? `/work/${task.id}${run && task.runIds[task.runIds.length - 1] !== run.id ? `?loop=${run.n}` : ""}` : undefined} /></div>
    </div>
  );
}
