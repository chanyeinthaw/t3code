import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_agents/agents/one-chat")({
  beforeLoad: () => {
    throw redirect({ to: "/agents/$agentId", params: { agentId: "pulse" }, replace: true });
  },
});
