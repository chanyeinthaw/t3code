import {
  DEFAULT_AGENT_ID,
  DEFAULT_AGENT_NAME,
  CommandId,
  type AgentDefinition,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { readAgents } from "../agents";
import { useEnvironmentQuery } from "../state/query";
import { environmentShell } from "../state/shell";
import { useThreadShell } from "../state/entities";
import { useEnvironment } from "../state/environments";
import { useEnvironmentScope } from "../state/session";
import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import { projectEnvironment } from "../state/projects";
import { useAtomCommand } from "../state/use-atom-command";
import { threadEnvironment } from "../state/threads";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import AgentConversation from "./agents/AgentConversation";
import { SidebarInset } from "./ui/sidebar";
import { Button } from "./ui/button";
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from "./ui/empty";

export function AgentChatView({ agentId = DEFAULT_AGENT_ID }: { agentId?: string }) {
  const [agent, setAgent] = useState<AgentDefinition | null | undefined>(undefined);
  const configuration = agent?.configuration;
  const name = agent?.name ?? (agentId === DEFAULT_AGENT_ID ? DEFAULT_AGENT_NAME : "Agent");
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const ref = useMemo(
    () =>
      configuration ? scopeThreadRef(configuration.environmentId, configuration.threadId) : null,
    [configuration],
  );
  const thread = useThreadShell(ref);
  const environment = useEnvironment(configuration?.environmentId ?? null);
  const shell = useEnvironmentQuery(
    configuration ? environmentShell.stateAtom(configuration.environmentId) : null,
  );
  const bootstrapComplete = shell.data?.snapshot._tag === "Some";
  const canCreate = useEnvironmentScope(
    configuration?.environmentId ?? null,
    AuthOrchestrationOperateScope,
  );
  const ensureWorkspace = useAtomCommand(projectEnvironment.ensureOneChatWorkspace, {
    reportFailure: false,
  });
  const create = useOrchestrationCommand(threadEnvironment.create, { reportFailure: false });
  useEffect(() => {
    const controller = new AbortController();
    void readAgents(controller.signal)
      .then((config) => {
        if (!controller.signal.aborted) {
          setAgent(config.find((entry) => entry.id === agentId) ?? null);
          setError(null);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setError("Could not load agent.");
      });
    return () => controller.abort();
    // Retry explicitly reloads the hub configuration after a failed request.
    // eslint-disable-next-line react/exhaustive-effect-dependencies
  }, [retry, agentId]);
  useEffect(() => {
    if (
      !configuration ||
      !bootstrapComplete ||
      thread ||
      environment?.connection.phase !== "connected" ||
      !canCreate
    )
      return;
    let active = true;
    void (async () => {
      const workspace = await ensureWorkspace({
        environmentId: configuration.environmentId,
        input: { agentId, additionalInstructions: configuration.additionalInstructions },
      });
      if (workspace._tag === "Failure") return workspace;
      if (!active) return null;
      return create({
        environmentId: configuration.environmentId,
        input: {
          commandId: CommandId.make(`${configuration.threadId}:create`),
          threadId: configuration.threadId,
          projectId: workspace.value.projectId,
          title: name,
          modelSelection: configuration.modelSelection,
          runtimeMode: configuration.runtimeMode,
          interactionMode: "default",
          branch: null,
          worktreePath: null,
        },
      });
    })().then((result) => {
      if (active && result && result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const cause = squashAtomCommandFailure(result);
        setError(cause instanceof Error ? cause.message : "Could not prepare agent.");
      }
    });
    return () => {
      active = false;
    };
  }, [
    configuration,
    agentId,
    name,
    bootstrapComplete,
    thread,
    environment?.connection.phase,
    canCreate,
    create,
    ensureWorkspace,
  ]);
  const status =
    error ??
    (agent === undefined
      ? "Loading…"
      : !configuration
        ? "Choose where this agent runs in Settings > Agents."
        : environment?.connection.phase !== "connected"
          ? "The configured environment is offline or disabled."
          : thread?.deletedAt
            ? "This conversation was deleted. Clear and configure it again in Settings."
            : !canCreate && !thread
              ? "A Standard or Admin client must open this chat once to prepare it."
              : "Preparing conversation…");
  return (
    <SidebarInset className="h-svh min-h-0 overflow-hidden md:h-dvh">
      {configuration && thread && !thread.deletedAt ? (
        <AgentConversation
          agentId={agentId}
          name={name}
          environmentId={configuration.environmentId}
          threadId={configuration.threadId}
          routeKind="server"
        />
      ) : (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>{name}</EmptyTitle>
            <EmptyDescription>{status}</EmptyDescription>
          </EmptyHeader>
          <div className="flex gap-2">
            <Button
              render={
                <Link
                  to="/settings/agents"
                  search={{
                    agent: agentId,
                    ...(configuration ? { machine: configuration.environmentId } : {}),
                  }}
                />
              }
            >
              Settings
            </Button>
            {error ? (
              <Button variant="outline" onClick={() => setRetry((value) => value + 1)}>
                Retry
              </Button>
            ) : null}
          </div>
        </Empty>
      )}
    </SidebarInset>
  );
}
