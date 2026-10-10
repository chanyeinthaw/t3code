import { createFileRoute } from "@tanstack/react-router";
import { EnvironmentId } from "@t3tools/contracts";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import { AgentsSettings } from "../components/settings/AgentsSettings";

export const Route = createFileRoute("/settings/agents")({
  validateSearch: (search: Record<string, unknown>): { agent?: string } =>
    typeof search.agent === "string" ? { agent: search.agent } : {},
  component: AgentSettingsPage,
});

function AgentSettingsPage() {
  const { agent, machine } = Route.useSearch();
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const environmentId = machine
    ? EnvironmentId.make(machine)
    : (primaryEnvironmentId ?? environments[0]?.environmentId ?? null);
  return (
    <AgentsSettings
      key={environmentId ?? ""}
      targetEnvironmentId={environmentId}
      {...(agent ? { initialAgentId: agent } : {})}
    />
  );
}
