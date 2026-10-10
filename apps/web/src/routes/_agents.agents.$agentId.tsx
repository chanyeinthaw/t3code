import { createFileRoute } from "@tanstack/react-router";
import { AgentChatView } from "../components/AgentChatView";

export const Route = createFileRoute("/_agents/agents/$agentId")({ component: AgentChat });

function AgentChat() {
  const { agentId } = Route.useParams();
  return <AgentChatView key={agentId} agentId={agentId} />;
}
