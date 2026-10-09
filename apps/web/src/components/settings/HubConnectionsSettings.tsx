import { type EnvironmentId } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { environmentCatalog } from "../../connection/catalog";
import { readHubCatalog } from "../../hub";
import { useEnvironments } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { ConnectionsSettings } from "./ConnectionsSettings";
import { SettingsPageContainer } from "./settingsLayout";
import { HubConnectionSettings } from "./HubConnectionSettings";
import { HubAccessSettings } from "./HubAccessSettings";
import { HubEnvironmentListRow } from "./HubEnvironmentListRow";
import { LoadBalancingSettings } from "./LoadBalancingSettings";
import { GitHubRoutingSettings } from "./GitHubRoutingSettings";

/** Hub settings are separate from the upstream Connections page to keep syncs small. */
export function HubConnectionsSettings() {
  const { environments } = useEnvironments();
  const setEnabled = useAtomCommand(environmentCatalog.setEnabled, { reportFailure: false });
  async function toggleEnvironment(environmentId: EnvironmentId, enabled: boolean) {
    const result = await setEnabled({ environmentId, enabled });
    if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
    const error = squashAtomCommandFailure(result);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: `Could not switch environment ${enabled ? "on" : "off"}`,
        description: error instanceof Error ? error.message : "Could not update the connection.",
      }),
    );
  }
  if (readHubCatalog() === null) return <ConnectionsSettings />;
  return (
    <SettingsPageContainer width="wide">
      <HubConnectionSettings />
      <HubAccessSettings
        renderEnvironment={(environmentId, menuItems) => {
          const environment = environments.find((entry) => entry.environmentId === environmentId);
          return environment ? (
            <HubEnvironmentListRow
              key={environmentId}
              environment={environment}
              onSetEnabled={(id, enabled) => void toggleEnvironment(id, enabled)}
              menuItems={menuItems}
            />
          ) : null;
        }}
      />
      <LoadBalancingSettings environments={environments} />
      <GitHubRoutingSettings environments={environments} />
    </SettingsPageContainer>
  );
}
