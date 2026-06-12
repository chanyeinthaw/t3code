import { Outlet, createFileRoute } from "@tanstack/react-router";

function EnvironmentProjectsLayoutRouteView() {
  return <Outlet />;
}

export const Route = createFileRoute("/_chat/$environmentId/projects")({
  component: EnvironmentProjectsLayoutRouteView,
});
