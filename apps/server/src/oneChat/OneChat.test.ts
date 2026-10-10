import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, ProviderInstanceId, type OneChatSettings } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as ServerConfig from "../config.ts";
import * as OneChat from "./OneChat.ts";
import { oneChatInstructions, ONE_CHAT_SYSTEM_INSTRUCTIONS } from "./prompt.ts";

const settings: OneChatSettings = {
  environmentId: EnvironmentId.make("worker"),
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
  runtimeMode: "full-access",
  additionalInstructions: "",
};
const configLayer = ServerConfig.layerTest(process.cwd(), { prefix: "pulse-one-chat-" }).pipe(
  Layer.provide(NodeServices.layer),
);

it.effect("persists the conversation across restarts and keeps creation inputs stable", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const use = <A, E>(effect: Effect.Effect<A, E, OneChat.OneChat>) =>
      effect.pipe(Effect.provide(OneChat.layer(config), { local: true }));
    expect(yield* use(Effect.flatMap(OneChat.OneChat, (chat) => chat.read()))).toBeNull();
    const first = yield* use(Effect.flatMap(OneChat.OneChat, (chat) => chat.configure(settings)));
    expect(first?.threadId).toMatch(/^agent:pulse:/);
    expect(yield* use(Effect.flatMap(OneChat.OneChat, (chat) => chat.read()))).toEqual(first);
    expect(
      yield* use(
        Effect.flatMap(OneChat.OneChat, (chat) =>
          chat.configure({ ...settings, runtimeMode: "approval-required" }),
        ),
      ),
    ).toEqual(first);
    const changed = yield* use(
      Effect.flatMap(OneChat.OneChat, (chat) =>
        chat.configure({ ...settings, environmentId: EnvironmentId.make("other") }),
      ),
    );
    expect(changed?.threadId).not.toBe(first?.threadId);
    yield* use(Effect.flatMap(OneChat.OneChat, (chat) => chat.configure(null)));
    expect(yield* use(Effect.flatMap(OneChat.OneChat, (chat) => chat.read()))).toBeNull();
  }).pipe(Effect.provide(Layer.mergeAll(configLayer, NodeServices.layer))),
);

it.effect("concurrent clients reserve one conversation for the same target", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const results = yield* Effect.gen(function* () {
      const chat = yield* OneChat.OneChat;
      return yield* Effect.all([chat.configure(settings), chat.configure(settings)], {
        concurrency: "unbounded",
      });
    }).pipe(Effect.provide(OneChat.layer(config)));
    expect(results[0]).toEqual(results[1]);
  }).pipe(Effect.provide(Layer.mergeAll(configLayer, NodeServices.layer))),
);

it("reserves an empty One Chat block and retains configured instructions", () => {
  expect(ONE_CHAT_SYSTEM_INSTRUCTIONS).toBe("");
  expect(oneChatInstructions("")).toBe("");
  expect(oneChatInstructions("Custom instructions")).toBe("Custom instructions");
});

it.effect("editing instructions retains the conversation and persists the change", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const first = yield* Effect.flatMap(OneChat.OneChat, (chat) => chat.configure(settings)).pipe(
      Effect.provide(OneChat.layer(config), { local: true }),
    );
    const updated = yield* Effect.flatMap(OneChat.OneChat, (chat) =>
      chat.configure({ ...settings, additionalInstructions: "Be concise" }),
    ).pipe(Effect.provide(OneChat.layer(config), { local: true }));
    expect(updated?.threadId).toBe(first?.threadId);
    expect(updated?.additionalInstructions).toBe("Be concise");
  }).pipe(Effect.provide(Layer.mergeAll(configLayer, NodeServices.layer))),
);

