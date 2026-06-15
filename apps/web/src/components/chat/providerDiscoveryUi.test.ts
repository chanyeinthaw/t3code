import { describe, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type EnvironmentApi,
  type ServerProvider,
} from "@t3tools/contracts";
import {
  discoverProviderComposerState,
  mergeProviderDiscoveryIntoSnapshot,
} from "./providerDiscoveryUi";

const INSTANCE_ID = ProviderInstanceId.make("pi-main");
const THREAD_ID = ThreadId.make("thread-1");

function makeEnvironmentApi(overrides?: Partial<EnvironmentApi["provider"]>): EnvironmentApi {
  const provider: EnvironmentApi["provider"] = {
    getComposerCapabilities: vi.fn(async () => ({
      instanceId: INSTANCE_ID,
      provider: ProviderDriverKind.make("pi"),
      supportsSkillMentions: true,
      supportsSkillDiscovery: true,
      supportsNativeSlashCommandDiscovery: true,
      supportsPluginMentions: true,
      supportsPluginDiscovery: true,
      supportsRuntimeModelList: true,
      supportsThreadCompaction: true,
      supportsThreadImport: true,
    })),
    listModels: vi.fn(async () => ({
      source: "runtime",
      cached: false,
      models: [
        {
          slug: "openai/gpt-5",
          name: "GPT-5",
          upstreamProviderName: "OpenAI",
          supportedReasoningEfforts: [
            { value: "low", label: "Low" },
            { value: "high", label: "High", description: "More reasoning" },
          ],
          defaultReasoningEffort: "high",
        },
      ],
    })),
    listSkills: vi.fn(async () => ({
      source: "runtime",
      cached: false,
      skills: [
        {
          name: "gh-fix-ci",
          description: "Fix failing CI",
          scope: "user",
          enabled: true,
        },
      ],
    })),
    listCommands: vi.fn(async () => ({
      source: "runtime",
      cached: false,
      commands: [
        { name: "reload", description: "Reload Pi configuration" },
        {
          name: "compact",
          description: "Compact thread",
          input: { hint: "Optional instructions" },
        },
      ],
    })),
    ...overrides,
  };

  return {
    id: EnvironmentId.make("env-1"),
    terminal: {} as EnvironmentApi["terminal"],
    projects: {} as EnvironmentApi["projects"],
    filesystem: {} as EnvironmentApi["filesystem"],
    sourceControl: {} as EnvironmentApi["sourceControl"],
    vcs: {} as EnvironmentApi["vcs"],
    git: {} as EnvironmentApi["git"],
    review: {} as EnvironmentApi["review"],
    provider,
    orchestration: {} as EnvironmentApi["orchestration"],
  } as EnvironmentApi;
}

function makeSnapshot(): ServerProvider {
  return {
    instanceId: INSTANCE_ID,
    driver: ProviderDriverKind.make("pi"),
    displayName: "Pi",
    enabled: true,
    installed: true,
    version: "0.78.1",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-06-11T00:00:00.000Z",
    models: [
      { slug: "snapshot-model", name: "Snapshot Model", isCustom: false, capabilities: null },
    ],
    slashCommands: [{ name: "snapshot-command" }],
    skills: [{ name: "snapshot-skill", path: "/skills/snapshot/SKILL.md", enabled: true }],
  };
}

