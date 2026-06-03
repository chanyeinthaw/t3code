import { createFileRoute } from "@tanstack/react-router";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";

import ProjectTerminalView from "../components/ProjectTerminalView";
import { useServerKeybindings } from "../rpc/serverState";

function ProjectTerminalRouteView() {
  const params = Route.useParams();
  const keybindings = useServerKeybindings();
  return (
    <ProjectTerminalView
      environmentId={EnvironmentId.make(params.environmentId)}
      projectId={ProjectId.make(params.projectId)}
      keybindings={keybindings}
    />
  );
}

export const Route = createFileRoute("/_chat/$environmentId/project/$projectId/terminal")({
  component: ProjectTerminalRouteView,
});
