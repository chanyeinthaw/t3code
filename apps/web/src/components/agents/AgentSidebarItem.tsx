import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useMemo } from "react";
import { useThreadShell } from "../../state/entities";
import { AgentActivityStatus } from "./AgentActivityStatus";
import { type AgentDefinition, resolveEnvironmentMachineKind } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { useEnvironment } from "../../state/environments";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import { AgentAvatar } from "./AgentAvatar";

export function AgentSidebarItem({
  agent,
  isActive,
  onSelect,
}: {
  agent: AgentDefinition;
  isActive: boolean;
  onSelect: () => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: agent.id });
  const ref = useMemo(
    () =>
      agent.configuration
        ? scopeThreadRef(agent.configuration.environmentId, agent.configuration.threadId)
        : null,
    [agent.configuration],
  );
  const thread = useThreadShell(ref);
  const environment = useEnvironment(agent.configuration?.environmentId ?? null);
  const instanceId =
    thread?.modelSelection.instanceId ?? agent.configuration?.modelSelection.instanceId;
  const provider = useMemo(
    () =>
      deriveProviderInstanceEntries(environment?.serverConfig?.providers ?? []).find(
        (entry) => entry.instanceId === instanceId,
      ),
    [environment?.serverConfig?.providers, instanceId],
  );
  return (
    <SidebarMenuItem
      ref={setNodeRef}
      style={{
        transform: CSS.Translate.toString(transform),
        transition,
        zIndex: isDragging ? 10 : undefined,
      }}
    >
      <SidebarMenuButton
        size="lg"
        isActive={isActive}
        aria-label={agent.name}
        tooltip={agent.name}
        render={
          <Link
            ref={setActivatorNodeRef}
            {...attributes}
            {...listeners}
            draggable={false}
            role="link"
            to="/agents/$agentId"
            params={{ agentId: agent.id }}
          />
        }
        onClick={onSelect}
      >
        <span className="relative shrink-0">
          <AgentAvatar />
          <span className="absolute -right-0.5 -bottom-0.5">
            <AgentActivityStatus thread={thread} />
          </span>
        </span>
        <span className="min-w-0 flex-1 truncate text-sm text-sidebar-foreground">
          {agent.name}
        </span>
        <div className="flex shrink-0 items-center gap-2.5 text-muted-foreground">
          {agent.configuration ? (
            <Tooltip>
              <TooltipTrigger render={<span className="flex items-center" />}>
                <EnvironmentMachineIcon
                  kind={resolveEnvironmentMachineKind(environment?.serverConfig ?? null)}
                  className="size-3.5"
                />
              </TooltipTrigger>
              <TooltipPopup>
                {environment?.label ?? "Unavailable environment"}
                {environment?.connection.phase !== "connected" ? " · Offline" : ""}
              </TooltipPopup>
            </Tooltip>
          ) : (
            <span className="text-xs">Not configured</span>
          )}
          {provider ? (
            <Tooltip>
              <TooltipTrigger render={<span className="flex items-center" />}>
                <ProviderInstanceIcon
                  driverKind={provider.driverKind}
                  displayName={provider.displayName}
                  accentColor={provider.accentColor}
                  acpRegistryAgentId={provider.acpRegistryAgentId}
                  acpRegistryIconUrl={provider.acpRegistryIconUrl}
                  iconClassName="size-3.5"
                />
              </TooltipTrigger>
              <TooltipPopup>{provider.displayName}</TooltipPopup>
            </Tooltip>
          ) : null}
        </div>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}
