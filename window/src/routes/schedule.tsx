import { useLoaderData, type ShouldRevalidateFunctionArgs } from "react-router";
import { SchedulePage } from "@/components/schedule/schedule-page";
import { api } from "@/lib/api";
import { weekBounds } from "@/lib/schedule";

/** The week comes from `?week=` (that week's Sunday); everything else about the page is client
 *  state (filters, selection), so the loader only re-runs when the week moves. */
export async function scheduleLoader({ request }: { request: Request }) {
  const { searchParams } = new URL(request.url);
  const { from, to, key } = weekBounds(searchParams.get("week"));
  const [schedules, occurrences] = await Promise.all([
    api.listSchedules(),
    api.listOccurrences(from.toISOString(), to.toISOString()),
  ]);
  return { schedules, occurrences, week: key };
}

/** Week changes reload; a selection-only change (?occ=) doesn't. */
export const scheduleShouldRevalidate = ({ currentUrl, nextUrl, defaultShouldRevalidate }: ShouldRevalidateFunctionArgs) => {
  const weekOf = (url: URL) => new URLSearchParams(url.search).get("week");
  if (currentUrl.pathname !== nextUrl.pathname || weekOf(currentUrl) !== weekOf(nextUrl)) return defaultShouldRevalidate;
  return currentUrl.search === nextUrl.search ? defaultShouldRevalidate : false;
};

export function SchedulePageRoute() {
  const data = useLoaderData<typeof scheduleLoader>();
  return <SchedulePage {...data} />;
}
