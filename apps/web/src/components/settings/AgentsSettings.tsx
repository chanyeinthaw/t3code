import { projectEnvironment } from "../../state/projects";
import { useAtomCommand } from "../../state/use-atom-command";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import {
  DEFAULT_AGENT_ID,
  DEFAULT_AGENT_NAME,
  EnvironmentId,
  resolveEnvironmentMachineKind,
  type AgentDefinition,
} from "@t3tools/contracts";
import { PlusIcon, BotIcon } from "lucide-react";
import { cn, randomUUID } from "../../lib/utils";
import { ScrollArea } from "../ui/scroll-area";
import { SettingsGroup } from "./SettingsGroup";
import { Badge } from "../ui/badge";
import { AgentEnvironmentSelector } from "./AgentEnvironmentSelector";
import { useEffect, useEffectEvent, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useEnvironments } from "../../state/environments";
import { readAgents, saveAgent, removeAgent, resetAgent } from "../../agents";
import { loadHubSession } from "../../hub";
import { getDefaultServerModel } from "../../providerModels";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

export function AgentsSettings({
  initialAgentId,
  targetEnvironmentId,
}: {
  initialAgentId?: string;
  targetEnvironmentId: EnvironmentId | null;
}) {
  const { environments } = useEnvironments();
  const navigate = useNavigate();
  const scopedEnvironment = environments.find(
    (entry) => entry.environmentId === targetEnvironmentId,
  );
  const scopeSearch = targetEnvironmentId ? { machine: targetEnvironmentId } : {};
  const scopeEnvironmentId = scopedEnvironment?.environmentId;
  const ensureWorkspace = useAtomCommand(projectEnvironment.ensureOneChatWorkspace, {
    reportFailure: false,
  });
  const [additionalInstructions, setAdditionalInstructions] = useState("");
  const [agents, setAgents] = useState<ReadonlyArray<AgentDefinition>>([]);
  const visibleAgents = agents.filter(
    (agent) => !agent.configuration || agent.configuration.environmentId === scopeEnvironmentId,
  );
  const [creating, setCreating] = useState(false);
  const [selectedId, setSelectedId] = useState(DEFAULT_AGENT_ID);
  const [agentId, setAgentId] = useState(DEFAULT_AGENT_ID);
  const [name, setName] = useState(DEFAULT_AGENT_NAME);
  const saved = visibleAgents.find((agent) => agent.id === selectedId);
  const [environmentId, setEnvironmentId] = useState("");
  const [admin, setAdmin] = useState(false);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  function selectAgent(agent?: AgentDefinition) {
    setCreating(!agent);
    setSelectedId(agent?.id ?? "");
    setAgentId(agent?.id ?? randomUUID());
    setName(agent?.name ?? "");
    setAdditionalInstructions(agent?.configuration?.additionalInstructions ?? "");
    setEnvironmentId(agent?.configuration?.environmentId ?? scopeEnvironmentId ?? "");
    setError(null);
  }
  const applyInitialSelection = useEffectEvent(
    (config: ReadonlyArray<AgentDefinition>, scope: EnvironmentId | undefined) => {
      const scopedAgents = config.filter(
        (agent) => !agent.configuration || agent.configuration.environmentId === scope,
      );
      const initial = initialAgentId
        ? scopedAgents.find((agent) => agent.id === initialAgentId)
        : scopedAgents[0];
      setCreating(false);
      setSelectedId(initial?.id ?? "");
      setAgentId(initial?.id ?? "");
      setName(initial?.name ?? DEFAULT_AGENT_NAME);
      setAdditionalInstructions(initial?.configuration?.additionalInstructions ?? "");
      setEnvironmentId(initial?.configuration?.environmentId ?? scope ?? "");
    },
  );
  useEffect(() => {
    let active = true;
    void Promise.all([readAgents(), loadHubSession()])
      .then(([config, session]) => {
        if (!active) return;
        setAgents(config);
        applyInitialSelection(config, scopeEnvironmentId);
        setAdmin(session.role === "admin");
      })
      .catch(() => {
        if (active) setError("Could not load agent settings.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [scopeEnvironmentId]);
  const selectFromUrl = useEffectEvent((id: string | undefined) => {
    const targetId = id ?? visibleAgents[0]?.id;
    if (loading || targetId === selectedId) return;
    const agent = visibleAgents.find((entry) => entry.id === targetId);
    if (agent) selectAgent(agent);
  });
  useEffect(() => {
    selectFromUrl(initialAgentId);
  }, [initialAgentId]);
  // Preserve the user's draft if an optimistic mutation fails.
  function restoreDraft() {
    setCreating(creating);
    setSelectedId(selectedId);
    setAgentId(agentId);
    setName(name);
    setEnvironmentId(environmentId);
    setAdditionalInstructions(additionalInstructions);
  }
  const environment = environments.find((entry) => entry.environmentId === environmentId);
  async function save() {
    if (pending) return;
    setPending(true);
    setError(null);
    const previousAgents = agents;
    try {
      if (!name.trim()) throw new Error("Enter an agent name.");
      if (!environment?.serverConfig) throw new Error("Choose a connected environment.");
      const settings = environment.serverConfig.settings;
      const provider = environment.serverConfig.providers.find((entry) => entry.enabled);
      const modelSelection =
        (saved?.configuration?.environmentId === environmentId
          ? saved.configuration.modelSelection
          : null) ??
        settings.defaultModelSelection ??
        (provider
          ? {
              instanceId: provider.instanceId,
              model: getDefaultServerModel(environment.serverConfig.providers, provider.driver),
            }
          : null);
      if (!modelSelection) throw new Error("Configure a provider on this environment first.");
      const selectedProvider = environment.serverConfig.providers.find(
        (entry) => entry.instanceId === modelSelection.instanceId,
      );
      if (
        additionalInstructions.trim() &&
        (!selectedProvider ||
          !["codex", "claudeAgent", "opencode", "pi"].includes(selectedProvider.driver))
      ) {
        throw new Error(
          "Additional system instructions require Codex, Claude Code, OpenCode, or Pi.",
        );
      }
      const optimistic: AgentDefinition = {
        id: agentId,
        name: name.trim(),
        configuration:
          saved?.configuration?.environmentId === environmentId
            ? { ...saved.configuration, additionalInstructions }
            : null,
      };
      setAgents(
        agents.some((agent) => agent.id === agentId)
          ? agents.map((agent) => (agent.id === agentId ? optimistic : agent))
          : [...agents, optimistic],
      );
      setSelectedId(agentId);
      setCreating(false);
      const workspace = await ensureWorkspace({
        environmentId: environment.environmentId,
        input: { agentId, additionalInstructions },
      });
      if (workspace._tag === "Failure")
        throw new Error("Could not save agent instructions on this environment.");
      const config = await saveAgent({
        id: agentId,
        name: name.trim(),
        environmentId: EnvironmentId.make(environmentId),
        modelSelection,
        runtimeMode: settings.defaultRuntimeMode,
        additionalInstructions,
      });
      setAgents(config);
      setSelectedId(agentId);
      setCreating(false);
      void navigate({
        to: "/settings/agents",
        search: { ...scopeSearch, machine: environmentId, agent: agentId },
      });
    } catch (cause) {
      setAgents(previousAgents);
      restoreDraft();
      setError(cause instanceof Error ? cause.message : "Could not save settings.");
    } finally {
      setPending(false);
    }
  }
  async function clearConfiguration() {
    if (!saved || pending) return;
    setPending(true);
    setError(null);
    const cleared = { ...saved, configuration: null };
    setAgents(agents.map((agent) => (agent.id === saved.id ? cleared : agent)));
    selectAgent(cleared);
    try {
      const next = await resetAgent(saved.id);
      setAgents(next);
      selectAgent(next.find((agent) => agent.id === saved.id));
    } catch {
      setAgents(agents);
      restoreDraft();
      setError("Could not clear agent configuration.");
    } finally {
      setPending(false);
    }
  }
  async function removeSelectedAgent() {
    if (!saved || pending) return;
    setPending(true);
    setError(null);
    const next = agents.filter((agent) => agent.id !== saved.id);
    setAgents(next);
    const replacement = next.find(
      (agent) => !agent.configuration || agent.configuration.environmentId === scopeEnvironmentId,
    );
    selectAgent(replacement);
    try {
      setAgents(await removeAgent(saved.id));
      void navigate({
        to: "/settings/agents",
        search: { ...scopeSearch, ...(replacement ? { agent: replacement.id } : {}) },
      });
    } catch {
      setAgents(agents);
      restoreDraft();
      setError("Could not remove agent.");
    } finally {
      setPending(false);
    }
  }
  return (
    <SettingsPageContainer width="wide" className="@container/agents gap-8">
      <AgentEnvironmentSelector
        environmentId={targetEnvironmentId}
        onChange={(machine) => {
          void navigate({ to: "/settings/agents", search: { machine } });
        }}
      />
      <SettingsSection
        title="Agents"
        variant="plain"
        titleAction={
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label="Add agent"
            disabled={!admin || loading || pending || !scopedEnvironment}
            onClick={() => selectAgent()}
          >
            <PlusIcon />
          </Button>
        }
      >
        <SettingsGroup
          divided={false}
          className="overflow-hidden @min-[48rem]/agents:h-[min(44rem,calc(100dvh-11rem))] @min-[48rem]/agents:min-h-[32rem] @min-[48rem]/agents:grid @min-[48rem]/agents:grid-cols-[17rem_minmax(0,1fr)]"
        >
          <div className="border-b border-border/60 bg-muted/10 @min-[48rem]/agents:flex @min-[48rem]/agents:min-h-0 @min-[48rem]/agents:flex-col @min-[48rem]/agents:border-r @min-[48rem]/agents:border-b-0">
            <ScrollArea
              scrollFade
              chainVerticalScroll
              className="@min-[48rem]/agents:min-h-0 @min-[48rem]/agents:flex-1"
            >
              <div className="divide-y divide-border/50">
                {visibleAgents.map((agent) => (
                  <button
                    key={agent.id}
                    type="button"
                    aria-pressed={!creating && selectedId === agent.id}
                    disabled={pending}
                    onClick={() => {
                      selectAgent(agent);
                      void navigate({
                        to: "/settings/agents",
                        search: { ...scopeSearch, machine: scopeEnvironmentId, agent: agent.id },
                      });
                    }}
                    className={cn(
                      "flex min-h-18 w-full cursor-pointer items-start gap-3 px-3 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:px-4",
                      !creating && selectedId === agent.id ? "bg-muted/45" : "hover:bg-muted/25",
                    )}
                  >
                    <BotIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    <span className="flex min-w-0 flex-1 flex-col gap-1">
                      <span className="flex flex-wrap items-center gap-2 text-sm">
                        {agent.name}
                        {agent.id === DEFAULT_AGENT_ID ? (
                          <Badge variant="secondary">Default</Badge>
                        ) : null}
                      </span>
                      <span className="truncate text-xs text-muted-foreground">
                        {agent.configuration ? scopedEnvironment?.label : "Not configured"}
                      </span>
                    </span>
                  </button>
                ))}
                {admin ? (
                  <button
                    type="button"
                    disabled={loading || pending || !scopedEnvironment}
                    onClick={() => selectAgent()}
                    className="flex w-full cursor-pointer items-center gap-3 px-3 py-3 text-left text-sm text-muted-foreground outline-none hover:bg-muted/25 hover:text-foreground focus-visible:bg-muted/25 sm:px-4"
                  >
                    <PlusIcon className="size-4 shrink-0" />
                    Add agent
                  </button>
                ) : null}
              </div>
            </ScrollArea>
          </div>
          <div className="min-w-0 @min-[48rem]/agents:min-h-0">
            {saved || creating ? (
              <ScrollArea scrollFade chainVerticalScroll className="@min-[48rem]/agents:h-full">
                <div className="space-y-6 p-4">
                  <SettingsSection title={creating ? "New agent" : (saved?.name ?? "Agent")}>
                    <SettingsRow
                      title="Name"
                      control={
                        <div className="w-96 max-w-full">
                          <Input
                            aria-label="Agent name"
                            value={name}
                            maxLength={100}
                            disabled={!admin || loading || pending}
                            onChange={(event) => setName(event.target.value)}
                          />
                        </div>
                      }
                    />
                    <SettingsRow
                      title="Run on"
                      control={
                        <div className="w-96 max-w-full">
                          <Select
                            items={environments.map((entry) => ({
                              value: entry.environmentId,
                              label: entry.label,
                            }))}
                            value={environmentId}
                            disabled={!admin || loading || pending}
                            onValueChange={(value) => {
                              setEnvironmentId(value ?? "");
                            }}
                          >
                            <SelectTrigger>
                              <span className="flex min-w-0 flex-1 items-center gap-2">
                                {environment ? (
                                  <EnvironmentMachineIcon
                                    kind={resolveEnvironmentMachineKind(environment.serverConfig)}
                                  />
                                ) : null}
                                <SelectValue placeholder="Choose environment" />
                              </span>
                            </SelectTrigger>
                            <SelectPopup>
                              {environments.map((entry) => (
                                <SelectItem key={entry.environmentId} value={entry.environmentId}>
                                  <span className="flex min-w-0 items-center gap-2">
                                    <EnvironmentMachineIcon
                                      kind={resolveEnvironmentMachineKind(entry.serverConfig)}
                                    />
                                    <span className="truncate">{entry.label}</span>
                                  </span>
                                </SelectItem>
                              ))}
                            </SelectPopup>
                          </Select>
                        </div>
                      }
                    />
                    <SettingsRow
                      title="Additional instructions"
                      description="Appended to the provider's system instructions. Applies to subsequent turns in Codex, Claude Code, OpenCode, and Pi."
                    >
                      <div className="mt-3 w-full">
                        <Textarea
                          aria-label="Additional instructions"
                          value={additionalInstructions}
                          maxLength={32000}
                          disabled={!admin || loading || pending}
                          onChange={(event) => setAdditionalInstructions(event.target.value)}
                          rows={8}
                        />
                      </div>
                    </SettingsRow>
                    <SettingsRow
                      title="Configuration"
                      description={
                        error ??
                        (loading
                          ? "Loading…"
                          : !admin
                            ? "Hub admin access is required to change these settings."
                            : undefined)
                      }
                      control={
                        <div className="flex flex-wrap gap-2">
                          {saved?.configuration ? (
                            <Button
                              variant="outline"
                              disabled={pending || !admin}
                              onClick={() => void clearConfiguration()}
                            >
                              Clear configuration
                            </Button>
                          ) : null}
                          {saved && saved.id !== DEFAULT_AGENT_ID ? (
                            <Button
                              variant="outline"
                              disabled={pending || !admin}
                              onClick={() => void removeSelectedAgent()}
                            >
                              Remove agent
                            </Button>
                          ) : null}
                          <Button
                            disabled={
                              !admin ||
                              loading ||
                              pending ||
                              !environment ||
                              environment?.connection.phase !== "connected"
                            }
                            onClick={() => void save()}
                          >
                            {pending ? "Saving…" : "Save"}
                          </Button>
                        </div>
                      }
                    />
                  </SettingsSection>
                </div>
              </ScrollArea>
            ) : (
              <div className="p-6 text-sm text-muted-foreground">
                {error ??
                  (loading
                    ? "Loading agents…"
                    : !scopedEnvironment
                      ? "Connect an environment to configure its agents."
                      : initialAgentId
                        ? "This agent is not configured on this environment."
                        : "No agents configured on this environment.")}
              </div>
            )}
          </div>
        </SettingsGroup>
      </SettingsSection>
    </SettingsPageContainer>
  );
}