it.effect("agents retain independent conversations and instructions across restarts", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const use = <A, E>(effect: Effect.Effect<A, E, OneChat.OneChat>) =>
      effect.pipe(Effect.provide(OneChat.layer(config), { local: true }));
    const first = yield* use(
      Effect.flatMap(OneChat.OneChat, (agents) =>
        agents.configureAgent({
          ...settings,
          id: "research",
          name: "Research",
          additionalInstructions: "Cite sources",
        }),
      ),
    );
    const second = yield* use(
      Effect.flatMap(OneChat.OneChat, (agents) =>
        agents.configureAgent({
          ...settings,
          id: "planner",
          name: "Planner",
          additionalInstructions: "Plan first",
        }),
      ),
    );
    expect(first.configuration?.threadId).not.toBe(second.configuration?.threadId);
    const edited = yield* use(
      Effect.flatMap(OneChat.OneChat, (agents) =>
        agents.configureAgent({
          ...settings,
          id: "research",
          name: "Researcher",
          additionalInstructions: "Check sources",
        }),
      ),
    );
    expect(edited.configuration?.threadId).toBe(first.configuration?.threadId);
    const persisted = yield* use(Effect.flatMap(OneChat.OneChat, (agents) => agents.listAgents()));
    expect(persisted).toContainEqual(edited);
    expect(persisted).toContainEqual(second);
    const moved = yield* use(
      Effect.flatMap(OneChat.OneChat, (agents) =>
        agents.configureAgent({
          ...settings,
          id: "research",
          name: "Researcher",
          environmentId: EnvironmentId.make("other"),
        }),
      ),
    );
    expect(moved.configuration?.threadId).not.toBe(first.configuration?.threadId);
    yield* use(Effect.flatMap(OneChat.OneChat, (agents) => agents.removeAgent("research")));
    expect(yield* use(Effect.flatMap(OneChat.OneChat, (agents) => agents.listAgents()))).toEqual([
      { id: "pulse", name: "Pulse", configuration: null },
      second,
    ]);
    const error = yield* use(
      Effect.flatMap(OneChat.OneChat, (agents) => agents.removeAgent("pulse")),
    ).pipe(Effect.flip);
    expect(error._tag).toBe("AgentMutationError");
    yield* use(Effect.flatMap(OneChat.OneChat, (agents) => agents.resetAgent("planner")));
    const recreated = yield* use(
      Effect.flatMap(OneChat.OneChat, (agents) =>
        agents.configureAgent({ ...settings, id: "planner", name: "Planner" }),
      ),
    );
    expect(recreated.configuration?.threadId).not.toBe(second.configuration?.threadId);
  }).pipe(Effect.provide(Layer.mergeAll(configLayer, NodeServices.layer))),
);

it.effect("migrates existing One Chat without losing its conversation", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const legacy = { ...settings, threadId: "one-chat:v2:existing" };
    yield* fs.makeDirectory(`${config.stateDir}/hub`, { recursive: true });
    yield* fs.writeFileString(`${config.stateDir}/hub/one-chat.json`, JSON.stringify(legacy));
    const agents = yield* Effect.flatMap(OneChat.OneChat, (service) => service.listAgents()).pipe(
      Effect.provide(OneChat.layer(config)),
    );
    expect(agents).toEqual([{ id: "pulse", name: "Pulse", configuration: legacy }]);
  }).pipe(Effect.provide(Layer.mergeAll(configLayer, NodeServices.layer))),
);

it.effect("renames the original default to Pulse while retaining its configuration", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const configuration = { ...settings, threadId: "one-chat:v2:existing" };
    yield* fs.makeDirectory(`${config.stateDir}/hub`, { recursive: true });
    yield* fs.writeFileString(
      `${config.stateDir}/hub/agents.json`,
      JSON.stringify([
        { id: "one-chat", name: "The One Chat", configuration },
        { id: "research", name: "Research", configuration: null },
      ]),
    );
    const agents = yield* Effect.flatMap(OneChat.OneChat, (service) => service.listAgents()).pipe(
      Effect.provide(OneChat.layer(config)),
    );
    expect(agents).toEqual([
      { id: "pulse", name: "Pulse", configuration },
      { id: "research", name: "Research", configuration: null },
    ]);
    expect(JSON.parse(yield* fs.readFileString(`${config.stateDir}/hub/agents.json`))).toEqual(
      agents,
    );
  }).pipe(Effect.provide(Layer.mergeAll(configLayer, NodeServices.layer))),
);

it.effect("migrates the default slug while preserving a custom name and conversation", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const configuration = { ...settings, threadId: "one-chat:v2:existing" };
    yield* fs.makeDirectory(`${config.stateDir}/hub`, { recursive: true });
    yield* fs.writeFileString(
      `${config.stateDir}/hub/agents.json`,
      JSON.stringify([
        { id: "one-chat", name: "My Assistant", configuration },
        { id: "research", name: "Research", configuration: null },
      ]),
    );
    const agents = yield* Effect.flatMap(OneChat.OneChat, (service) => service.listAgents()).pipe(
      Effect.provide(OneChat.layer(config)),
    );
    expect(agents).toEqual([
      { id: "pulse", name: "My Assistant", configuration },
      { id: "research", name: "Research", configuration: null },
    ]);
    expect(JSON.parse(yield* fs.readFileString(`${config.stateDir}/hub/agents.json`))).toEqual(
      agents,
    );
  }).pipe(Effect.provide(Layer.mergeAll(configLayer, NodeServices.layer))),
);