describe("discoverProviderComposerState", () => {
  it("calls provider discovery APIs with the selected provider instance and maps results for UI use", async () => {
    const api = makeEnvironmentApi();

    const state = await discoverProviderComposerState(api, {
      instanceId: INSTANCE_ID,
      cwd: "/repo/project",
      threadId: THREAD_ID,
    });

    expect(api.provider.listModels).toHaveBeenCalledWith({ instanceId: INSTANCE_ID });
    expect(api.provider.listCommands).toHaveBeenCalledWith({
      instanceId: INSTANCE_ID,
      cwd: "/repo/project",
      threadId: THREAD_ID,
    });
    expect(api.provider.listSkills).toHaveBeenCalledWith({
      instanceId: INSTANCE_ID,
      cwd: "/repo/project",
      threadId: THREAD_ID,
    });
    expect(api.provider.getComposerCapabilities).toHaveBeenCalledWith({
      instanceId: INSTANCE_ID,
      cwd: "/repo/project",
      threadId: THREAD_ID,
    });

    expect(state.models).toEqual([
      {
        slug: "openai/gpt-5",
        name: "GPT-5",
        subProvider: "OpenAI",
        isCustom: false,
        capabilities: {
          optionDescriptors: [
            {
              id: "thinkingLevel",
              label: "Reasoning",
              type: "select",
              options: [
                { id: "low", label: "Low" },
                { id: "high", label: "High", description: "More reasoning", isDefault: true },
              ],
              currentValue: "high",
            },
          ],
        },
      },
    ]);
    expect(state.slashCommands).toEqual([
      { name: "reload", description: "Reload Pi configuration" },
      {
        name: "compact",
        description: "Compact thread",
        input: { hint: "Optional instructions" },
      },
    ]);
    expect(state.skills).toEqual([
      {
        name: "gh-fix-ci",
        description: "Fix failing CI",
        path: "gh-fix-ci",
        scope: "user",
        enabled: true,
        displayName: "Gh Fix Ci",
        shortDescription: "Fix failing CI",
      },
    ]);
  });

  it("keeps partial discovery results when one discovery endpoint fails", async () => {
    const api = makeEnvironmentApi({
      listCommands: vi.fn(async () => {
        throw new Error("commands unavailable");
      }),
    });

    const state = await discoverProviderComposerState(api, { instanceId: INSTANCE_ID });

    expect(state.models.map((model) => model.slug)).toEqual(["openai/gpt-5"]);
    expect(state.skills.map((skill) => skill.name)).toEqual(["gh-fix-ci"]);
    expect(state.slashCommands).toEqual([]);
  });
});

describe("mergeProviderDiscoveryIntoSnapshot", () => {
  it("prefers non-empty runtime discovery lists for the active instance", () => {
    const merged = mergeProviderDiscoveryIntoSnapshot(
      makeSnapshot(),
      {
        instanceId: INSTANCE_ID,
        models: [
          { slug: "runtime-model", name: "Runtime Model", isCustom: false, capabilities: {} },
        ],
        slashCommands: [{ name: "reload" }],
        skills: [{ name: "gh-fix-ci", path: "gh-fix-ci", enabled: true }],
      },
      INSTANCE_ID,
    );

    expect(merged?.models.map((model) => model.slug)).toEqual(["runtime-model"]);
    expect(merged?.slashCommands.map((command) => command.name)).toEqual(["reload"]);
    expect(merged?.skills.map((skill) => skill.name)).toEqual(["gh-fix-ci"]);
  });

  it("ignores discovery data for a different provider instance", () => {
    const snapshot = makeSnapshot();
    const merged = mergeProviderDiscoveryIntoSnapshot(
      snapshot,
      {
        instanceId: ProviderInstanceId.make("pi-other"),
        models: [
          { slug: "runtime-model", name: "Runtime Model", isCustom: false, capabilities: {} },
        ],
        slashCommands: [{ name: "reload" }],
        skills: [{ name: "gh-fix-ci", path: "gh-fix-ci", enabled: true }],
      },
      INSTANCE_ID,
    );

    expect(merged).toBe(snapshot);
  });

  it("falls back to snapshot lists when runtime discovery returns empty lists", () => {
    const merged = mergeProviderDiscoveryIntoSnapshot(
      makeSnapshot(),
      { instanceId: INSTANCE_ID, models: [], slashCommands: [], skills: [] },
      INSTANCE_ID,
    );

    expect(merged?.models.map((model) => model.slug)).toEqual(["snapshot-model"]);
    expect(merged?.slashCommands.map((command) => command.name)).toEqual(["snapshot-command"]);
    expect(merged?.skills.map((skill) => skill.name)).toEqual(["snapshot-skill"]);
  });
});
