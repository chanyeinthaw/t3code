import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/settings/one-chat")({
  beforeLoad: () => {
    throw redirect({ to: "/settings/agents" });
  },
});
