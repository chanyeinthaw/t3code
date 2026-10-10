import type { AgentDefinition } from "@t3tools/contracts";

/** Retain this device's order, omit removed agents, and append newly created agents. */
export function orderAgents(
  agents: ReadonlyArray<AgentDefinition>,
  savedOrder: ReadonlyArray<string>,
) {
  const remaining = new Map(agents.map((agent) => [agent.id, agent]));
  const ordered: AgentDefinition[] = [];
  for (const id of savedOrder) {
    const agent = remaining.get(id);
    if (!agent) continue;
    ordered.push(agent);
    remaining.delete(id);
  }
  return [...ordered, ...remaining.values()];
}
