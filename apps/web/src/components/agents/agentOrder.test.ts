import { expect, it } from "vite-plus/test";
import { orderAgents } from "./agentOrder";

it("keeps the saved order while reconciling added, removed, and duplicate IDs", () => {
  const agents = [
    { id: "pulse", name: "Pulse", configuration: null },
    { id: "research", name: "Research", configuration: null },
    { id: "planner", name: "Planner", configuration: null },
  ];
  expect(
    orderAgents(agents, ["research", "removed", "pulse", "research"]).map((agent) => agent.id),
  ).toEqual(["research", "pulse", "planner"]);
  expect(orderAgents(agents, [])).toEqual(agents);
});
