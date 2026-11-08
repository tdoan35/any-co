import { createBrowserRouter, data, redirect } from "react-router";
import { RootLayout, rootLoader } from "@/routes/root";
import { RouteError } from "@/routes/error";
import { HomePage } from "@/routes/home";
import { AgentsPage } from "@/routes/agents";
import { WeavePage } from "@/routes/weave";
import { runRedirectLoader } from "@/routes/run";
import { WorkPage, workLoader, workShouldRevalidate } from "@/routes/work";
import { TaskPage, taskLoader } from "@/routes/task";
import { SchedulePageRoute, scheduleLoader, scheduleShouldRevalidate } from "@/routes/schedule";
import { ReportPage, reportLoader } from "@/routes/report";

// A fresh router per studio switch: loaders re-run against the new API base.
export const createRouter = () => createBrowserRouter([
  {
    element: <RootLayout />,
    loader: rootLoader,
    children: [
      {
        // Pathless layout so errors render inside the app shell.
        errorElement: <RouteError />,
        children: [
          { index: true, element: <HomePage /> },
          { path: "weave", element: <WeavePage /> },
          { path: "agents", element: <AgentsPage /> },
          // Old Teams links land on the studio chart.
          { path: "teams", loader: () => redirect("/agents") },
          { path: "work", element: <WorkPage />, loader: workLoader, shouldRevalidate: workShouldRevalidate },
          { path: "schedule", element: <SchedulePageRoute />, loader: scheduleLoader, shouldRevalidate: scheduleShouldRevalidate },
          { path: "work/:taskId", element: <TaskPage />, loader: taskLoader },
          // Runs are a task's loops now; old links redirect to the task.
          { path: "runs/:id", loader: runRedirectLoader },
          { path: "reports/:id", element: <ReportPage />, loader: reportLoader },
          { path: "*", loader: () => { throw data(null, { status: 404 }); } },
        ],
      },
    ],
  },
]);
