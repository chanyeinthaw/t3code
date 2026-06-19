import type {
  EnvironmentApi,
  ModelCapabilities,
  ProviderDiscoveryInput,
  ProviderInstanceId,
  ServerProvider,
  ThreadId,
} from "@pulse/contracts";

export interface RuntimeProviderDiscoveryState {
  readonly instanceId: ProviderInstanceId;
  readonly models: ReadonlyArray<ServerProvider["models"][number]>;
  readonly slashCommands: ReadonlyArray<ServerProvider["slashCommands"][number]>;
  readonly skills: ReadonlyArray<ServerProvider["skills"][number]>;
}

export interface DiscoverProviderComposerStateInput {
  readonly instanceId: ProviderInstanceId;
  readonly cwd?: string | undefined;
  readonly threadId?: ThreadId | null | undefined;
}

const EMPTY_MODEL_CAPABILITIES: ModelCapabilities = {};

function toTitle(input: string): string {
  return input
    .replaceAll("_", " ")
    .replaceAll("-", " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

export async function discoverProviderComposerState(
  api: EnvironmentApi,
  input: DiscoverProviderComposerStateInput,
): Promise<RuntimeProviderDiscoveryState> {
  const discoveryInput: ProviderDiscoveryInput = {
    instanceId: input.instanceId,
    ...(input.cwd ? { cwd: input.cwd } : {}),
    ...(input.threadId ? { threadId: input.threadId } : {}),
  };

  const [modelsResult, commandsResult, skillsResult] = await Promise.allSettled([
    api.provider.listModels({ instanceId: input.instanceId }),
    api.provider.listCommands(discoveryInput),
    api.provider.listSkills(discoveryInput),
    api.provider.getComposerCapabilities(discoveryInput),
  ]);

  return {
    instanceId: input.instanceId,
    models:
      modelsResult.status === "fulfilled"
        ? modelsResult.value.models.map((model) => ({
            slug: model.slug,
            name: model.name,
            subProvider: model.upstreamProviderName ?? model.upstreamProviderId,
            isCustom: false,
            capabilities:
              model.supportedReasoningEfforts && model.supportedReasoningEfforts.length > 0
                ? {
                    optionDescriptors: [
                      {
                        id: "thinkingLevel",
                        label: "Reasoning",
                        type: "select" as const,
                        options: model.supportedReasoningEfforts.map((effort) => ({
                          id: effort.value,
                          label: effort.label,
                          ...(effort.description ? { description: effort.description } : {}),
                          ...(effort.value === model.defaultReasoningEffort
                            ? { isDefault: true }
                            : {}),
                        })),
                        ...(model.defaultReasoningEffort
                          ? { currentValue: model.defaultReasoningEffort }
                          : {}),
                      },
                    ],
                  }
                : EMPTY_MODEL_CAPABILITIES,
          }))
        : [],
    slashCommands:
      commandsResult.status === "fulfilled"
        ? commandsResult.value.commands.map((command) => ({
            name: command.name,
            ...(command.description ? { description: command.description } : {}),
            ...(command.input ? { input: command.input } : {}),
          }))
        : [],
    skills:
      skillsResult.status === "fulfilled"
        ? skillsResult.value.skills.map((skill) => {
            const description = skill.description?.trim();
            const shortDescription =
              description && description.length > 100
                ? description.slice(0, 100).replace(/\s+\S*$/, "")
                : description;
            return {
              name: skill.name,
              ...(description ? { description } : {}),
              path: skill.path ?? skill.name,
              ...(skill.scope ? { scope: skill.scope } : {}),
              enabled: skill.enabled ?? true,
              displayName: toTitle(skill.name),
              ...(shortDescription ? { shortDescription } : {}),
            };
          })
        : [],
  };
}

export function mergeProviderDiscoveryIntoSnapshot(
  snapshot: ServerProvider | null,
  discovery: RuntimeProviderDiscoveryState | null,
  selectedInstanceId: ProviderInstanceId,
): ServerProvider | null {
  if (!snapshot) return null;
  if (discovery?.instanceId !== selectedInstanceId) return snapshot;
  return {
    ...snapshot,
    models: discovery.models.length > 0 ? discovery.models : snapshot.models,
    slashCommands:
      discovery.slashCommands.length > 0 ? discovery.slashCommands : snapshot.slashCommands,
    skills: discovery.skills.length > 0 ? discovery.skills : snapshot.skills,
  };
}
