import {
  DEFAULT_AGENT_ID,
  DEFAULT_AGENT_NAME,
  AgentRegistry,
  AgentSettings,
  OneChatState,
  ThreadId,
  type AgentDefinition,
  type OneChatConfiguration,
  type OneChatSettings,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type { ServerConfig } from "../config.ts";

export class OneChatError extends Schema.TaggedError<OneChatError>()("OneChatError", {
  cause: Schema.Defect(),
}) {
  override get message() {
    return "Could not save agent settings.";
  }
}

export class AgentMutationError extends Schema.TaggedError<AgentMutationError>()(
  "AgentMutationError",
  {
    reason: Schema.Literals(["default-agent", "not-found"]),
  },
) {
  override get message() {
    return this.reason === "default-agent"
      ? "The default agent cannot be removed."
      : "Agent not found.";
  }
}

export class OneChat extends Context.Service<
  OneChat,
  {
    readonly read: () => Effect.Effect<OneChatConfiguration | null>;
    readonly configure: (
      input: OneChatSettings | null,
    ) => Effect.Effect<OneChatConfiguration | null, OneChatError>;
    readonly listAgents: () => Effect.Effect<ReadonlyArray<AgentDefinition>>;
    readonly configureAgent: (input: AgentSettings) => Effect.Effect<AgentDefinition, OneChatError>;
    readonly resetAgent: (id: string) => Effect.Effect<void, OneChatError | AgentMutationError>;
    readonly removeAgent: (id: string) => Effect.Effect<void, OneChatError | AgentMutationError>;
  }
>()("t3/oneChat/OneChat") {}

const decodeAgentSettings = Schema.decodeUnknownEffect(AgentSettings);
const decodeLegacy = Schema.decodeUnknownEffect(Schema.fromJsonString(OneChatState));
const decodeRegistry = Schema.decodeUnknownEffect(Schema.fromJsonString(AgentRegistry));
const encodeRegistry = Schema.encodeEffect(Schema.fromJsonString(AgentRegistry));

export const layer = (config: ServerConfig["Service"]) =>
  Layer.effect(
    OneChat,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const crypto = yield* Crypto.Crypto;
      const directory = `${config.stateDir}/hub`;
      const file = `${directory}/agents.json`;
      const legacyFile = `${directory}/one-chat.json`;
      yield* fs.makeDirectory(directory, { recursive: true });
      let current: ReadonlyArray<AgentDefinition>;
      if (yield* fs.exists(file)) {
        current = yield* decodeRegistry(yield* fs.readFileString(file));
      } else {
        let configuration = (yield* fs.exists(legacyFile))
          ? yield* decodeLegacy(yield* fs.readFileString(legacyFile))
          : null;
        // Earlier One Chat installations used a user project rather than an agent workspace.
        if (configuration && !configuration.threadId.startsWith("one-chat:v2:")) {
          configuration = {
            ...configuration,
            threadId: ThreadId.make(`one-chat:v2:${yield* crypto.randomUUIDv4}`),
          };
        }
        current = [{ id: DEFAULT_AGENT_ID, name: DEFAULT_AGENT_NAME, configuration }];
        yield* fs.writeFileString(`${file}.tmp`, yield* encodeRegistry(current));
        yield* fs.rename(`${file}.tmp`, file);
      }
      // Preserve the conversation and custom name when migrating the original default's slug.
      if (current.some((agent) => agent.id === "one-chat")) {
        if (current.some((agent) => agent.id === DEFAULT_AGENT_ID)) {
          return yield* new OneChatError({ cause: "Default agent slug is already in use." });
        }
        current = current.map((agent) =>
          agent.id === "one-chat"
            ? {
                ...agent,
                id: DEFAULT_AGENT_ID,
                name: agent.name === "The One Chat" ? DEFAULT_AGENT_NAME : agent.name,
              }
            : agent,
        );
        yield* fs.writeFileString(`${file}.tmp`, yield* encodeRegistry(current));
        yield* fs.rename(`${file}.tmp`, file);
      }
      const lock = yield* Semaphore.make(1);
      const persist = Effect.fn("Agents.persist")(function* (next: ReadonlyArray<AgentDefinition>) {
        yield* fs.writeFileString(`${file}.tmp`, yield* encodeRegistry(next));
        yield* fs.rename(`${file}.tmp`, file);
        current = next;
      });
      const configureAgent = Effect.fn("Agents.configure")(
        function* (input: AgentSettings) {
          const settings = yield* decodeAgentSettings(input);
          const existing = current.find((agent) => agent.id === settings.id);
          const { id, name, ...creationInputs } = settings;
          // Keep creation inputs stable so concurrent clients create the same conversation.
          const configuration =
            existing?.configuration?.environmentId === settings.environmentId
              ? {
                  ...existing.configuration,
                  additionalInstructions: settings.additionalInstructions,
                }
              : {
                  ...creationInputs,
                  threadId: ThreadId.make(`agent:${id}:${yield* crypto.randomUUIDv4}`),
                };
          const next = { id, name: name.trim() || id, configuration };
          yield* persist(
            existing
              ? current.map((agent) => (agent.id === id ? next : agent))
              : [...current, next],
          );
          return next;
        },
        lock.withPermit,
        Effect.mapError((cause) => new OneChatError({ cause })),
      );
      const configure = Effect.fn("OneChat.configure")(function* (input: OneChatSettings | null) {
        if (input !== null)
          return (yield* configureAgent({
            ...input,
            id: DEFAULT_AGENT_ID,
            name: DEFAULT_AGENT_NAME,
          })).configuration;
        yield* resetAgent(DEFAULT_AGENT_ID).pipe(
          Effect.mapError((cause) =>
            cause._tag === "OneChatError" ? cause : new OneChatError({ cause }),
          ),
        );
        return null;
      });
      const resetAgent = Effect.fn("Agents.reset")(function* (id: string) {
        if (!current.some((agent) => agent.id === id))
          return yield* new AgentMutationError({ reason: "not-found" });
        yield* persist(
          current.map((agent) => (agent.id === id ? { ...agent, configuration: null } : agent)),
        ).pipe(Effect.mapError((cause) => new OneChatError({ cause })));
      }, lock.withPermit);
      const removeAgent = Effect.fn("Agents.remove")(function* (id: string) {
        if (id === DEFAULT_AGENT_ID)
          return yield* new AgentMutationError({ reason: "default-agent" });
        if (!current.some((agent) => agent.id === id))
          return yield* new AgentMutationError({ reason: "not-found" });
        // Removing a definition keeps the environment workspace and conversation history intact.
        yield* persist(current.filter((agent) => agent.id !== id)).pipe(
          Effect.mapError((cause) => new OneChatError({ cause })),
        );
      }, lock.withPermit);
      return OneChat.of({
        read: () =>
          Effect.sync(
            () => current.find((agent) => agent.id === DEFAULT_AGENT_ID)?.configuration ?? null,
          ),
        configure,
        resetAgent,
        listAgents: () => Effect.sync(() => current),
        configureAgent,
        removeAgent,
      });
    }),
  );
