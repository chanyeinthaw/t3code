import { resolveEnvironmentMachineKind, type EnvironmentId } from "@t3tools/contracts";
import { ChevronDownIcon } from "lucide-react";
import { useEnvironments } from "../../state/environments";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { InlineButton } from "../ui/button";
import {
  Menu,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuTrigger,
} from "../ui/menu";

/** Agents belong to an environment, independently of the project settings scope. */
export function AgentEnvironmentSelector({
  environmentId,
  onChange,
}: {
  environmentId: EnvironmentId | null;
  onChange: (environmentId: EnvironmentId) => void;
}) {
  const { environments } = useEnvironments();
  const selected = environments.find((entry) => entry.environmentId === environmentId);
  return (
    <div className="flex min-w-0 items-center gap-1.5 px-3 text-base text-muted-foreground sm:px-4">
      <span>Agents on</span>
      <Menu>
        <MenuTrigger
          aria-label={`Agent environment: ${selected?.label ?? "Choose environment"}`}
          render={<InlineButton tone="picker" disabled={environments.length === 0} />}
          className="min-w-0 max-w-72"
        >
          <EnvironmentMachineIcon
            aria-hidden
            kind={resolveEnvironmentMachineKind(selected?.serverConfig ?? null)}
            className="size-3.5 shrink-0"
          />
          <span className="min-w-0 truncate">
            {selected?.label ?? (environmentId ? "Unavailable environment" : "Choose environment")}
          </span>
          <ChevronDownIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        </MenuTrigger>
        <MenuPopup align="start">
          <MenuRadioGroup
            value={environmentId ?? ""}
            onValueChange={(value) => {
              const environment = environments.find((entry) => entry.environmentId === value);
              if (environment) onChange(environment.environmentId);
            }}
          >
            {environments.map((entry) => (
              <MenuRadioItem key={entry.environmentId} value={entry.environmentId}>
                <span className="flex min-w-0 items-center gap-2">
                  <EnvironmentMachineIcon
                    aria-hidden
                    kind={resolveEnvironmentMachineKind(entry.serverConfig)}
                    className="size-3.5"
                  />
                  <span className="min-w-0 flex-1 truncate">{entry.label}</span>
                  {entry.connection.phase !== "connected" ? (
                    <span className="text-xs text-muted-foreground">Offline</span>
                  ) : null}
                  <MenuRadioItemIndicator />
                </span>
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuPopup>
      </Menu>
    </div>
  );
}
