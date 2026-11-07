import { Link, isRouteErrorResponse, useRouteError } from "react-router";

export function RouteError() {
  const error = useRouteError();
  const notFound = isRouteErrorResponse(error) && error.status === 404;
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-sm">
      <p className="font-medium">{notFound ? "Page not found" : "Something went wrong"}</p>
      <Link to="/" className="text-muted-foreground underline underline-offset-2">Back to any-co</Link>
    </div>
  );
}
