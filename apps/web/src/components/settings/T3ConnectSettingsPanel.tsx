import { CloudIcon, SmartphoneIcon } from "lucide-react";

import { hasCloudPublicConfig, resolveCloudPublicConfig } from "../../cloud/publicConfig";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { SettingsRow, SettingsSection } from "./settingsLayout";

function EmptyNotificationDevices() {
  return (
    <Empty className="min-h-52">
      <EmptyMedia variant="icon">
        <SmartphoneIcon />
      </EmptyMedia>
      <EmptyHeader>
        <EmptyTitle>No notification devices</EmptyTitle>
        <EmptyDescription>
          Sign in on the mobile app to register a device for T3 Connect notifications.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

export function T3ConnectSettingsPanel() {
  if (!hasCloudPublicConfig()) return null;

  const config = resolveCloudPublicConfig();

  return (
    <>
      <SettingsSection title="T3 Connect" icon={<CloudIcon className="size-3.5" />}>
        <SettingsRow title="Account" description="Manage your T3 Connect session." />
        <SettingsRow
          title="Managed relay"
          description={`Relay endpoint: ${config.relayUrl}`}
          status="Available"
        />
      </SettingsSection>

      <SettingsSection title="T3 Connect preferences">
        <SettingsRow
          title="Publish agent activity"
          description="Allow this environment to send agent activity to your notification devices."
          status="Requires T3 Connect account linking"
        />
      </SettingsSection>

      <SettingsSection title="Notification devices">
        <EmptyNotificationDevices />
      </SettingsSection>
    </>
  );
}
