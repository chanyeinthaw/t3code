import { createFileRoute, redirect } from "@tanstack/react-router";
import { workspaceDestination } from "../components/agents/workspaceMode";

export const Route = createFileRoute("/_agents/agents/")({
  beforeLoad: () => {
    throw redirect({ href: workspaceDestination("agents"), replace: true });
  },
});
