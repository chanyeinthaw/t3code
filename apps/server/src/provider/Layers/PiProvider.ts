import type { ServerProviderSkill, ServerProviderSlashCommand } from "@pulse/contracts";
import { ProviderDriverKind, type PiSettings, type ServerProviderModel } from "@pulse/contracts";
import { createModelCapabilities } from "@pulse/shared/model";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { ServerSettingsError } from "@pulse/contracts";
import { buildServerProvider, type ServerProviderDraft } from "../providerSnapshot.ts";
import { getAgentDir, loadSkills, type Skill as PiSkill } from "@earendil-works/pi-coding-agent";

const PROVIDER = ProviderDriverKind.make("pi");

const PI_PRESENTATION = {
  displayName: "Pi",
  showInteractionModeToggle: false,
  supportedAccessModes: ["full-access"],
  deferMidTurnUserMessages: true,
} as const;

type PiModelRegistry = {
  getAvailable(): ReadonlyArray<{
    readonly provider: string;
    readonly id: string;
    readonly name?: string;
    readonly reasoning?: boolean;
    readonly input?: ReadonlyArray<string>;
  }>;
  getError?(): string | undefined;
};

function toTitle(input: string): string {
  return input
    .replaceAll("_", " ")
    .replaceAll("-", " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function piModelToServerModel(
  model: PiModelRegistry["getAvailable"] extends () => ReadonlyArray<infer M> ? M : never,
): ServerProviderModel {
  const slug = `${model.provider}/${model.id}`;
  const name = model.name ?? model.id;
  const capabilities = createModelCapabilities({
    optionDescriptors: model.reasoning
      ? [
          {
            id: "thinkingLevel",
            label: "Thinking",
            type: "select" as const,
            options: [
              { id: "off", label: "Off" },
              { id: "minimal", label: "Minimal" },
              { id: "low", label: "Low" },
              { id: "medium", label: "Medium", isDefault: true },
              { id: "high", label: "High" },
            ],
            currentValue: "medium",
          },
        ]
      : [],
  });
  return {
    slug,
    name,
    shortName: name,
    subProvider: toTitle(model.provider),
    isCustom: false,
    capabilities,
  };
}

export const PI_SLASH_COMMANDS: ReadonlyArray<ServerProviderSlashCommand> = [
  {
    name: "reload",
    description: "Reload Pi extensions, skills, prompts, themes, tools, and settings",
  },
  {
    name: "compact",
    description: "Manually compact the session context to reduce token usage",
    input: {
      hint: "Optional instructions for the compaction summary",
    },
  },
];

function trimToUndefined(value: string | null | undefined): string | undefined {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed.length > 0 ? trimmed : undefined;
}

function piSkillScope(skill: PiSkill): string | undefined {
  return trimToUndefined(skill.sourceInfo.scope ?? skill.sourceInfo.source);
}

function piSkillShortDescription(description: string | undefined): string | undefined {
  const trimmed = trimToUndefined(description);
  if (!trimmed) return undefined;
  return trimmed.length > 100 ? trimmed.slice(0, 100).replace(/\s+\S*$/, "") : trimmed;
}

export function piSkillToServerProviderSkill(skill: PiSkill): ServerProviderSkill {
  const description = trimToUndefined(skill.description);
  const scope = piSkillScope(skill);
  const shortDescription = piSkillShortDescription(description);
  return {
    name: skill.name,
    ...(description ? { description } : {}),
    path: skill.filePath,
    ...(scope ? { scope } : {}),
    enabled: !skill.disableModelInvocation,
    displayName: toTitle(skill.name),
    ...(shortDescription ? { shortDescription } : {}),
  };
}

function loadPiSkills(agentDir: string | undefined): ReadonlyArray<ServerProviderSkill> {
  const resolvedAgentDir = agentDir && agentDir.trim().length > 0 ? agentDir : getAgentDir();
  const { skills } = loadSkills({
    cwd: process.cwd(),
    agentDir: resolvedAgentDir,
    skillPaths: [],
    includeDefaults: true,
  });

  return skills.map(piSkillToServerProviderSkill);
}

export function makePendingPiProvider(settings: PiSettings): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
    return buildServerProvider({
      driver: PROVIDER,
      presentation: PI_PRESENTATION,
      enabled: settings.enabled,
      checkedAt,
      models: [],
      skills: loadPiSkills(settings.agentDir),
      slashCommands: PI_SLASH_COMMANDS,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Pi provider is starting.",
      },
    });
  });
}

export function checkPiProviderStatus(input: {
  readonly settings: PiSettings;
  readonly modelRegistry: PiModelRegistry;
}): Effect.Effect<ServerProviderDraft, ServerSettingsError> {
  return Effect.gen(function* () {
    const checkedAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
    const availableModels = input.modelRegistry.getAvailable();
    const loadError = input.modelRegistry.getError?.();
    const models = availableModels.map(piModelToServerModel);
    const hasModels = models.length > 0;
    const skills = loadPiSkills(input.settings.agentDir);
    return buildServerProvider({
      driver: PROVIDER,
      presentation: PI_PRESENTATION,
      enabled: input.settings.enabled,
      checkedAt,
      models,
      skills,
      slashCommands: PI_SLASH_COMMANDS,
      probe: {
        installed: true,
        version: null,
        status: loadError ? "warning" : hasModels ? "ready" : "warning",
        auth: {
          status: hasModels ? "authenticated" : "unauthenticated",
        },
        ...(loadError || !hasModels
          ? {
              message: loadError ?? "No Pi models with configured auth were found.",
            }
          : {}),
      },
    });
  });
}
