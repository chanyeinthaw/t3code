import { createFileRoute } from "@tanstack/react-router";
import { EnvironmentId, ProjectId } from "@pulse/contracts";

import { ProjectShell } from "../components/ProjectShell";
import ProjectTerminalView from "../components/ProjectTerminalView";
import { useServerKeybindings } from "../rpc/serverState";

function ProjectTerminalRouteView() {
  const params = Route.useParams();
  const environmentId = EnvironmentId.make(params.environmentId);
  const projectId = ProjectId.make(params.projectId);
  const keybindings = useServerKeybindings();
  return (
    <ProjectShell
      context={{
        environmentId,
        projectId,
        activeThreadId: null,
        activeView: "terminal",
      }}
    >
      <ProjectTerminalView
        environmentId={environmentId}
        projectId={projectId}
        keybindings={keybindings}
      />
    </ProjectShell>
  );
}

export const Route = createFileRoute("/_chat/$environmentId/projects/$projectId/terminal")({
  component: ProjectTerminalRouteView,
});
