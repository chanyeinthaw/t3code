import { Outlet, createFileRoute } from "@tanstack/react-router";

function ProjectThreadsLayoutRouteView() {
  return <Outlet />;
}

export const Route = createFileRoute("/_chat/$environmentId/projects/$projectId/threads")({
  component: ProjectThreadsLayoutRouteView,
});
