import { createFileRoute } from "@tanstack/react-router";

import { HubConnectionsSettings } from "../components/settings/HubConnectionsSettings";

export const Route = createFileRoute("/settings/hub-connections")({
  component: HubConnectionsSettings,
});
